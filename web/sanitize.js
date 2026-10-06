// Allowlist sanitizer, built from spec/subset.json (see subset.js). The grammar already makes
// anything else impossible to generate; this protects the page when a model ran without it, which
// is the normal case for hosted models. It parses into an inert <template>, so nothing loads or
// runs while it works.

export function sanitize(subset, root) {
  for (const el of [...root.querySelectorAll('*')]) {
    const tag = el.localName;
    if (!subset.tags.has(tag) || (tag === 'template' && !el.hasAttribute('data-widget'))) {
      el.remove();
      continue;
    }
    const rules = subset.attrs[tag] || {};
    for (const { name, value } of [...el.attributes]) {
      if (!rules[name] || !rules[name].test(value)) el.removeAttribute(name);
    }
    if (tag === 'a') { el.rel = 'noopener noreferrer'; el.target = '_blank'; }
    // Attributes the compact profile leaves out are filled in here, so both profiles render alike.
    if (tag === 'aside') el.setAttribute('role', subset.implied.aside.role);
    if (tag === 'button') el.setAttribute('type', subset.implied.button.type);
  }
  for (const th of root.querySelectorAll('th:not([scope])')) {
    th.setAttribute('scope', th.closest('thead') || th.previousElementSibling ? 'col' : 'row');
  }
}
