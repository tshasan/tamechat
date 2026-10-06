# The HTML subset, version 0.1

A model's answer is a **fragment of HTML** that uses only the elements and attributes below, written in one of two profiles. This page is the whole specification. `subset.json` is the same definition in machine-readable form, and everything in this repository is generated from it or tested against it.

The aim is a UI layer that any model, any backend and any client can share without an SDK: the answer is ordinary HTML text, so a browser can show it with no client code at all.

## Elements

| Kind | Elements |
|---|---|
| Blocks | `<p>` `<h2>` `<h3>` `<h4>` `<ul>` `<ol>` `<blockquote>` `<pre>` `<hr>` `<table>` `<details>` `<dl>` `<aside>` `<menu>` |
| Inside blocks | `<li>` `<caption>` `<thead>` `<tbody>` `<tr>` `<th>` `<td>` `<summary>` `<dt>` `<dd>` |
| Inline | `<strong>` `<em>` `<code>` `<a>` `<br>` `<sub>` `<sup>` `<del>` `<kbd>` `<mark>` `<small>` `<abbr>` |
| Suggested replies | `<button>`, only as `<menu><li><button>…</button></li></menu>` |
| Widgets | `<template data-widget>` (see below) |

Nothing else is allowed: no `<script>`, `<style>`, `<img>`, `<iframe>`, `<form>`, `<input>`, no custom elements, no event-handler or `style` attributes, no comments.

## Attributes

| Element | Attribute | Allowed values |
|---|---|---|
| `a` | `href` | starts with `https://`, `mailto:` or `#` |
| `abbr` | `title` | text without quotes, `&` or newlines |
| `ol` | `start` | 1 to 4 digits |
| `code` | `class` | `language-` followed by 1 to 20 of `a-z 0-9 + # _ -` |
| `th` | `scope`, `colspan`, `rowspan` | `col` or `row`; `1` to `9` |
| `td` | `colspan`, `rowspan` | `1` to `9` |
| `aside` | `class` | `note`, `tip` or `warn` |
| `aside` | `role` | `note` |
| `button` | `type`, `value` | `button`; the message to send, without quotes, `&` or newlines |
| `template` | `data-widget`, `title` | present; a short name |

## Where things may appear (the content model)

- The top level holds blocks. Text must be inside an element.
- `<ul>`, `<ol>` and `<menu>` hold only `<li>`. `<dl>` holds `<dt>` and `<dd>`. `<table>` holds an optional `<caption>`, an optional `<thead>` and a `<tbody>`, and those hold `<tr>`, which holds `<th>` and `<td>`.
- `<td>`, `<th>`, `<p>`, headings and inline elements hold text and inline elements. `<li>` also holds `<ul>`, `<ol>`, `<p>` and `<pre>`.
- `<blockquote>`, `<aside>` and `<details>` hold blocks; `<details>` starts with `<summary>`.
- `<pre>` holds a single `<code>`. Inline `<code>` needs visible text. `<a>` holds text and `<code>`.
- A `<menu>` item is exactly `<li><button …>label</button></li>`.
- Escape `<`, `>` and `&` in text as `&lt;` `&gt;` `&amp;`. A raw `>` is allowed inside `<pre><code>`.

## Profiles

Both profiles are the same document; the second spends fewer tokens.

- **strict**: every end tag is written, and `role="note"` and `type="button"` are present.
- **compact**: the end tags of `<p>` `<li>` `<td>` `<th>` `<tr>` `<thead>` `<tbody>` `<dt>` `<dd>` may be left out (HTML defines how a parser puts them back), whitespace between block tags may be omitted, and `scope`, `role` and `type` may be left off, because the page supplies them. Every other end tag is still required, and `</li>` inside a `<menu>` is always written.

A strict document is also a valid compact document. The page treats them identically.

## Widgets

`<template data-widget title="Name">…</template>` holds HTML, CSS and script. It is **not** rendered in the page. The client moves it into `<iframe sandbox="allow-scripts">` (no `allow-same-origin`) that loads a page served with a Content-Security-Policy that blocks all network access. A widget can send the page two messages: its height, and `sendPrompt(text)` to ask the next question. Nothing inside a widget is validated; the sandbox is the boundary.

## Streaming

A client may render while the answer streams. A top-level block is finished when its own end tag arrives, or, for blocks whose end tag may be omitted, when the next block starts. A widget is finished at `</template>`. Clients should parse only the finished blocks once and re-parse just the unfinished tail.

## Safety invariants

A conforming client guarantees, whatever the model emits: no element or attribute outside this page survives; no URL scheme other than `https:`, `mailto:` and `#` is followed; model HTML cannot run script in the page (Content-Security-Policy `script-src 'self'`); widgets cannot reach the page, its storage or the network.

Defence in depth only helps where the layers fail independently. The grammar and the sanitizer are written from the same list, so they fail together; the Content-Security-Policy and the sandbox are independent of that list and of each other.

## Conformance

`conformance/cases/` holds documents that must be accepted (`good`, `widgets`), documents that must be rejected (`bad`), and documents valid only in the compact profile (`compact`). `bun run conform check` validates any file; `bun run conform sample` asks a backend and reports how many answers conform as emitted.
