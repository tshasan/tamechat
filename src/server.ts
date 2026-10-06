import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { streamText, type ModelMessage } from 'ai';
import { backendHost, chatModel, type Backend } from './model.ts';
import { systemPrompt } from './prompts.ts';
import type { Profile } from './subset.ts';

export interface ServerConfig {
  backend: Backend;
  profile: Profile;
  hosts: string[];
  staticDir: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const pageCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";
const sandboxCsp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
const maxBody = 1 << 20;
const maxMessages = 200;

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

function parseMessages(body: string): ChatMessage[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const messages = (parsed as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > maxMessages) return null;
  const out: ChatMessage[] = [];
  for (const m of messages as { role?: unknown; content?: unknown }[]) {
    if ((m?.role !== 'user' && m?.role !== 'assistant') || typeof m.content !== 'string') return null;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

export function createApp(config: ServerConfig): Server {
  const hosts = new Set(config.hosts);
  const model = chatModel(config.backend);
  const system = systemPrompt[config.profile];
  const staticRoot = normalize(config.staticDir);

  async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (req.method !== 'POST' || contentType !== 'application/json' || !sameOrigin(req)) return fail(res, 403, 'forbidden');
    const body = await readBody(req);
    const messages = body === null ? null : parseMessages(body);
    if (!messages) return fail(res, 400, 'bad request');

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const send = (event: string, value: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    try {
      const result = streamText({ model, system, messages: messages as ModelMessage[], abortSignal: abort.signal, maxRetries: 0 });
      for await (const part of result.fullStream) {
        if (part.type === 'reasoning-delta') send('think', part.text);
        else if (part.type === 'text-delta') send('answer', part.text);
        else if (part.type === 'error') throw part.error;
      }
      send('ctrl', { type: 'done' });
    } catch (e) {
      if (!abort.signal.aborted) send('ctrl', { type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
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
        return void res.end(JSON.stringify({ backend: backendHost(backend.baseURL), model: backend.model, profile, grammar: backend.grammar !== '' }));
      }
      if (pathname === '/api/chat') return await chat(req, res);
      await serveStatic(req, res, decodeURIComponent(pathname));
    } catch (e) {
      if (!res.headersSent) fail(res, 500, e instanceof Error ? e.message : 'error');
      else res.end();
    }
  });
}
