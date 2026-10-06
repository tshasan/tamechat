import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compact } from '../src/compact.ts';
import { toMarkdown } from '../src/markdown.ts';
import { subset } from '../src/subset.ts';
import { goodDocuments, kinds, readJson } from './helpers.ts';

test('compact: examples', () => {
  const cases: [string, string][] = [
    ['<p>a</p>\n\n<p>b</p>', '<p>a<p>b'],
    ['<ul>\n<li>x</li>\n<li>y</li>\n</ul>', '<ul><li>x<li>y</ul>'],
    ['<table>\n<thead>\n<tr>\n<th scope="col">A</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n</tr>\n</tbody>\n</table>', '<table><thead><tr><th>A<tbody><tr><td>1</table>'],
    ['<aside class="tip" role="note"><p>x</p></aside>', '<aside class="tip"><p>x</aside>'],
    ['<menu><li><button type="button" value="v">V</button></li></menu>', '<menu><li><button value="v">V</button></li></menu>'],
    ['<p><strong>a</strong> <em>b</em></p>', '<p><strong>a</strong> <em>b</em>'],
    ['<p>keep <strong>strong</strong> closed</p>', '<p>keep <strong>strong</strong> closed'],
  ];
  for (const [input, want] of cases) assert.equal(compact(subset, input), want);
});

test('compact: every document keeps its meaning, stays valid, and gets smaller', () => {
  const documents = [...goodDocuments(), ...readJson<string[]>('corpus', 'answers-qwen3.6-35b.json')];
  assert.ok(documents.length > 10);
  documents.forEach((doc, i) => {
    const c = compact(subset, doc);
    assert.deepEqual(kinds(c, { profile: 'compact' }), [], `doc ${i} is not valid compact HTML`);
    assert.equal(toMarkdown(c), toMarkdown(doc), `doc ${i} changed meaning`);
    if (doc.length > 60) assert.ok(c.length < doc.length, `doc ${i} did not shrink`);
  });
});

test('markdown: conversions', () => {
  const cases: [string, string, string][] = [
    ['paragraph and inline marks', '<p>Use <strong>Go</strong> or <em>Rust</em>, see <code>net/http</code> and <a href="https://go.dev">the docs</a>.</p>', 'Use **Go** or *Rust*, see `net/http` and [the docs](https://go.dev).'],
    ['space next to an inline tag survives', '<p><strong>x</strong> and y</p>', '**x** and y'],
    ['headings', '<h2>One</h2>\n<h3>Two</h3>\n<h4>Three</h4>', '## One\n\n### Two\n\n#### Three'],
    ['bullets and numbers', '<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n<ol>\n<li>x</li>\n<li>y</li>\n</ol>', '- a\n- b\n\n1. x\n2. y'],
    ['nested list', '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>', '- a\n  - b\n- c'],
    ['code fence keeps the language', '<pre><code class="language-go">fmt.Println(1)\n</code></pre>', '```go\nfmt.Println(1)\n```'],
    ['table with caption', '<table>\n<caption>Speed</caption>\n<thead>\n<tr>\n<th>Lang</th>\n<th>Speed</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>Go</td>\n<td>fast</td>\n</tr>\n</tbody>\n</table>', '**Speed**\n\n| Lang | Speed |\n| --- | --- |\n| Go | fast |'],
    ['callout', '<aside class="tip" role="note"><p>Pick Go.</p></aside>', '> **Tip:** Pick Go.'],
    ['suggested replies become a list', '<menu><li><button type="button" value="a">One</button></li><li><button type="button" value="b">Two</button></li></menu>', '- One\n- Two'],
    ['blockquote and rule', '<blockquote><p>q</p></blockquote><hr>', '> q\n\n---'],
    ['widgets are dropped', '<p>a</p><template data-widget title="x"><div>hi</div><script>1</script></template><p>b</p>', 'a\n\nb'],
    ['pipes in cells are escaped', '<table><tr><td>a|b</td></tr></table>', '| a\\|b |\n| --- |'],
  ];
  for (const [name, input, want] of cases) assert.equal(toMarkdown(input), want, name);
});

test('markdown: good samples leave no markup behind', () => {
  for (const doc of goodDocuments()) {
    const md = toMarkdown(doc);
    assert.notEqual(md.trim(), '');
    for (const tag of ['<p>', '</p>', '<li>', '<table', '<tr>', '<td>', '<strong>']) assert.ok(!md.includes(tag), `${tag} left in ${md}`);
  }
});
