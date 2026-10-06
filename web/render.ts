import type { Subset } from '../src/subset.ts';
import { sanitize } from './sanitize.ts';
import { BlockScanner } from './scanner.ts';

export class StreamRenderer {
  private readonly el: HTMLElement;
  private readonly s: Subset;
  private readonly onBlocks: (nodes: Element[]) => void;
  private readonly scanner: BlockScanner;
  private html = '';
  private committed = 0;
  private tail: Node[] = [];

  constructor(el: HTMLElement, s: Subset, onBlocks: (nodes: Element[]) => void) {
    this.el = el;
    this.s = s;
    this.onBlocks = onBlocks;
    this.scanner = new BlockScanner(s);
  }

  push(chunk: string): void {
    this.html += chunk;
  }

  render(): void {
    for (const boundary of this.scanner.boundaries(this.html)) {
      if (boundary > this.committed) {
        this.commit(this.html.slice(this.committed, boundary));
        this.committed = boundary;
      }
    }
    this.renderTail(this.html.slice(this.committed));
  }

  finish(): void {
    this.renderTail('');
    const rest = this.html.slice(this.committed);
    if (rest.trim()) this.commit(rest);
    this.committed = this.html.length;
  }

  private commit(html: string): void {
    const nodes = parse(this.s, html);
    const anchor = this.tail[0] ?? null;
    for (const n of nodes) this.el.insertBefore(n, anchor);
    this.onBlocks(nodes.filter((n): n is Element => n.nodeType === Node.ELEMENT_NODE));
  }

  private renderTail(html: string): void {
    for (const n of this.tail) n.parentNode?.removeChild(n);
    this.tail = html.trim() ? parse(this.s, html) : [];
    for (const n of this.tail) this.el.append(n);
  }
}

export function parse(s: Subset, html: string): Node[] {
  const t = document.createElement('template');
  t.innerHTML = html;
  sanitize(s, t.content);
  return [...t.content.childNodes];
}
