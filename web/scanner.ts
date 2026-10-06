import type { Subset } from '../src/subset.ts';

const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/;
const widgetEnd = '</template>';

export class BlockScanner {
  private readonly s: Subset;
  private pos = 0;
  private depth = 0;
  private topOpen = false;
  private topName = '';
  private inWidget = false;
  private found: number[] = [];

  constructor(s: Subset) {
    this.s = s;
  }

  boundaries(html: string): number[] {
    this.found = [];
    this.scan(html);
    return this.found;
  }

  private mark(offset: number): void {
    this.found.push(offset);
  }

  private scan(html: string): void {
    const { s } = this;
    while (this.pos < html.length) {
      if (this.inWidget) {
        const end = html.indexOf(widgetEnd, this.pos);
        if (end < 0) return;
        this.pos = end + widgetEnd.length;
        this.inWidget = false;
        this.topOpen = false;
        this.mark(this.pos);
        continue;
      }
      const lt = html.indexOf('<', this.pos);
      if (lt < 0) {
        this.pos = html.length;
        return;
      }
      const gt = html.indexOf('>', lt);
      if (gt < 0) {
        this.pos = lt;
        return;
      }
      const m = tag.exec(html.slice(lt, gt + 1));
      this.pos = gt + 1;
      if (!m) continue;
      const closing = m[1] === '/';
      const name = (m[2] ?? '').toLowerCase();
      const counted = !s.optionalEnd.has(name) && !s.void.has(name);

      if (!closing) {
        if (this.depth === 0 && this.topOpen && (s.block.has(name) || name === 'template')) {
          this.mark(lt);
          this.topOpen = false;
        }
        if (name === 'template') {
          this.inWidget = true;
          continue;
        }
        if (this.depth === 0 && (s.block.has(name) || !this.topOpen)) {
          this.topOpen = true;
          this.topName = name;
        }
        if (counted) this.depth++;
        if (s.void.has(name) && this.depth === 0 && this.topName === name) {
          this.mark(this.pos);
          this.topOpen = false;
        }
      } else {
        if (counted) this.depth = Math.max(0, this.depth - 1);
        if (this.depth === 0 && this.topOpen && name === this.topName) {
          this.mark(this.pos);
          this.topOpen = false;
        }
      }
    }
  }
}
