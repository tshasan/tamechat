import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { context, SpanStatusCode, trace, type SpanContext } from '@opentelemetry/api';
import { streamText, type ModelMessage } from 'ai';
import { formats, isFormat, type Format } from './format.ts';
import { backendHost, chatModel, type Backend } from './model.ts';
import { promptFor } from './prompts.ts';
import type { Profile } from './subset.ts';
import type { Telemetry } from './telemetry.ts';

export interface ServerConfig {
  backend: Backend;
  profile: Profile;
  hosts: string[];
  staticDir: string;
  telemetry: Telemetry;
}

interface ChatRequest {
  messages: ChatMessage[];
  format: Format;
}

interface PendingTrace {
  context: SpanContext;
  startedAt: number;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const pageCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";
const sandboxCsp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
const maxBody = 1 << 20;
const maxMessages = 200;
const maxPending = 500;
const maxMetricKeys = 40;

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

function hostname(host: string): string {
  const bracketed = /^\[(.*)\](?::\d+)?$/.exec(host);
  if (bracketed) return bracketed[1] ?? '';
  return host.replace(/:\d+$/, '');
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).hostname.toLowerCase() === hostname(req.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`${message}\n`);
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBody) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function parseChat(body: string): ChatRequest | null {
  const parsed = parseJson(body) as { messages?: unknown; format?: unknown } | null;
  const messages = parsed?.messages;
  const format = parsed?.format ?? 'html';
  if (!isFormat(format) || !Array.isArray(messages) || messages.length === 0 || messages.length > maxMessages) return null;
  const out: ChatMessage[] = [];
  for (const m of messages as { role?: unknown; content?: unknown }[]) {
    if ((m?.role !== 'user' && m?.role !== 'assistant') || typeof m.content !== 'string') return null;
    out.push({ role: m.role, content: m.content });
  }
  return { messages: out, format };
}

function isJsonPost(req: IncomingMessage): boolean {
  const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  return req.method === 'POST' && contentType === 'application/json' && sameOrigin(req);
}

export function createApp(config: ServerConfig): Server {
  const hosts = new Set(config.hosts);
  const model = chatModel(config.backend);
  const staticRoot = normalize(config.staticDir);

  const { tracer, enabled: tracing } = config.telemetry;
  const pending = new Map<string, PendingTrace>();
  const models = {
    html: model,
    markdown: chatModel({ ...config.backend, grammar: '' }),
  };

  async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonPost(req)) return fail(res, 403, 'forbidden');
    const body = await readBody(req);
    const chatRequest = body === null ? null : parseChat(body);
    if (!chatRequest) return fail(res, 400, 'bad request');
    const { messages, format } = chatRequest;

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const send = (event: string, value: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const startedAt = Date.now();
    const started = performance.now();
    const span = tracer.startSpan('chat', {
      startTime: startedAt,
      attributes: {
        'tamechat.format': format,
        'tamechat.profile': config.profile,
        'tamechat.grammar': format === 'html' && config.backend.grammar !== '',
        'tamechat.messages': messages.length,
        'gen_ai.request.model': config.backend.model,
      },
    });
    const { traceId } = span.spanContext();
    if (span.isRecording()) {
      pending.set(traceId, { context: span.spanContext(), startedAt });
      if (pending.size > maxPending) pending.delete(pending.keys().next().value as string);
      send('ctrl', { type: 'trace', traceId });
    }

    let firstToken = 0;
    let answerChars = 0;
    let reasoningChars = 0;
    let outputTokens = 0;
    let finishReason = 'unknown';
    let failure = '';

    try {
      const result = streamText({ model: models[format], system: promptFor(format, config.profile), messages: messages as ModelMessage[], abortSignal: abort.signal, maxRetries: 0 });
      for await (const part of result.fullStream) {
        if (part.type === 'reasoning-delta') {
          reasoningChars += part.text.length;
          send('think', part.text);
        } else if (part.type === 'text-delta') {
          firstToken ||= performance.now() - started;
          answerChars += part.text.length;
          send('answer', part.text);
        } else if (part.type === 'finish') {
          outputTokens = part.totalUsage.outputTokens ?? 0;
          finishReason = part.finishReason;
        } else if (part.type === 'error') {
          throw part.error;
        }
      }
      send('ctrl', { type: 'done', outputTokens, finishReason });
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      if (!abort.signal.aborted) send('ctrl', { type: 'error', message: failure });
    }
    span.setAttributes({
      'tamechat.ttft_ms': firstToken,
      'tamechat.answer_chars': answerChars,
      'tamechat.reasoning_chars': reasoningChars,
      'tamechat.aborted': abort.signal.aborted,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.response.finish_reason': finishReason,
    });
    if (failure && !abort.signal.aborted) span.setStatus({ code: SpanStatusCode.ERROR, message: failure });
    span.end(Date.now());
    res.end();
  }

  async function clientTrace(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonPost(req)) return fail(res, 403, 'forbidden');
    const body = await readBody(req);
    const parsed = body === null ? null : (parseJson(body) as { traceId?: unknown; metrics?: unknown } | null);
    const entry = typeof parsed?.traceId === 'string' ? pending.get(parsed.traceId) : undefined;
    const metrics = parsed?.metrics;
    if (!entry || typeof metrics !== 'object' || metrics === null) return fail(res, 404, 'unknown trace');
    pending.delete(parsed?.traceId as string);
    const attributes: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(metrics).slice(0, maxMetricKeys)) {
      if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') attributes[`tamechat.client.${key}`] = value;
    }
    const totalMs = typeof (metrics as { totalMs?: unknown }).totalMs === 'number' ? (metrics as { totalMs: number }).totalMs : 0;
    const span = tracer.startSpan('client.render', { startTime: entry.startedAt, attributes }, trace.setSpanContext(context.active(), entry.context));
    span.end(entry.startedAt + totalMs);
    res.writeHead(204);
    res.end();
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed');
    const file = normalize(join(staticRoot, path === '/' ? 'index.html' : path));
    if (file !== staticRoot && !file.startsWith(staticRoot + sep)) return fail(res, 404, 'not found');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      fail(res, 404, 'not found');
    }
  }

  return createServer(async (req, res) => {
    try {
      if (!hosts.has(hostname(req.headers.host ?? '').toLowerCase())) return fail(res, 403, 'unexpected Host header');
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', pathname === '/sandbox.html' ? sandboxCsp : pageCsp);

      if (pathname === '/api/config') {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json');
        const { backend, profile } = config;
        return void res.end(JSON.stringify({ backend: backendHost(backend.baseURL), model: backend.model, profile, grammar: backend.grammar !== '', formats, tracing }));
      }
      if (pathname === '/api/chat') return await chat(req, res);
      if (pathname === '/api/trace') return await clientTrace(req, res);
      await serveStatic(req, res, decodeURIComponent(pathname));
    } catch (e) {
      if (!res.headersSent) fail(res, 500, e instanceof Error ? e.message : 'error');
      else res.end();
    }
  });
}
