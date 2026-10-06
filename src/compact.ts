import type { Subset } from './subset.ts';

const tagPattern = /<\/?[a-zA-Z][a-zA-Z0-9]*[^<>]*>/g;
const tagName = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/;
const suppliedAttrs = / (scope="(?:col|row)"|role="note"|type="button")/g;

interface Segment {
  text: string;
  name: string;
  end: boolean;
}

function split(src: string): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const m of src.matchAll(tagPattern)) {
    if (m.index > pos) out.push({ text: src.slice(pos, m.index), name: '', end: false });
    const parts = tagName.exec(m[0]);
    out.push({ text: m[0], name: (parts?.[2] ?? '').toLowerCase(), end: parts?.[1] === '/' });
    pos = m.index + m[0].length;
  }
  if (pos < src.length) out.push({ text: src.slice(pos), name: '', end: false });
  return out;
}

export function compact(s: Subset, src: string): string {
  const segments = split(src);
  const blockish = (g: Segment | undefined): boolean => g !== undefined && g.name !== '' && !s.phrasing.has(g.name) && g.name !== 'button';
  let out = '';
  let inMenu = false;
  segments.forEach((g, i) => {
    if (g.name === 'menu') inMenu = !g.end;
    if (g.end && g.name === 'li' && inMenu) out += g.text;
    else if (g.name === '' && g.text.trim() === '' && i > 0 && i + 1 < segments.length && blockish(segments[i - 1]) && blockish(segments[i + 1])) return;
    else if (g.end && s.optionalEnd.has(g.name)) return;
    else if (g.name !== '' && !g.end) out += g.text.replace(suppliedAttrs, '');
    else out += g.text;
  });
  return out;
}
