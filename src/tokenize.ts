import { Tokenizer, TokenizerMode, type Token, type TokenHandler } from 'parse5';

export type TokenKind = 'text' | 'start' | 'end' | 'comment' | 'doctype';

export interface HtmlToken {
  kind: TokenKind;
  name: string;
  raw: string;
  attrs: Map<string, string>;
  selfClosing: boolean;
}

export interface Tokenized {
  tokens: HtmlToken[];
  truncated: boolean;
}

const rawModes = new Map<string, Tokenizer['state']>([
  ['textarea', TokenizerMode.RCDATA],
  ['title', TokenizerMode.RCDATA],
  ['plaintext', TokenizerMode.PLAINTEXT],
  ['script', TokenizerMode.SCRIPT_DATA],
  ['style', TokenizerMode.RAWTEXT],
  ['iframe', TokenizerMode.RAWTEXT],
  ['xmp', TokenizerMode.RAWTEXT],
  ['noembed', TokenizerMode.RAWTEXT],
  ['noframes', TokenizerMode.RAWTEXT],
  ['noscript', TokenizerMode.RAWTEXT],
]);

const tagStart = /<[a-zA-Z/!?]/;

function token(kind: TokenKind, init: Partial<HtmlToken> = {}): HtmlToken {
  return { kind, name: '', raw: '', attrs: new Map(), selfClosing: false, ...init };
}

export function tokenize(src: string): Tokenized {
  const tokens: HtmlToken[] = [];
  let truncated = false;
  let cursor = 0;

  const text = (end: number) => {
    if (end > cursor) tokens.push(token('text', { raw: src.slice(cursor, end) }));
  };

  const markup = (t: { location: Token.Location | null }, next: HtmlToken) => {
    if (t.location) {
      text(t.location.startOffset);
      cursor = t.location.endOffset;
    }
    tokens.push(next);
  };

  const ignore = () => {};

  const handler: TokenHandler = {
    onCharacter: ignore,
    onWhitespaceCharacter: ignore,
    onNullCharacter: ignore,
    onComment: (t) => markup(t, token('comment')),
    onDoctype: (t) => markup(t, token('doctype')),
    onStartTag(t) {
      const attrs = new Map<string, string>();
      for (const a of t.attrs) if (!attrs.has(a.name)) attrs.set(a.name, a.value);
      markup(t, token('start', { name: t.tagName, attrs, selfClosing: t.selfClosing }));
      const mode = rawModes.get(t.tagName);
      if (mode !== undefined) tokenizer.state = mode;
    },
    onEndTag: (t) => markup(t, token('end', { name: t.tagName })),
    onEof: ignore,
    onParseError(error) {
      if (error.code.startsWith('eof-')) truncated = true;
    },
  };

  const tokenizer = new Tokenizer({ sourceCodeLocationInfo: true }, handler);
  tokenizer.write(src, true);

  const tail = src.slice(cursor);
  text(truncated && tagStart.test(tail) ? cursor + tail.search(tagStart) : src.length);
  return { tokens, truncated };
}
