import DOMPurify from 'dompurify';
import { subset } from '../../src/subset.ts';
import { StreamRenderer } from '../../web/render.ts';

// What one sanitizer did to one answer, compared with the browser's own parse of the raw answer
// (what the model wrote, before anyone removed anything).
export interface Outcome {
  textKept: boolean;
  tagsKept: boolean;
  dropped: string[];
  hash: string;
}

export interface Measured {
  ref: { tags: number; hash: string };
  tamechat: Outcome;
  streamed: { equal: boolean; hash: string };
  purify: Outcome;
  native: Outcome | null;
}

declare global {
  interface Window {
    measure: (html: string, chunk: number) => Promise<Measured>;
    renderReady: boolean;
  }
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function tagsIn(root: ParentNode): string[] {
  return [...root.querySelectorAll('*')].map((e) => e.localName).sort();
}

// Multiset difference: tags the model wrote that the output no longer has.
function droppedTags(want: string[], got: string[]): string[] {
  const left = new Map<string, number>();
  for (const t of got) left.set(t, (left.get(t) ?? 0) + 1);
  const out: string[] = [];
  for (const t of want) {
    const n = left.get(t) ?? 0;
    if (n > 0) left.set(t, n - 1);
    else out.push(t);
  }
  return [...new Set(out)].sort();
}

async function sha(s: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(bytes)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fresh(): HTMLElement {
  const el = document.createElement('div');
  document.body.replaceChildren(el);
  return el;
}

async function outcome(el: HTMLElement, wantText: string, wantTags: string[]): Promise<Outcome> {
  const tags = tagsIn(el);
  return {
    textKept: norm(el.textContent ?? '') === wantText,
    tagsKept: tags.join(',') === wantTags.join(','),
    dropped: droppedTags(wantTags, tags),
    hash: await sha(el.innerHTML),
  };
}

function tamechat(el: HTMLElement, html: string, chunk: number): void {
  const r = new StreamRenderer(el, subset, () => {});
  if (chunk <= 0) {
    r.push(html);
    r.render();
  } else {
    // Code points, not UTF-16 units, so a chunk never splits a character the way a tokenizer wouldn't.
    const chars = [...html];
    for (let i = 0; i < chars.length; i += chunk) {
      r.push(chars.slice(i, i + chunk).join(''));
      r.render();
    }
  }
  r.finish();
}

const hasNative = typeof (Element.prototype as unknown as { setHTML?: unknown }).setHTML === 'function';

window.measure = async (html, chunk) => {
  const probe = document.createElement('template');
  probe.innerHTML = html;
  const wantText = norm(probe.content.textContent ?? '');
  const wantTags = tagsIn(probe.content);
  const ref = { tags: wantTags.length, hash: await sha(probe.innerHTML) };

  let el = fresh();
  tamechat(el, html, 0);
  const whole = await outcome(el, wantText, wantTags);

  el = fresh();
  tamechat(el, html, chunk);
  const streamedHash = await sha(el.innerHTML);

  el = fresh();
  el.innerHTML = DOMPurify.sanitize(html);
  const purify = await outcome(el, wantText, wantTags);

  let native: Outcome | null = null;
  if (hasNative) {
    el = fresh();
    (el as unknown as { setHTML: (h: string) => void }).setHTML(html);
    native = await outcome(el, wantText, wantTags);
  }
  document.body.replaceChildren();
  return { ref, tamechat: whole, streamed: { equal: streamedHash === whole.hash, hash: streamedHash }, purify, native };
};

window.renderReady = true;
