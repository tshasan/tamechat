import { subset } from '../src/subset.ts';
import { serverEvents } from './events.ts';
import { StreamRenderer } from './render.ts';
import { sanitize } from './sanitize.ts';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface Turn {
  question: string;
  html: string;
  article: HTMLElement;
  answer: HTMLElement;
  source: HTMLElement;
  thinking: HTMLDetailsElement;
  thinkingText: HTMLElement;
  meta: HTMLElement;
}

interface ServerConfig {
  backend: string;
  model: string;
  profile: string;
  grammar: boolean;
}

const widgetVariables = ['--fg', '--bg', '--muted', '--accent', '--border', '--font'];
const exportCss = 'body{max-width:42rem;margin:2rem auto;padding:0 1rem;font:16px/1.55 system-ui,sans-serif}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:4px 8px}pre{overflow:auto;background:#f4f4f4;padding:8px}';

function $<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

const log = $('#log');
const input = $<HTMLTextAreaElement>('#input');
const sendButton = $<HTMLButtonElement>('#send');
const stopButton = $<HTMLButtonElement>('#stop');
const composer = $<HTMLFormElement>('#composer');
const history: Message[] = [];
const turns: Turn[] = [];
let cancel: (() => void) | null = null;

function addTurn(question: string): Turn {
  const article = document.createElement('article');
  article.innerHTML = `<p class="user"></p>
    <details class="thinking" open hidden><summary>Thinking</summary><pre></pre></details>
    <div class="answer"></div>
    <pre class="source"></pre>
    <p class="meta"></p>`;
  const part = <T extends HTMLElement>(selector: string) => article.querySelector<T>(selector) as T;
  part('.user').textContent = question;
  log.append(article);
  article.scrollIntoView({ block: 'end' });
  const turn: Turn = {
    question,
    html: '',
    article,
    answer: part('.answer'),
    source: part('.source'),
    thinking: part<HTMLDetailsElement>('.thinking'),
    thinkingText: part('.thinking pre'),
    meta: part('.meta'),
  };
  turns.push(turn);
  return turn;
}

function mountWidget(template: HTMLTemplateElement): void {
  const frame = document.createElement('iframe');
  frame.className = 'widget';
  frame.title = template.getAttribute('title') || 'Widget';
  frame.sandbox.add('allow-scripts');
  frame.src = '/sandbox.html';
  const css = getComputedStyle(document.documentElement);
  const theme = Object.fromEntries(widgetVariables.map((name) => [name, css.getPropertyValue(name).trim()]));
  frame.addEventListener('load', () => frame.contentWindow?.postMessage({ type: 'render', html: template.innerHTML, theme }, '*'), { once: true });
  template.replaceWith(frame);
}

function enhance(nodes: Element[]): void {
  for (const node of nodes) {
    const widgets = node.matches('template[data-widget]') ? [node] : node.querySelectorAll('template[data-widget]');
    for (const w of widgets) mountWidget(w as HTMLTemplateElement);
  }
}

async function send(text: string): Promise<void> {
  if (cancel || !text.trim()) return;
  document.querySelector('#empty')?.remove();
  history.push({ role: 'user', content: text });
  const turn = addTurn(text);
  const controller = new AbortController();
  cancel = () => controller.abort();
  sendButton.hidden = true;
  stopButton.hidden = false;

  let html = '';
  let thought = '';
  let frame = 0;
  let thinkingDone = false;
  const view = new StreamRenderer(turn.answer, subset, enhance);
  const started = performance.now();
  const show = () => {
    turn.html = html;
    turn.source.textContent = html;
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    for await (const { event, data } of serverEvents(res.body)) {
      if (event === 'think') {
        thought += String(data);
        turn.thinking.hidden = false;
        turn.thinkingText.textContent = thought;
      } else if (event === 'answer') {
        if (!thinkingDone) {
          thinkingDone = true;
          turn.thinking.open = false;
        }
        html += String(data);
        view.push(String(data));
        frame ||= requestAnimationFrame(() => {
          frame = 0;
          view.render();
          show();
        });
      } else if (event === 'ctrl' && (data as { type?: string }).type === 'error') {
        throw new Error((data as { message?: string }).message || 'backend error');
      }
    }
    cancelAnimationFrame(frame);
    view.finish();
    show();
    history.push({ role: 'assistant', content: html });
    turn.meta.textContent = `${html.length} characters of HTML in ${((performance.now() - started) / 1000).toFixed(1)} s`;
  } catch (e) {
    cancelAnimationFrame(frame);
    view.finish();
    show();
    if (e instanceof DOMException && e.name === 'AbortError') {
      turn.meta.textContent = 'Stopped';
      if (html) history.push({ role: 'assistant', content: html });
      else history.pop();
    } else {
      turn.meta.textContent = `Error: ${e instanceof Error ? e.message : e}`;
      history.pop();
    }
  } finally {
    cancel = null;
    sendButton.hidden = false;
    stopButton.hidden = true;
  }
}

function exportHtml(): void {
  const doc = document.implementation.createHTMLDocument('tamechat conversation');
  const meta = (attrs: Record<string, string>) => {
    const m = doc.createElement('meta');
    for (const [k, v] of Object.entries(attrs)) m.setAttribute(k, v);
    doc.head.append(m);
  };
  meta({ charset: 'utf-8' });
  meta({ name: 'viewport', content: 'width=device-width, initial-scale=1' });
  meta({ 'http-equiv': 'Content-Security-Policy', content: "default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
  const style = doc.createElement('style');
  style.textContent = exportCss;
  doc.head.append(style);

  const main = doc.createElement('main');
  for (const turn of turns) {
    if (!turn.html) continue;
    const question = doc.createElement('h2');
    question.textContent = turn.question;
    const template = document.createElement('template');
    template.innerHTML = turn.html;
    sanitize(subset, template.content);
    for (const w of template.content.querySelectorAll('template[data-widget]')) w.remove();
    const section = doc.createElement('section');
    section.append(question, doc.importNode(template.content, true));
    main.append(section);
  }
  doc.body.append(main);

  const out = `<!doctype html>\n${doc.documentElement.outerHTML}\n`;
  const link = Object.assign(document.createElement('a'), {
    download: 'tamechat-conversation.html',
    href: URL.createObjectURL(new Blob([out], { type: 'text/html' })),
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

addEventListener('message', (e: MessageEvent<{ type?: string; height?: unknown; text?: unknown }>) => {
  const frame = [...document.querySelectorAll<HTMLIFrameElement>('iframe.widget')].find((f) => f.contentWindow === e.source);
  if (!frame || typeof e.data !== 'object' || e.data === null) return;
  if (e.data.type === 'height') frame.style.height = `${Math.min(Number(e.data.height) || 0, 2000)}px`;
  if (e.data.type === 'prompt' && typeof e.data.text === 'string') void send(e.data.text.slice(0, 2000));
});

log.addEventListener('click', (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>('menu button[value]');
  if (button && !cancel) void send(button.value);
});

document.querySelectorAll<HTMLInputElement>('input[name="view"]').forEach((radio) =>
  radio.addEventListener('change', () => {
    document.body.dataset.view = radio.value;
  }),
);
document.body.dataset.view = 'rendered';

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = '';
  void send(text);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
  if (e.key === 'Escape') cancel?.();
});
stopButton.addEventListener('click', () => cancel?.());
$('#export').addEventListener('click', exportHtml);
$('#new-chat').addEventListener('click', () => {
  cancel?.();
  for (const t of turns.splice(0)) t.article.remove();
  history.length = 0;
});

try {
  const config = (await (await fetch('/api/config')).json()) as ServerConfig;
  $('#backend').textContent = `${config.backend} · ${config.model} · ${config.profile} profile${config.grammar ? ' · grammar-constrained' : ''}`;
} catch (e) {
  $('#backend').textContent = `could not reach the server: ${e instanceof Error ? e.message : e}`;
  sendButton.disabled = true;
}
