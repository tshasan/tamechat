// Run with: node --test web/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromJSON } from './subset.js';
import { BlockScanner } from './scanner.js';

const subset = fromJSON(JSON.parse(readFileSync(new URL('../spec/subset.json', import.meta.url))));

// Feed a document in chunks of `n` characters; return every distinct boundary reached, in order.
function boundaries(doc, n) {
  const s = new BlockScanner(subset);
  const seen = [];
  for (let i = n; i <= doc.length + n; i += n) {
    for (const b of s.boundaries(doc.slice(0, Math.min(i, doc.length)))) seen.push(b);
  }
  return seen;
}
const blocksOf = (doc, n) => {
  const b = boundaries(doc, n); const out = []; let prev = 0;
  for (const x of b) { out.push(doc.slice(prev, x)); prev = x; }
  return out;
};

test('strict blocks end at their end tag, as soon as it arrives', () => {
  const doc = '<p>one</p>\n<p>two <strong>x</strong></p>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>';
  assert.deepEqual(blocksOf(doc, 1).map((s) => s.trim()),
    ['<p>one</p>', '<p>two <strong>x</strong></p>', '<ul>\n<li>a</li>\n<li>b</li>\n</ul>']);
});

test('compact: a paragraph ends when the next block starts', () => {
  const doc = '<p>one<p>two<ul><li>a<li>b</ul><p>last';
  // the final paragraph never closes, so it stays in the tail until the stream ends
  assert.deepEqual(blocksOf(doc, 1), ['<p>one', '<p>two', '<ul><li>a<li>b</ul>']);
});

test('compact table: omitted row and cell ends do not confuse the depth', () => {
  const doc = '<table><caption>T</caption><thead><tr><th>A<th>B<tbody><tr><td>1<td>2<tr><td>3<td>4</table><p>after';
  assert.deepEqual(blocksOf(doc, 1), [doc.slice(0, doc.indexOf('<p>after'))]);
});

test('inline tags inside an open compact paragraph do not split it', () => {
  const doc = '<p>a <strong>b</strong> and <code>c</code><br>d<p>next';
  assert.deepEqual(blocksOf(doc, 1), ['<p>a <strong>b</strong> and <code>c</code><br>d']);
});

test('the result does not depend on how the stream is chunked', () => {
  const doc = '<p>x<ul><li>a<ul><li>b</ul><li>c</ul><aside class="tip"><p>y</aside><hr><pre><code>1 > 0</code></pre><p>end';
  const ref = blocksOf(doc, 1);
  for (const n of [2, 3, 5, 7, 13, 1000]) assert.deepEqual(blocksOf(doc, n), ref, `chunk size ${n}`);
});

test('a widget is one block, and its script may contain "<"', () => {
  const doc = '<p>before</p><template data-widget title="w"><script>if (a < b) {}</script></template><p>after</p>';
  assert.deepEqual(blocksOf(doc, 1), ['<p>before</p>', '<template data-widget title="w"><script>if (a < b) {}</script></template>', '<p>after</p>']);
});

test('an unfinished tag is never committed', () => {
  const s = new BlockScanner(subset);
  assert.deepEqual(s.boundaries('<p>done</p><p cla'), ['<p>done</p>'.length]);
});

test('a lone <hr> is a finished block', () => {
  assert.deepEqual(blocksOf('<p>a<hr><p>b', 1), ['<p>a', '<hr>']);
});
