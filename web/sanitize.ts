import type { Subset } from '../src/subset.ts';

const xhtml = 'http://www.w3.org/1999/xhtml';

export function sanitize(s: Subset, root: ParentNode): void {
  for (const el of [...root.querySelectorAll('*')]) {
    const tag = el.localName;
    if (el.namespaceURI !== xhtml || !s.known.has(tag) || (tag === 'template' && !el.hasAttribute('data-widget'))) {
      el.remove();
      continue;
    }
    const rules = s.attrs.get(tag);
    for (const { name, value } of [...el.attributes]) {
      if (!rules?.get(name)?.test(value)) el.removeAttribute(name);
    }
    if (tag === 'a') {
      el.setAttribute('rel', 'noopener noreferrer');
      el.setAttribute('target', '_blank');
    }
    if (tag === 'aside') el.setAttribute('role', s.definition.implied.aside.role);
    if (tag === 'button') el.setAttribute('type', s.definition.implied.button.type);
  }
  for (const th of root.querySelectorAll('th:not([scope])')) {
    th.setAttribute('scope', th.closest('thead') || th.previousElementSibling ? 'col' : 'row');
  }
}
