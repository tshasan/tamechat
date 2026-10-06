import DOMPurify from 'dompurify';
import { marked } from 'marked';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('rel', 'noopener noreferrer');
    node.setAttribute('target', '_blank');
  }
});

export function markdownToHtml(source: string): string {
  return DOMPurify.sanitize(marked.parse(source, { async: false }));
}

export class MarkdownRenderer {
  private readonly el: HTMLElement;
  private text = '';

  constructor(el: HTMLElement) {
    this.el = el;
  }

  push(chunk: string): void {
    this.text += chunk;
  }

  render(): void {
    this.el.innerHTML = markdownToHtml(this.text);
  }

  finish(): void {
    this.render();
  }
}
