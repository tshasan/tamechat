// The subset definition as the page uses it. The server serves spec/subset.json; this turns it
// into sets and compiled patterns, so the sanitizer and the stream renderer cannot disagree with
// the grammar or the validator about what is allowed.

export function fromJSON(j) {
  const names = new Set(['template']);
  for (const k of Object.keys(j.content)) names.add(k.split('>').pop());
  for (const list of [j.void, j.categories.block, j.categories.phrasing]) list.forEach((n) => names.add(n));
  names.delete('#root');
  const attrs = {};
  for (const [el, a] of Object.entries(j.attributes)) {
    attrs[el] = Object.fromEntries(Object.entries(a).map(([k, p]) => [k, new RegExp(p)]));
  }
  return {
    tags: names,
    attrs,
    void: new Set(j.void),
    block: new Set(j.categories.block),
    optionalEnd: new Set(j.optionalEnd),
    implied: j.implied,
  };
}

export async function loadSubset(url = '/subset.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${url}: ${res.status}`);
  return fromJSON(await res.json());
}
