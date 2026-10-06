// A small chat client for answers written in the HTML subset.
//
// It talks to /api/chat (Server-Sent Events), renders the answer as it streams, and can show the
// same answer as source or restyled by any classless stylesheet. Nothing here knows which model
// or vendor is behind the server: it only knows the subset.
import { loadSubset } from './subset.js';
import { StreamRenderer } from './render.js';
import { sanitize } from './sanitize.js';

const $ = (s) => document.querySelector(s);
const log = $('#log'), input = $('#input'), sendBtn = $('#send'), stopBtn = $('#stop');
const history = [];          // [{role, content}], assistant content is the answer's HTML
const turns = [];
let subset, current = null, theme = 'default';

const THEMES = {
  default: ['Chat default', null],
  none: ['No stylesheet', ''],
  simple: ['Simple.css', '/themes/simple.css'],
  water: ['Water.css', '/themes/water.css'],
  mvp: ['MVP.css', '/themes/mvp.css'],
  pico: ['Pico (classless)', '/themes/pico.css'],
  sakura: ['Sakura', '/themes/sakura.css'],
};

// ---------------------------------------------------------------- sending

async function send(text) {
  if (current || !text.trim()) return;
  $('#empty')?.remove();
  history.push({ role: 'user', content: text });
  const turn = addTurn(text);
  const ctl = new AbortController();
  current = { cancel: () => ctl.abort() };
  sendBtn.hidden = true; stopBtn.hidden = false;

  let html = '', thought = '', frame = 0, thinkingDone = false;
  const view = new StreamRenderer(turn.answer, subset, enhance);
  const t0 = performance.now();
  const paint = () => { frame = 0; view.render(); turn.html = html; turn.source.textContent = html; if (theme !== 'default') paintFrame(turn); };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frameText = buf.slice(0, i); buf = buf.slice(i + 2);
        let event = 'message', data = '';
        for (const line of frameText.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        const v = JSON.parse(data);
        if (event === 'think') {
          thought += v; turn.thinking.hidden = false; turn.thinkingText.textContent = thought;
        } else if (event === 'answer') {
          if (!thinkingDone) { thinkingDone = true; turn.thinking.open = false; }
          html += v; view.push(v);
          if (!frame) frame = requestAnimationFrame(paint);
        } else if (event === 'ctrl' && v.type === 'error') {
          throw new Error(v.message || 'backend error');
        }
      }
    }
    cancelAnimationFrame(frame);
    view.finish(); turn.html = html; turn.source.textContent = html;
    if (theme !== 'default') paintFrame(turn);
    history.push({ role: 'assistant', content: html });
    turn.meta.textContent = `${html.length} characters of HTML in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
  } catch (e) {
    cancelAnimationFrame(frame);
    view.finish(); turn.html = html; turn.source.textContent = html;
    if (e.name === 'AbortError') { turn.meta.textContent = 'Stopped'; if (html) history.push({ role: 'assistant', content: html }); else history.pop(); }
    else { turn.meta.textContent = `Error: ${e.message}`; history.pop(); }
  } finally {
    current = null; sendBtn.hidden = false; stopBtn.hidden = true;
  }
}

// ---------------------------------------------------------------- turns

function addTurn(text) {
  const art = document.createElement('article');
  art.innerHTML = `<p class="user"></p>
    <details class="thinking" open hidden><summary>Thinking</summary><pre></pre></details>
    <div class="panes"><div class="rendered"><div class="answer"></div></div><pre class="source"></pre></div>
    <p class="meta"></p>`;
  art.querySelector('.user').textContent = text;
  log.append(art);
  art.scrollIntoView({ block: 'end' });
  const turn = { question: text, html: '', frame: null, frameReady: false, article: art,
    answer: art.querySelector('.answer'), rendered: art.querySelector('.rendered'), source: art.querySelector('.source'),
    thinking: art.querySelector('.thinking'), thinkingText: art.querySelector('.thinking pre'), meta: art.querySelector('.meta') };
  turn.answer.hidden = theme !== 'default';
  turns.push(turn);
  return turn;
}

// Runs once for each finished block: start any widgets.
function enhance(nodes) {
  for (const n of nodes) {
    for (const t of [...(n.matches?.('template[data-widget]') ? [n] : []), ...n.querySelectorAll?.('template[data-widget]') ?? []]) mountWidget(t);
  }
}

function mountWidget(t) {
  const f = document.createElement('iframe');
  f.className = 'widget';
  f.title = t.getAttribute('title') || 'Widget';
  // allow-scripts WITHOUT allow-same-origin: an opaque origin with no access to this page, its
  // storage or cookies. sandbox.html is served with a CSP that blocks all network access.
  f.sandbox = 'allow-scripts';
  f.src = '/sandbox.html';
  const css = getComputedStyle(document.documentElement);
  const vars = Object.fromEntries(['--fg', '--bg', '--muted', '--accent', '--border', '--font'].map((k) => [k, css.getPropertyValue(k).trim()]));
  f.addEventListener('load', () => f.contentWindow.postMessage({ type: 'render', html: t.innerHTML, theme: vars }, '*'), { once: true });
  t.replaceWith(f);
}

// A widget may send two kinds of message, and only from our own frames.
addEventListener('message', (e) => {
  const f = [...document.querySelectorAll('iframe.widget')].find((x) => x.contentWindow === e.source);
  if (!f || typeof e.data !== 'object') return;
  if (e.data.type === 'height') f.style.height = Math.min(Number(e.data.height) || 0, 2000) + 'px';
  if (e.data.type === 'prompt' && typeof e.data.text === 'string') send(e.data.text.slice(0, 2000));
});

// Suggested replies: <menu><li><button value="...">
log.addEventListener('click', (e) => {
  const b = e.target.closest('menu button[value]');
  if (b && !current) send(b.value);
});

// ---------------------------------------------------------------- themes
// A theme is a classless stylesheet applied to a copy of the answer inside a script-free iframe,
// so it cannot touch the page. The same HTML, restyled, is the point.

function paintFrame(turn) {
  if (!turn.frame) {
    const f = document.createElement('iframe');
    f.className = 'themed'; f.title = 'Answer, restyled';
    f.sandbox = 'allow-same-origin';  // no scripts: we only write sanitized DOM into it
    f.srcdoc = '<!doctype html><meta charset="utf-8"><base target="_blank"><main></main>';
    f.addEventListener('load', () => {
      const doc = f.contentDocument;
      if (!doc?.querySelector('main')) return;
      turn.frameReady = true;
      doc.documentElement.style.overflow = 'hidden';
      doc.addEventListener('click', (e) => { const b = e.target.closest('menu button[value]'); if (b && !current) send(b.value); });
      new ResizeObserver(() => sizeFrame(f)).observe(doc.querySelector('main'));
      applyTheme(turn); paintFrame(turn);
    });
    turn.frame = f; turn.rendered.append(f);
  }
  turn.frame.hidden = false;
  if (!turn.frameReady) return;
  const doc = turn.frame.contentDocument, t = document.createElement('template');
  t.innerHTML = turn.html;
  sanitize(subset, t.content);
  for (const w of t.content.querySelectorAll('template[data-widget]')) {
    const note = document.createElement('aside');
    note.textContent = `Widget "${w.getAttribute('title') || 'untitled'}" runs only in the default theme.`;
    w.replaceWith(note);
  }
  doc.querySelector('main').replaceChildren(doc.importNode(t.content, true));
  sizeFrame(turn.frame);
}

function applyTheme(turn) {
  const doc = turn.frame?.contentDocument;
  if (!turn.frameReady || !doc) return;
  doc.querySelectorAll('link[data-theme]').forEach((l) => l.remove());
  const href = THEMES[theme][1];
  if (!href) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet'; link.href = href; link.dataset.theme = '';
  link.addEventListener('load', () => sizeFrame(turn.frame));
  doc.head.append(link);
}

// Measure our own <main>, not the body: a theme that sets min-height on the body would otherwise
// make the frame grow forever.
function sizeFrame(f) {
  const doc = f.contentDocument, win = f.contentWindow, main = doc?.querySelector('main');
  if (!main) return;
  const px = (el, p) => parseFloat(win.getComputedStyle(el)[p]) || 0;
  const h = main.getBoundingClientRect().bottom + win.scrollY + px(main, 'marginBottom') + px(doc.body, 'paddingBottom') + px(doc.body, 'marginBottom');
  f.style.height = Math.max(40, Math.min(Math.ceil(h), 20000)) + 'px';
}

function setTheme(name) {
  theme = THEMES[name] ? name : 'default';
  $('#theme').value = theme;
  for (const t of turns) {
    t.answer.hidden = theme !== 'default';
    if (t.frame) t.frame.hidden = theme === 'default';
    if (theme !== 'default') { applyTheme(t); paintFrame(t); }
  }
}

// ---------------------------------------------------------------- export
// The conversation as one static .html file: sanitized answers plus the chosen theme's CSS, no
// script, and a CSP that forbids everything but inline styles. It is the same answer HTML the
// model wrote, so it needs no client code of ours to read, which is the point of the format.

async function exportHTML() {
  const doc = document.implementation.createHTMLDocument('tamechat conversation');
  const meta = (attrs) => { const m = doc.createElement('meta'); Object.entries(attrs).forEach(([k, v]) => m.setAttribute(k, v)); doc.head.append(m); };
  meta({ charset: 'utf-8' });
  meta({ name: 'viewport', content: 'width=device-width, initial-scale=1' });
  meta({ 'http-equiv': 'Content-Security-Policy', content: "default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
  const href = THEMES[theme][1];
  let css = 'body{max-width:42rem;margin:2rem auto;padding:0 1rem;font:16px/1.55 system-ui,sans-serif}';
  if (href) css = await fetch(href).then((r) => r.text()).catch(() => css);
  doc.head.append(Object.assign(doc.createElement('style'), { textContent: css }));
  const main = doc.createElement('main');
  for (const t of turns) {
    if (!t.html) continue;
    const q = doc.createElement('h2'); q.textContent = t.question;
    const tpl = document.createElement('template');
    tpl.innerHTML = t.html;
    sanitize(subset, tpl.content);
    for (const w of tpl.content.querySelectorAll('template[data-widget]')) w.remove();
    const sec = doc.createElement('section');
    sec.append(q, doc.importNode(tpl.content, true));
    main.append(sec);
  }
  doc.body.append(main);
  const out = '<!doctype html>\n' + doc.documentElement.outerHTML + '\n';
  const a = Object.assign(document.createElement('a'), { download: 'tamechat-conversation.html', href: URL.createObjectURL(new Blob([out], { type: 'text/html' })) });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- start

for (const [k, [label]] of Object.entries(THEMES)) $('#theme').add(new Option(label, k));
$('#theme').addEventListener('change', (e) => setTheme(e.target.value));
document.querySelectorAll('input[name="view"]').forEach((r) => r.addEventListener('change', () => { document.body.dataset.view = r.value; }));
document.body.dataset.view = 'rendered';
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); const t = input.value; input.value = ''; send(t); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
  if (e.key === 'Escape' && current) current.cancel();
});
$('#export').addEventListener('click', exportHTML);
stopBtn.addEventListener('click', () => current?.cancel());
$('#new-chat').addEventListener('click', () => { current?.cancel(); turns.splice(0).forEach((t) => t.article.remove()); history.length = 0; });

try {
  const [s, cfg] = await Promise.all([loadSubset(), fetch('/api/config').then((r) => r.json())]);
  subset = s;
  $('#backend').textContent = `${cfg.backend} · ${cfg.model} · ${cfg.profile} profile${cfg.grammar ? ' · grammar-constrained' : ''}`;
} catch (e) {
  $('#backend').textContent = `could not reach the server: ${e.message}`;
  sendBtn.disabled = true;
}
