import { subset } from '../../src/subset.ts';
import { markdownToHtml } from '../../web/markdown.ts';
import { StreamRenderer } from '../../web/render.ts';

declare global {
  interface Window {
    run: (html: string, mode: 'raw' | 'whole' | 'stream' | 'markdown') => void;
    ready: boolean;
  }
}

window.run = (html, mode) => {
  const out = document.getElementById('out') as HTMLElement;
  out.replaceChildren();
  if (mode === 'raw') {
    out.innerHTML = html;
    return;
  }
  if (mode === 'markdown') {
    out.innerHTML = markdownToHtml(html);
    return;
  }
  const renderer = new StreamRenderer(out, subset, () => {});
  if (mode === 'whole') {
    renderer.push(html);
    renderer.render();
  } else {
    for (const ch of html) {
      renderer.push(ch);
      renderer.render();
    }
  }
  renderer.finish();
};
window.ready = true;
