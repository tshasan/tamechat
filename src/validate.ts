import type { Profile, Subset } from './subset.ts';
import { tokenize } from './tokenize.ts';

export interface Options {
  profile: Profile;
  widgets: boolean;
}

export type ViolationKind =
  | 'element'
  | 'attribute'
  | 'value'
  | 'href'
  | 'missing'
  | 'structure'
  | 'text'
  | 'end-tag'
  | 'unbalanced'
  | 'empty-code'
  | 'widget'
  | 'comment';

export interface Violation {
  kind: ViolationKind;
  detail: string;
}

interface Frame {
  name: string;
  unknown: boolean;
  text: boolean;
}

const htmlVoid = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const entities = /&(amp|lt|gt|quot|apos|nbsp|#[0-9]{2,6});/g;

export const strictOptions: Options = { profile: 'strict', widgets: false };

export function describe(v: Violation): string {
  return `${v.kind}: ${v.detail}`;
}

function clip(s: string): string {
  const t = s.trim();
  return t.length > 48 ? `${t.slice(0, 48)}…` : t;
}

function quote(s: string): string {
  return JSON.stringify(s);
}

function impliesClose(s: Subset, open: string, next: string): boolean {
  switch (open) {
    case 'p':
      return s.block.has(next) || ['li', 'dt', 'dd', 'caption', 'thead', 'tbody', 'tr', 'td', 'th', 'summary'].includes(next);
    case 'li':
      return next === 'li';
    case 'td':
    case 'th':
      return ['td', 'th', 'tr', 'thead', 'tbody'].includes(next);
    case 'tr':
      return ['tr', 'thead', 'tbody'].includes(next);
    case 'thead':
    case 'tbody':
      return next === 'thead' || next === 'tbody';
    case 'dt':
    case 'dd':
      return next === 'dt' || next === 'dd';
    default:
      return false;
  }
}

export function validate(s: Subset, src: string, o: Options): Violation[] {
  const violations: Violation[] = [];
  const add = (kind: ViolationKind, detail: string) => violations.push({ kind, detail });
  const stack: Frame[] = [];
  const top = (): Frame | undefined => stack.at(-1);
  const inMenu = (): boolean => top()?.name === 'li' && stack.at(-2)?.name === 'menu';

  const closeImplied = () => {
    const f = stack[stack.length - 1];
    if (!f) return;
    const menuItem = inMenu();
    const omissible = o.profile === 'compact' && s.optionalEnd.has(f.name);
    if (!f.unknown && (menuItem || !omissible)) {
      if (s.optionalEnd.has(f.name)) add('end-tag', `</${f.name}> is omitted; the strict profile requires it`);
      else add('unbalanced', `<${f.name}> is never closed`);
    }
    stack.pop();
  };

  const parentKey = (): string | null => {
    const t = top();
    if (!t) return '#root';
    if (t.unknown) return null;
    return inMenu() ? 'menu>li' : t.name;
  };
  const label = (key: string) => key.replace(/^menu>/, '');

  const checkAttrs = (name: string, attrs: Map<string, string>) => {
    for (const [k, v] of attrs) {
      const re = s.attrs.get(name)?.get(k);
      if (!re) {
        add('attribute', `<${name} ${k}> is not allowed`);
      } else if (!re.test(v)) {
        const kind = name === 'a' && k === 'href' ? 'href' : 'value';
        add(kind, `<${name} ${k}=${quote(clip(v))}> does not match ${s.definition.attributes[name]?.[k]}`);
      }
    }
    for (const required of s.definition.required[o.profile][name] ?? []) {
      if (!attrs.has(required)) add('missing', `<${name}> needs ${required}`);
    }
  };

  const { tokens, truncated } = tokenize(src);
  let widget = false;

  for (const t of tokens) {
    switch (t.kind) {
      case 'comment':
        if (!widget) add('comment', 'comments are not allowed');
        break;

      case 'doctype':
        add('element', 'a doctype is not part of an answer');
        break;

      case 'text': {
        if (widget) break;
        const bad = stack.at(-1)?.name === 'code' && stack.at(-2)?.name === 'pre' ? /[<&]/ : /[<>&]/;
        if (bad.test(t.raw.replace(entities, ''))) add('text', `unescaped < > or & in text: ${quote(clip(t.raw))}`);
        if (t.raw.trim() === '') break;
        const f = top();
        if (f) f.text = true;
        const key = parentKey();
        if (key !== null && !s.allowed.get(key)?.has('#text')) {
          add('text', key === '#root' ? `text must be inside an element: ${quote(clip(t.raw))}` : `text is not allowed directly inside <${label(key)}>: ${quote(clip(t.raw))}`);
        }
        break;
      }

      case 'start': {
        if (widget) break;
        const name = t.name;
        if (name === 'template') {
          if (!t.attrs.has('data-widget')) {
            add('element', '<template> is only allowed with data-widget');
            break;
          }
          if (!o.widgets) add('widget', 'widgets are not allowed in this profile');
          const key = parentKey();
          if (key !== null && !s.allowed.get(key)?.has('template')) add('structure', `a widget is not allowed inside <${label(key)}>`);
          checkAttrs('template', t.attrs);
          widget = true;
          break;
        }
        if (!s.known.has(name)) {
          add('element', `<${name}> is not part of the subset`);
          if (!t.selfClosing && !htmlVoid.has(name)) stack.push({ name, unknown: true, text: false });
          break;
        }
        for (let f = top(); f && !f.unknown && impliesClose(s, f.name, name); f = top()) closeImplied();
        const key = parentKey();
        if (key !== null && !s.allowed.get(key)?.has(name)) add('structure', `<${name}> is not allowed inside <${label(key)}>`);
        checkAttrs(name, t.attrs);
        if (!s.void.has(name)) stack.push({ name, unknown: false, text: false });
        break;
      }

      case 'end': {
        const name = t.name;
        if (widget) {
          if (name === 'template') widget = false;
          break;
        }
        const found = stack.findLastIndex((f) => f.name === name);
        if (found < 0) {
          add('unbalanced', `stray </${name}>`);
          break;
        }
        while (stack.length - 1 > found) {
          const f = stack[stack.length - 1];
          if (f && (f.unknown || !s.optionalEnd.has(f.name))) {
            add('unbalanced', `</${name}> arrives while <${f.name}> is still open`);
            stack.pop();
            continue;
          }
          closeImplied();
        }
        const f = top();
        if (name === 'code' && f && !f.text) add('empty-code', '<code> needs visible text');
        stack.pop();
        break;
      }
    }
  }

  if (truncated) add('structure', 'input ends inside a tag or could not be tokenized');
  while (stack.length > 0) closeImplied();
  return violations;
}
