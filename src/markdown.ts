import { defaultTreeAdapter, parseFragment, html, type DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

const adapter = defaultTreeAdapter;
const body = adapter.createElement('body', html.NS.HTML, []);

const isElement = (n: Node): n is Element => adapter.isElementNode(n);
const children = (n: Node): Node[] => ('childNodes' in n ? n.childNodes : []);
const attr = (n: Element, key: string): string => n.attrs.find((a) => a.name === key)?.value ?? '';
const inlineOf = (n: Node): string => children(n).map(inlineNode).join('');
const trimmed = (n: Node): string => inlineOf(n).trim();
const elementsNamed = (n: Node, name: string): Element[] => children(n).filter(isElement).filter((c) => c.tagName === name);

function collapse(s: string): string {
  const folded = s.split(/\s+/).filter(Boolean).join(' ');
  if (folded === '') return s === '' ? '' : ' ';
  return (/^\s/.test(s) ? ' ' : '') + folded + (/\s$/.test(s) ? ' ' : '');
}

function textOf(n: Node): string {
  if (adapter.isTextNode(n)) return n.value;
  return children(n).map(textOf).join('');
}

function quote(s: string): string {
  return s.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
}

function inlineNode(n: Node): string {
  if (adapter.isTextNode(n)) return collapse(n.value);
  if (!isElement(n)) return '';
  const inner = inlineOf(n);
  switch (n.tagName) {
    case 'strong':
      return `**${inner}**`;
    case 'em':
      return `*${inner}*`;
    case 'code':
    case 'kbd':
      return `\`${inner}\``;
    case 'del':
      return `~~${inner}~~`;
    case 'a': {
      const href = attr(n, 'href');
      return href ? `[${inner}](${href})` : inner;
    }
    case 'br':
      return '\n';
    default:
      return inner;
  }
}

function list(n: Element, depth: number): string {
  const lines: string[] = [];
  elementsNamed(n, 'li').forEach((li, index) => {
    const marker = n.tagName === 'ol' ? `${index + 1}. ` : '- ';
    let text = '';
    const nested: string[] = [];
    for (const c of children(li)) {
      if (isElement(c) && (c.tagName === 'ul' || c.tagName === 'ol')) nested.push(list(c, depth + 1));
      else text += inlineNode(c);
    }
    lines.push('  '.repeat(depth) + marker + text.trim(), ...nested);
  });
  return lines.join('\n');
}

function table(n: Element): string {
  let caption = '';
  const rows: string[][] = [];
  const walk = (x: Node) => {
    for (const c of children(x).filter(isElement)) {
      if (c.tagName === 'caption') caption = trimmed(c);
      else if (c.tagName === 'thead' || c.tagName === 'tbody' || c.tagName === 'tfoot') walk(c);
      else if (c.tagName === 'tr') {
        const cells = children(c).filter(isElement).filter((cell) => cell.tagName === 'th' || cell.tagName === 'td');
        rows.push(cells.map((cell) => trimmed(cell).replaceAll('|', '\\|')));
      }
    }
  };
  walk(n);
  const [first, ...rest] = rows;
  if (!first) return caption;
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const lines = [line(first), line(first.map(() => '---')), ...rest.map(line)];
  return (caption ? `**${caption}**\n\n` : '') + lines.join('\n');
}

function blocks(nodes: Node[]): string[] {
  return nodes.map(block).filter((s) => s !== '');
}

function block(n: Node): string {
  if (adapter.isTextNode(n)) return collapse(n.value).trim();
  if (!isElement(n)) return '';
  switch (n.tagName) {
    case 'template':
      return '';
    case 'p':
      return trimmed(n);
    case 'h2':
    case 'h3':
    case 'h4':
      return `${'#'.repeat(Number(n.tagName[1]))} ${trimmed(n)}`;
    case 'ul':
    case 'ol':
      return list(n, 0);
    case 'menu':
      return elementsNamed(n, 'li').map((li) => `- ${trimmed(li)}`).join('\n');
    case 'blockquote':
      return quote(blocks(children(n)).join('\n\n'));
    case 'pre': {
      const code = elementsNamed(n, 'code').at(-1) ?? n;
      const lang = code === n ? '' : attr(code, 'class').replace(/^language-/, '');
      return `\`\`\`${lang}\n${textOf(code).replace(/\n+$/, '')}\n\`\`\``;
    }
    case 'hr':
      return '---';
    case 'table':
      return table(n);
    case 'details': {
      const parts: string[] = [];
      for (const c of children(n)) {
        if (isElement(c) && c.tagName === 'summary') parts.unshift(`**${trimmed(c)}**`);
        else if (block(c) !== '') parts.push(block(c));
      }
      return parts.join('\n\n');
    }
    case 'dl':
      return children(n).filter(isElement).flatMap((c) => (c.tagName === 'dt' ? [`**${trimmed(c)}**`] : c.tagName === 'dd' ? [`: ${trimmed(c)}`] : [])).join('\n');
    case 'aside': {
      const label = { note: 'Note', tip: 'Tip', warn: 'Warning' }[attr(n, 'class')] ?? 'Note';
      return quote(`**${label}:** ${blocks(children(n)).join('\n\n')}`);
    }
    default:
      return trimmed(n);
  }
}

export function toMarkdown(src: string): string {
  return blocks(parseFragment(body, src, {}).childNodes).join('\n\n');
}
