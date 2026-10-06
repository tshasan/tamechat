import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Listening {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

export async function listen(handler: (req: IncomingMessage, body: string, res: import('node:http').ServerResponse) => void): Promise<Listening> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, Buffer.concat(chunks).toString('utf8'), res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export interface Seen {
  auth: string | undefined;
  body: Record<string, unknown>;
}

export async function streamingBackend(chunks: string[], seen: Seen[]): Promise<Listening> {
  return listen((req, body, res) => {
    seen.push({ auth: req.headers.authorization, body: JSON.parse(body) as Record<string, unknown> });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const c of chunks) res.write(c.startsWith(':') ? `${c}\n\n` : `data: ${c}\n\n`);
    res.end();
  });
}

export async function scriptedBackend(answers: string[], finish: string): Promise<Listening> {
  let i = 0;
  return listen((_req, body, res) => {
    const messages = (JSON.parse(body) as { messages: { role: string }[] }).messages;
    if (messages[0]?.role !== 'system' || messages.length !== 2) throw new Error(`unexpected messages: ${body}`);
    const content = answers[i++ % answers.length];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 0, model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
      usage: { prompt_tokens: 1, completion_tokens: 40, total_tokens: 41 },
    }));
  });
}
