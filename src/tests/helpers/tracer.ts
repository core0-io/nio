// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { trace } from '@opentelemetry/api';
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';

export interface InMemoryTracer {
  provider: NodeTracerProvider;
  exporter: InMemorySpanExporter;
  /**
   * The exported spans. THROWS if any span has ended but not yet been
   * exported — see the note on batching below.
   */
  finished(): readonly ReadableSpan[];
  /** Flush the batch processor, then return the exported spans. */
  flushed(): Promise<readonly ReadableSpan[]>;
  shutdown(): Promise<void>;
}

/**
 * A `SpanProcessor` that only counts. Registered alongside the batch
 * processor so the helper knows, synchronously, how many spans have
 * ended — and can therefore tell "nothing was recorded" apart from
 * "something was recorded and is still sitting in the batch queue".
 * Uses only the public processor interface; no reaching into SDK
 * internals.
 */
class EndedSpanCounter implements SpanProcessor {
  ended = 0;
  onStart(): void { /* not needed */ }
  onEnd(): void { this.ended += 1; }
  async forceFlush(): Promise<void> { /* nothing buffered */ }
  async shutdown(): Promise<void> { /* nothing to release */ }
}

/**
 * Build a NodeTracerProvider that records spans into an in-memory
 * exporter. Lets unit tests assert the exact span shape (name +
 * attributes + status) without standing up a real OTLP collector.
 *
 * ── Why this wires BatchSpanProcessor ─────────────────────────────────
 *
 * It is the same processor, with the same sizing, that
 * `createTracerProvider` ships. That is the point of the helper: while it
 * wired `SimpleSpanProcessor` — which exports synchronously inside
 * `span.end()` — every span assertion in the suite ran against export
 * timing production had already stopped using, and swapping
 * `traces-collector.ts` to batching could not turn a single existing test
 * red. A harness that cannot express production's timing cannot catch a
 * defect in it.
 *
 * Consequence for callers: a span is NOT in the exporter the instant it
 * ends. Either drive a production helper (they all end with an internal
 * `forceFlush`) or `await tracer.flushed()`.
 *
 * ── Why `finished()` throws rather than returning a short list ─────────
 *
 * Because batching would otherwise make every NEGATIVE assertion pass for
 * free: `assert.equal(tracer.finished().length, 0)` is satisfied by a
 * span that was recorded and merely not flushed yet. Counting ends
 * separately lets the helper refuse to answer at all in that case, so a
 * missing flush shows up as a loud failure instead of a silently
 * vacuous pass.
 *
 * The OTel global tracer registry is a singleton: a second
 * `provider.register()` is silently dropped once a provider is
 * already global. We call `trace.disable()` first so each test gets
 * a fresh registration and its own exporter sees the spans.
 */
export function makeInMemoryTracer(): InMemoryTracer {
  trace.disable();
  const exporter = new InMemorySpanExporter();
  const counter = new EndedSpanCounter();
  const provider = new NodeTracerProvider({
    // Mirrors createTracerProvider's processor and sizing exactly.
    spanProcessors: [counter, new BatchSpanProcessor(exporter, {
      maxQueueSize: 2048,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 1000,
    })],
  });
  // Spans flow through `provider.getTracer(...)` now (not the global
  // API), but `.register()` is still cheap and lets any auto-
  // instrumentation in this process find the provider too. Kept for
  // parity with how nio's real createTracerProvider sets up.
  provider.register();
  const read = (): readonly ReadableSpan[] => {
    const out = exporter.getFinishedSpans();
    if (counter.ended > out.length) {
      throw new Error(
        `makeInMemoryTracer: ${counter.ended - out.length} span(s) have ended but are `
        + 'still in the BatchSpanProcessor queue. This helper wires the same batch '
        + 'processor production uses, so an ended span is not exported until something '
        + 'flushes. Await a production helper (they flush internally) or '
        + '`await tracer.flushed()` before asserting.',
      );
    }
    return out;
  };
  return {
    provider,
    exporter,
    finished: read,
    flushed: async () => {
      // An in-memory exporter never fails, so this cannot reject the way
      // a real OTLP-backed BatchSpanProcessor flush can.
      await provider.forceFlush();
      return read();
    },
    shutdown: async () => {
      await provider.shutdown();
    },
  };
}
