// Incremental renderer for a streamed HTML answer.
//
// Finished top-level blocks are parsed once and never touched again, so a widget can start as
// soon as its block ends and long answers do not re-parse from the start every frame. Only the
// unfinished last block (the "tail") is re-rendered as text streams in. Where a block ends is
// the scanner's job (scanner.js), which understands both profiles.
import { sanitize } from './sanitize.js';
import { BlockScanner } from './scanner.js';

export class StreamRenderer {
  constructor(el, subset, onBlocks) {
    this.el = el;
    this.subset = subset;
    this.onBlocks = onBlocks;   // called with newly committed element nodes
    this.scanner = new BlockScanner(subset);
    this.html = '';
    this.committed = 0;
    this.tail = [];             // nodes of the current tail render
  }

  push(chunk) { this.html += chunk; }

  // Call once per animation frame while streaming.
  render() {
    for (const b of this.scanner.boundaries(this.html)) {
      if (b > this.committed) {
        this.commit(this.html.slice(this.committed, b));
        this.committed = b;
      }
    }
    this.renderTail(this.html.slice(this.committed));
  }

  // Call when the stream ends: whatever is left becomes final.
  finish() {
    this.renderTail('');
    const rest = this.html.slice(this.committed);
    if (rest.trim()) this.commit(rest);
    this.committed = this.html.length;
  }

  commit(html) {
    const nodes = parse(this.subset, html);
    const anchor = this.tail[0] || null;
    for (const n of nodes) this.el.insertBefore(n, anchor);
    this.onBlocks(nodes.filter((n) => n.nodeType === 1));
  }

  renderTail(html) {
    for (const n of this.tail) n.remove();
    this.tail = html.trim() ? parse(this.subset, html) : [];
    for (const n of this.tail) this.el.append(n);
  }
}

// The browser's own HTML parser does the work, including putting omitted end tags back.
function parse(subset, html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  sanitize(subset, t.content);
  return [...t.content.childNodes];
}
