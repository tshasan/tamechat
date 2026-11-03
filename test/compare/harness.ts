import DOMPurify from 'dompurify';
import { subset } from '../../src/subset.ts';
import { StreamRenderer } from '../../web/render.ts';

export type Tool = 'none' | 'escape' | 'purify' | 'native' | 'native-chat' | 'tamechat';

// The three elements setHTML()'s default config removes that a chat answer uses.
export const chatElements = ['details', 'summary', 'button'];

declare global {
  interface Window {
    sanitizeWith: (html: string, tool: Tool) => void;
    compareReady: boolean;
    nativeSupported: boolean;
    tagsOf: (html: string) => string[];
  }
}

const out = () => document.getElementById('out') as HTMLElement;

window.nativeSupported = typeof (Element.prototype as unknown as { setHTML?: unknown }).setHTML === 'function';

window.sanitizeWith = (html, tool) => {
  const el = out();
  el.replaceChildren();
  if (tool === 'none') el.innerHTML = html;
  else if (tool === 'escape') el.textContent = html;
  else if (tool === 'purify') el.innerHTML = DOMPurify.sanitize(html);
  else if (tool === 'native') (el as unknown as { setHTML: (h: string) => void }).setHTML(html);
  else if (tool === 'native-chat') {
    const Sanitizer = (window as unknown as { Sanitizer: new () => { allowElement: (e: string) => void } }).Sanitizer;
    const s = new Sanitizer();
    for (const e of chatElements) s.allowElement(e);
    (el as unknown as { setHTML: (h: string, o: unknown) => void }).setHTML(html, { sanitizer: s });
  } else {
    const renderer = new StreamRenderer(el, subset, () => {});
    renderer.push(html);
    renderer.render();
    renderer.finish();
  }
};

window.tagsOf = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html;
  return [...t.content.querySelectorAll('*')].map((e) => e.localName).sort();
};

window.compareReady = true;
