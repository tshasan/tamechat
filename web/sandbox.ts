type RenderMessage = { type: 'render'; html: string; theme: Record<string, string> };

declare global {
  interface Window {
    sendPrompt: (text: string) => void;
  }
}

let rendered = false;

addEventListener('message', (e: MessageEvent<RenderMessage>) => {
  if (e.source !== parent || rendered || e.data?.type !== 'render') return;
  rendered = true;
  for (const [name, value] of Object.entries(e.data.theme)) {
    if (value) document.documentElement.style.setProperty(name, value);
  }
  document.body.append(document.createRange().createContextualFragment(String(e.data.html)));
  const report = () => parent.postMessage({ type: 'height', height: document.documentElement.scrollHeight }, '*');
  new ResizeObserver(report).observe(document.body);
  report();
});

window.sendPrompt = (text) => parent.postMessage({ type: 'prompt', text: String(text) }, '*');

export {};
