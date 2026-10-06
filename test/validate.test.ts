import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Profile } from '../src/subset.ts';
import { elements, subset } from '../src/subset.ts';
import { type Options, type ViolationKind } from '../src/validate.ts';
import { kinds, profiles, readJson, readText, root } from './helpers.ts';

interface Case {
  name: string;
  src: string;
  options?: Partial<Options>;
  want: ViolationKind[];
  any?: boolean;
}

const compact: Partial<Options> = { profile: 'compact' };
const widgets: Partial<Options> = { widgets: true };

const cases: Case[] = [
  { name: 'paragraph', src: '<p>Hello.</p>', want: [] },
  { name: 'entities', src: '<p>a &lt; b &amp; c &#36;</p>', want: [] },
  { name: 'bare text', src: 'hello', want: ['text'] },
  { name: 'unescaped lt', src: '<p>a < b</p>', want: ['text'] },
  { name: 'bare ampersand', src: '<p>fish & chips</p>', want: ['text'] },
  { name: 'unknown element', src: '<p><img src="x"></p>', want: ['element'] },
  { name: 'script', src: '<p>x</p><script>alert(1)</script>', want: ['element'], any: true },
  { name: 'event handler', src: '<p onclick="x()">hi</p>', want: ['attribute'] },
  { name: 'style attribute', src: '<p style="color:red">x</p>', want: ['attribute'] },
  { name: 'javascript href', src: '<p><a href="javascript:alert(1)">x</a></p>', want: ['href'] },
  { name: 'http href', src: '<p><a href="http://x.example">x</a></p>', want: ['href'] },
  { name: 'https href', src: '<p><a href="https://x.example/a?b=c">x</a></p>', want: [] },
  { name: 'anchor href', src: '<p><a href="#top">x</a></p>', want: [] },
  { name: 'aside kind', src: '<aside class="evil" role="note"><p>x</p></aside>', want: ['value'] },
  { name: 'aside needs role in strict', src: '<aside class="tip"><p>x</p></aside>', want: ['missing'] },
  { name: 'aside without role in compact', src: '<aside class="tip"><p>x</p></aside>', options: compact, want: [] },
  { name: 'h1 not allowed', src: '<h1>T</h1>', want: ['element'] },
  { name: 'empty code', src: '<p><code>\n</code></p>', want: ['empty-code'] },
  { name: 'code with spaces is fine', src: '<p>Run <code> ls -la </code> now.</p>', want: [] },
  { name: 'inline closed', src: '<p>hi <strong>x</strong></p>', want: [] },
  { name: 'unclosed inline', src: '<p>hi <strong>x</p>', want: ['unbalanced'] },
  { name: 'unclosed inline in compact', src: '<p>hi <strong>x</p>', options: compact, want: ['unbalanced'] },
  { name: 'stray end tag', src: '<p>x</p></div>', want: ['unbalanced'] },
  { name: 'li not in a list', src: '<p>x</p><li>y</li>', want: ['structure'] },
  { name: 'p inside ul', src: '<ul><p>x</p></ul>', want: ['structure'], any: true },
  { name: 'text directly in ul', src: '<ul>oops<li>x</li></ul>', want: ['text'] },
  { name: 'widget needs permission', src: '<template data-widget title="x"><script>1</script></template>', want: ['widget'] },
  { name: 'widget allowed', src: '<template data-widget title="x"><script>1</script></template>', options: widgets, want: [] },
  { name: 'template without data-widget', src: '<template><p>x</p></template>', options: widgets, want: ['element'], any: true },
  { name: 'comment', src: '<p>x</p><!-- hi -->', want: ['comment'] },
  { name: 'omitted </p> in strict', src: '<p>a<p>b', want: ['end-tag', 'end-tag'] },
  { name: 'omitted </p> in compact', src: '<p>a<p>b', options: compact, want: [] },
  { name: 'omitted list ends', src: '<ul><li>a<li>b</ul>', options: compact, want: [] },
  { name: 'omitted list ends rejected in strict', src: '<ul><li>a<li>b</ul>', want: ['end-tag', 'end-tag'] },
  { name: 'omitted table ends', src: '<table><thead><tr><th>A<th>B<tbody><tr><td>1<td>2</table>', options: compact, want: [] },
  { name: 'nested list', src: '<ul><li>a<ul><li>b</ul><li>c</ul>', options: compact, want: [] },
  { name: 'p closed by a block', src: '<p>a<ul><li>b</ul>', options: compact, want: [] },
  { name: 'menu keeps </li>', src: '<menu><li><button value="x">X</button></li></menu>', options: compact, want: [] },
  { name: 'menu li end tag is always required', src: '<menu><li><button value="x">X</button></menu>', options: compact, want: ['end-tag'] },
  { name: 'menu button needs a value', src: '<menu><li><button>X</button></li></menu>', options: compact, want: ['missing'] },
  { name: 'button outside a menu', src: '<p><button value="x">X</button></p>', options: compact, want: ['structure'] },
  { name: 'duplicate attribute keeps the first, as a browser does', src: '<p><a href="https://ok.example" href="javascript:x">x</a></p>', want: [] },
  { name: 'attribute named like an object property', src: '<p constructor="x" __proto__="y">x</p>', want: ['attribute', 'attribute'] },
];

for (const c of cases) {
  test(`validate: ${c.name}`, () => {
    const got = kinds(c.src, c.options);
    if (c.any) assert.ok(got.length > 0, 'expected a violation');
    else assert.deepEqual(got, c.want);
  });
}

test('input ending mid-tag is invalid in both profiles', () => {
  for (const src of ["<p>text <img src='https://evil.example/?d=", '<p>ok</p><a href="https://x', '<p>ok</p><']) {
    for (const profile of profiles) assert.ok(kinds(src, { profile }).length > 0, `${profile} accepted ${src}`);
  }
});

interface ManifestCase {
  file: string;
  expect: 'valid' | 'invalid';
  profiles: Profile[];
  widgets?: boolean;
  kinds: ViolationKind[];
}

test('the conformance manifest', () => {
  const manifest = readJson<{ cases: ManifestCase[] }>('conformance', 'manifest.json');
  const listed = new Set<string>();
  for (const c of manifest.cases) {
    listed.add(c.file);
    const src = readText('conformance', 'cases', c.file);
    for (const profile of profiles) {
      const got = kinds(src, { profile, widgets: c.widgets ?? false });
      const valid = c.expect === 'valid' && c.profiles.includes(profile);
      assert.equal(got.length === 0, valid, `${c.file} in ${profile}: ${got.join(',') || 'valid'}`);
    }
    if (c.widgets) assert.ok(kinds(src).length > 0, `${c.file} should be rejected when widgets are off`);
    if (c.expect === 'invalid') assert.deepEqual([...new Set(kinds(src))].sort(), c.kinds, c.file);
  }
  const dir = join(root, 'conformance', 'cases');
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.html')).map((f) => f.split('\\').join('/'));
  assert.deepEqual(files.filter((f) => !listed.has(f)), []);
  assert.equal(files.length, manifest.cases.length);
});

test('the subset definition is internally consistent', () => {
  const { definition, known } = subset;
  for (const el of definition.optionalEnd) assert.ok(known.has(el), `optionalEnd names unknown ${el}`);
  for (const [key, kids] of Object.entries(definition.content)) {
    for (const kid of kids) if (!/^[#@]/.test(kid)) assert.ok(known.has(kid), `content[${key}] allows unknown ${kid}`);
  }
  for (const el of Object.keys(definition.attributes)) assert.ok(known.has(el), `attributes for unknown ${el}`);
});

test('every answer the grammars produced on a live model validates', () => {
  const rows = readText('corpus', 'grammar-runs.jsonl').trim().split('\n').map((l) => JSON.parse(l) as { arm: string; prompt: number; profile: Profile; stop: string; html: string });
  const complete = rows.filter((r) => r.stop !== 'limit');
  assert.ok(complete.length >= 50);
  const rejected = complete.filter((r) => kinds(r.html, { profile: r.profile }).length > 0);
  assert.deepEqual(rejected.map((r) => `${r.arm}/${r.prompt}`), []);
});

test('the prose spec names every element', () => {
  const doc = readText('spec', 'SPEC.md');
  for (const el of elements(subset)) assert.ok(doc.includes(`<${el}>`) || doc.includes(`<${el} `), `SPEC.md never mentions <${el}>`);
});

test('the generated grammars use exactly the elements and attributes of the subset', () => {
  const wantElements = new Set(elements(subset));
  const wantAttributes = new Set(Object.entries(subset.definition.attributes).filter(([el]) => el !== 'template').flatMap(([, a]) => Object.keys(a)));
  for (const name of ['strict.gbnf', 'compact.gbnf']) {
    const lines = readText('grammar', name).split('\n').filter((l) => !l.trim().startsWith('#'));
    const els = new Set(lines.flatMap((l) => [...l.matchAll(/<\/?([a-z][a-z0-9]*)/g)].map((m) => m[1] as string)));
    const attrs = new Set(lines.flatMap((l) => [...l.matchAll(/\s([a-z-]+)=\\"/g)].map((m) => m[1] as string)));
    assert.deepEqual([...els].filter((e) => !wantElements.has(e)), [], `${name}: elements the subset lacks`);
    assert.deepEqual([...wantElements].filter((e) => !els.has(e)), [], `${name}: elements never produced`);
    assert.deepEqual([...attrs].filter((a) => !wantAttributes.has(a)), [], `${name}: attributes the subset lacks`);
    assert.deepEqual([...wantAttributes].filter((a) => !attrs.has(a)), [], `${name}: attributes never produced`);
  }
});


test('tokenizer: raw text elements and entities', () => {
  assert.deepEqual(kinds('<p>x</p><script>if (a<b) {}</script>'), ['element', 'text']);
  assert.deepEqual(kinds('<p>x</p><style>p{}</style>'), ['element']);
  assert.deepEqual(kinds('<p>5 &gt; 3 &amp; &#8212;</p>'), []);
  assert.deepEqual(kinds('<p>&bogus; &</p>'), ['text']);
  assert.deepEqual(kinds('<pre><code>a > b</code></pre>'), []);
  assert.deepEqual(kinds('<pre><code>a < b</code></pre>'), ['text']);
});
