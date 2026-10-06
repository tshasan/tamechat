import type { Format } from '../src/format.ts';

export interface TurnMetrics {
  format: Format;
  ttfbMs: number;
  ttftMs: number;
  firstContentMs: number;
  totalMs: number;
  frames: number;
  renderMs: number;
  maxRenderMs: number;
  longTasks: number;
  longTaskMs: number;
  chars: number;
  words: number;
  outputTokens: number;
  domNodes: number;
  aborted: boolean;
}

declare global {
  interface Window {
    tamechat: { metrics: TurnMetrics[] };
  }
}

window.tamechat = { metrics: [] };

const longTasks: PerformanceEntry[] = [];
try {
  new PerformanceObserver((list) => longTasks.push(...list.getEntries())).observe({ type: 'longtask', buffered: false });
} catch {
  longTasks.length = 0;
}

export class TurnTimer {
  private readonly format: Format;
  private readonly started = performance.now();
  private ttfbMs = 0;
  private ttftMs = 0;
  private firstContentMs = 0;
  private frames = 0;
  private renderMs = 0;
  private maxRenderMs = 0;

  constructor(format: Format) {
    this.format = format;
  }

  private elapsed(): number {
    return performance.now() - this.started;
  }

  firstByte(): void {
    this.ttfbMs ||= this.elapsed();
  }

  firstToken(): void {
    this.ttftMs ||= this.elapsed();
  }

  rendered(duration: number, hasContent: boolean): void {
    this.frames++;
    this.renderMs += duration;
    this.maxRenderMs = Math.max(this.maxRenderMs, duration);
    if (hasContent) this.firstContentMs ||= this.elapsed();
  }

  finish(answer: HTMLElement, chars: number, outputTokens: number, aborted: boolean): TurnMetrics {
    const totalMs = this.elapsed();
    const tasks = longTasks.filter((t) => t.startTime >= this.started);
    const metrics: TurnMetrics = {
      format: this.format,
      ttfbMs: this.ttfbMs,
      ttftMs: this.ttftMs,
      firstContentMs: this.firstContentMs,
      totalMs,
      frames: this.frames,
      renderMs: this.renderMs,
      maxRenderMs: this.maxRenderMs,
      longTasks: tasks.length,
      longTaskMs: tasks.reduce((sum, t) => sum + t.duration, 0),
      chars,
      words: (answer.textContent ?? '').split(/\s+/).filter(Boolean).length,
      outputTokens,
      domNodes: answer.querySelectorAll('*').length,
      aborted,
    };
    window.tamechat.metrics.push(metrics);
    return metrics;
  }
}

export function summary(m: TurnMetrics): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
  const tokens = m.outputTokens ? ` · ${m.outputTokens} tokens` : '';
  return `${m.format} · first token ${s(m.ttftMs)} · first content ${s(m.firstContentMs)} · done ${s(m.totalMs)} · render ${m.renderMs.toFixed(0)} ms over ${m.frames} frames (worst ${m.maxRenderMs.toFixed(1)} ms) · ${m.longTasks} long tasks${tokens} · ${m.chars} chars`;
}
