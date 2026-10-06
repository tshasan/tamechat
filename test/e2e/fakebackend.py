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
SLOW = '<p>' + 'word ' * 200 + '</p>'
SCRIPTS = {"compact": COMPACT, "strict": STRICT, "evil": EVIL, "slow": SLOW}
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
