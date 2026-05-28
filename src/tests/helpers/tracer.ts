// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { trace } from '@opentelemetry/api';
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-node';

export interface InMemoryTracer {
  provider: NodeTracerProvider;
  exporter: InMemorySpanExporter;
  finished(): readonly ReadableSpan[];
  shutdown(): Promise<void>;
}

/**
 * Build a NodeTracerProvider that records spans into an in-memory
 * exporter. Lets unit tests assert the exact span shape (name +
 * attributes + status) without standing up a real OTLP collector.
 *
 * The OTel global tracer registry is a singleton: a second
 * `provider.register()` is silently dropped once a provider is
 * already global. We call `trace.disable()` first so each test gets
 * a fresh registration and its own exporter sees the spans.
 */
export function makeInMemoryTracer(): InMemoryTracer {
  trace.disable();
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  // recordPostToolUse / guard-hook deny-path emit fetch via the GLOBAL
  // `trace.getTracer(...)` API rather than `provider.getTracer(...)`,
  // so we have to register this provider as the global one for the
  // exporter to see anything.
  provider.register();
  return {
    provider,
    exporter,
    finished: () => exporter.getFinishedSpans(),
    shutdown: async () => {
      await provider.shutdown();
    },
  };
}
