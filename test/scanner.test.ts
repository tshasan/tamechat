import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subset } from '../src/subset.ts';
import { BlockScanner } from '../web/scanner.ts';

function boundaries(doc: string, chunk: number): number[] {
  const scanner = new BlockScanner(subset);
  const seen: number[] = [];
  for (let i = chunk; i <= doc.length + chunk; i += chunk) seen.push(...scanner.boundaries(doc.slice(0, Math.min(i, doc.length))));
  return seen;
}

function blocksOf(doc: string, chunk: number): string[] {
  const out: string[] = [];
  let prev = 0;
  for (const b of boundaries(doc, chunk)) {
    out.push(doc.slice(prev, b));
    prev = b;
  }
  return out;
}

test('strict blocks end at their end tag, as soon as it arrives', () => {
  const doc = '<p>one</p>\n<p>two <strong>x</strong></p>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>';
  assert.deepEqual(blocksOf(doc, 1).map((s) => s.trim()), ['<p>one</p>', '<p>two <strong>x</strong></p>', '<ul>\n<li>a</li>\n<li>b</li>\n</ul>']);
});

test('compact: a paragraph ends when the next block starts', () => {
  assert.deepEqual(blocksOf('<p>one<p>two<ul><li>a<li>b</ul><p>last', 1), ['<p>one', '<p>two', '<ul><li>a<li>b</ul>']);
});

test('compact table: omitted row and cell ends do not confuse the depth', () => {
  const doc = '<table><caption>T</caption><thead><tr><th>A<th>B<tbody><tr><td>1<td>2<tr><td>3<td>4</table><p>after';
  assert.deepEqual(blocksOf(doc, 1), [doc.slice(0, doc.indexOf('<p>after'))]);
});

test('inline tags inside an open compact paragraph do not split it', () => {
  assert.deepEqual(blocksOf('<p>a <strong>b</strong> and <code>c</code><br>d<p>next', 1), ['<p>a <strong>b</strong> and <code>c</code><br>d']);
});

test('the result does not depend on how the stream is chunked', () => {
  const doc = '<p>x<ul><li>a<ul><li>b</ul><li>c</ul><aside class="tip"><p>y</aside><hr><pre><code>1 > 0</code></pre><p>end';
  const reference = blocksOf(doc, 1);
  for (const n of [2, 3, 5, 7, 13, 1000]) assert.deepEqual(blocksOf(doc, n), reference, `chunk size ${n}`);
});

test('a widget is one block, and its script may contain "<"', () => {
  const widget = '<template data-widget title="w"><script>if (a < b) {}</script></template>';
  assert.deepEqual(blocksOf(`<p>before</p>${widget}<p>after</p>`, 1), ['<p>before</p>', widget, '<p>after</p>']);
});

test('an unfinished tag is never committed', () => {
  assert.deepEqual(new BlockScanner(subset).boundaries('<p>done</p><p cla'), ['<p>done</p>'.length]);
});

test('a lone <hr> is a finished block', () => {
  assert.deepEqual(blocksOf('<p>a<hr><p>b', 1), ['<p>a', '<hr>']);
});
