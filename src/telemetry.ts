import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { trace, type Attributes, type Tracer } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type ReadableSpan, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace-base';

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  startMs: number;
  durationMs: number;
  attributes: Attributes;
}

export interface TelemetryOptions {
  file: string;
  otlp: boolean;
}

export interface Telemetry {
  tracer: Tracer;
  enabled: boolean;
  shutdown: () => Promise<void>;
}

const toMs = (time: [number, number]): number => time[0] * 1000 + time[1] / 1e6;

export function toRecord(span: ReadableSpan): SpanRecord {
  return {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? '',
    name: span.name,
    startMs: toMs(span.startTime),
    durationMs: toMs(span.duration),
    attributes: span.attributes,
  };
}

export class JsonlExporter implements SpanExporter {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
  }

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    appendFileSync(this.file, spans.map((s) => `${JSON.stringify(toRecord(s))}\n`).join(''));
    done({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export function tracerFor(processors: SpanProcessor[]): Telemetry {
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'tamechat' }),
    spanProcessors: processors,
  });
  return { tracer: provider.getTracer('tamechat'), enabled: true, shutdown: () => provider.shutdown() };
}

export function startTelemetry(o: TelemetryOptions): Telemetry {
  const processors: SpanProcessor[] = [];
  if (o.file) processors.push(new SimpleSpanProcessor(new JsonlExporter(o.file)));
  if (o.otlp) processors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  return tracerFor(processors);
}

export const disabledTelemetry: Telemetry = { tracer: trace.getTracer('tamechat-noop'), enabled: false, shutdown: () => Promise.resolve() };
