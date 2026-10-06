export interface Span {
  start: number;
  end: number;
}

interface TokenizeResponse {
  tokens: { piece: string | number[] }[];
}

export class Llama {
  readonly baseURL: string;
  readonly model: string;

  constructor(baseURL: string, model: string) {
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.model = model;
  }

  async tokenize(text: string): Promise<Span[]> {
    const res = await fetch(`${this.baseURL}/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, add_special: false, with_pieces: true, model: this.model }),
    });
    if (!res.ok) throw new Error(`tokenize: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const { tokens } = (await res.json()) as TokenizeResponse;
    const spans: Span[] = [];
    let pos = 0;
    for (const { piece } of tokens) {
      const length = typeof piece === 'string' ? Buffer.byteLength(piece) : piece.length;
      spans.push({ start: pos, end: pos + length });
      pos += length;
    }
    const total = Buffer.byteLength(text);
    if (pos !== total) throw new Error(`tokenize: pieces cover ${pos} bytes of ${total}`);
    return spans;
  }

  async count(text: string): Promise<number> {
    return (await this.tokenize(text)).length;
  }
}
