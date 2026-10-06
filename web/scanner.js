// Finds where one top-level block ends in a growing HTML string, so the renderer can commit
// finished blocks once and only re-parse the unfinished tail.
//
// The strict profile closes every element, so a block ends at its end tag. The compact profile
// leaves out the end tags of <p>, <li>, <td> and friends, so a block can also end because the
// next block starts. Depth is therefore counted only for elements whose end tag is never
// omitted; omitted-end elements are tracked only when they are the top-level block itself.

export class BlockScanner {
  constructor(subset) {
    this.s = subset;
    this.pos = 0;          // how far we have scanned
    this.committed = 0;    // end of the last finished block
    this.depth = 0;        // open elements whose end tag is always written
    this.topOpen = false;  // a top-level block has started and not yet ended
    this.topName = '';
    this.inTemplate = false;
    this.found = [];       // boundaries reached since the last call, in order
  }

  mark(offset) {
    this.committed = offset;
    this.found.push(offset);
  }

  // Scans the new part of html and returns the offsets where finished blocks end, in order. One
  // step can finish two blocks (a <p> left open, then a <hr> that is complete at once), so this
  // returns a list: the grouping then does not depend on how the stream was chunked.
  boundaries(html) {
    const { s } = this;
    this.found = [];
    this.scan(html, s);
    return this.found;
  }

  scan(html, s) {
    while (this.pos < html.length) {
      if (this.inTemplate) {
        // A widget's contents are opaque (scripts may contain "<"): jump to its end tag.
        const end = html.indexOf('</template>', this.pos);
        if (end < 0) return;
        this.pos = end + '</template>'.length;
        this.inTemplate = false;
        this.topOpen = false;
        this.mark(this.pos);
        continue;
      }
      const lt = html.indexOf('<', this.pos);
      if (lt < 0) { this.pos = html.length; break; }
      const gt = html.indexOf('>', lt);
      if (gt < 0) { this.pos = lt; break; }  // tag not finished yet
      const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(lt, gt + 1));
      this.pos = gt + 1;
      if (!m) continue;
      const close = m[1] === '/', name = m[2].toLowerCase();
      const counted = !s.optionalEnd.has(name) && !s.void.has(name);

      if (!close) {
        // A block starting at the top level ends the previous one if that one was left open.
        if (this.depth === 0 && this.topOpen && (s.block.has(name) || name === 'template')) {
          this.mark(lt);
          this.topOpen = false;
        }
        if (name === 'template') { this.inTemplate = true; continue; }
        if (this.depth === 0 && (s.block.has(name) || this.topOpen === false)) {
          this.topOpen = true;
          this.topName = name;
        }
        if (counted) this.depth++;
        if (s.void.has(name) && this.depth === 0 && this.topName === name) {
          this.mark(this.pos);  // <hr> is a block that is already complete
          this.topOpen = false;
        }
      } else {
        if (counted) this.depth = Math.max(0, this.depth - 1);
        // Only the end of the top-level element itself ends the block. An inline element closing
        // inside an open compact <p> brings the depth back to zero without ending anything.
        if (this.depth === 0 && this.topOpen && name === this.topName) {
          this.mark(this.pos);
          this.topOpen = false;
        }
      }
    }
  }
}
