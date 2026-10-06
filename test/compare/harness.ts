import DOMPurify from 'dompurify';
import { subset } from '../../src/subset.ts';
import { StreamRenderer } from '../../web/render.ts';

export type Tool = 'none' | 'escape' | 'purify' | 'native' | 'tamechat';

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
  else {
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
