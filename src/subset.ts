import definitionJson from '../spec/subset.json' with { type: 'json' };

export type Profile = 'strict' | 'compact';

export interface Definition {
  version: string;
  categories: { block: string[]; phrasing: string[] };
  void: string[];
  optionalEnd: string[];
  content: Record<string, string[]>;
  attributes: Record<string, Record<string, string>>;
  required: Record<Profile, Record<string, string[]>>;
  implied: { aside: { role: string }; button: { type: string }; th: { scope: string } };
}

export interface Subset {
  definition: Definition;
  known: Set<string>;
  void: Set<string>;
  optionalEnd: Set<string>;
  block: Set<string>;
  phrasing: Set<string>;
  allowed: Map<string, Set<string>>;
  attrs: Map<string, Map<string, RegExp>>;
}

export function compile(definition: Definition): Subset {
  const void_ = new Set(definition.void);
  const block = new Set(definition.categories.block);
  const phrasing = new Set(definition.categories.phrasing);
  const known = new Set(['template', ...void_, ...block, ...phrasing]);
  for (const key of Object.keys(definition.content)) known.add(key.slice(key.lastIndexOf('>') + 1));
  known.delete('#root');

  const allowed = new Map<string, Set<string>>();
  for (const [key, children] of Object.entries(definition.content)) {
    const set = new Set<string>();
    for (const child of children) {
      if (child === '@block') {
        block.forEach((b) => set.add(b));
        set.add('template');
      } else if (child === '@phrasing') {
        phrasing.forEach((p) => set.add(p));
      } else {
        set.add(child);
      }
    }
    allowed.set(key, set);
  }

  const attrs = new Map<string, Map<string, RegExp>>();
  for (const [element, patterns] of Object.entries(definition.attributes)) {
    attrs.set(element, new Map(Object.entries(patterns).map(([name, pattern]) => [name, new RegExp(pattern)])));
  }

  return { definition, known, void: void_, optionalEnd: new Set(definition.optionalEnd), block, phrasing, allowed, attrs };
}

export const subset: Subset = compile(definitionJson as Definition);

export function elements(s: Subset): string[] {
  return [...s.known].filter((name) => name !== 'template');
}
