// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Teardown for a loopback OTLP sink that a test pointed the REAL plugin
 * runtime at.
 *
 * Why this is not just `server.close()`:
 *
 * A test that writes `collector.endpoint: http://127.0.0.1:<port>` into
 * its config and then registers a real plugin makes the runtime build
 * its own tracer / meter / logger providers. Each of those owns a
 * background export timer that fires every second and keeps firing
 * until the provider is shut down or the process dies — the runtime
 * documents this as deliberate for production (one runtime per host,
 * cumulative metrics), and it has no session-scoped off switch.
 *
 * Close the sink without shutting those providers down and the exporter
 * spends the rest of the process's life retrying into a dead port. Every
 * attempt opens a fresh TCP connect, which is a REF'D libuv handle, so
 * the event loop never drains: the `node --test` worker hangs forever
 * with every one of its tests already passed. Under a full concurrent
 * run that silently converts a 21-second `pnpm test` into a run that
 * never returns, and leaves node processes alive across sessions.
 *
 * So teardown has to happen in this order:
 *
 *   1. shut the runtime-built providers down — while the sink is still
 *      listening, so the final export lands instead of thrashing;
 *   2. drop any connection still parked in the exporter's keep-alive
 *      pool, which `server.close()` alone would sit and wait on;
 *   3. only then stop the server.
 *
 * Injected providers (`tracerProvider: tracer.provider`, `meterProvider:
 * null`, …) are untouched — the registry only ever holds providers the
 * runtime built for itself, so a test can still read its own in-memory
 * provider after calling this.
 */

import type { Server } from 'node:http';

import { shutdownRuntimeBuiltProviders } from '../../adapters/plugin-runtime.js';

/**
 * Shut down runtime-built OTLP providers, then close `server`.
 *
 * Use in the `finally` of any test that stood a loopback OTLP sink up
 * for the real runtime. Idempotent and safe when the runtime never
 * built a provider at all.
 */
export async function closeOtlpSink(server: Server): Promise<void> {
  await shutdownRuntimeBuiltProviders();
  // Node keeps a closed server's already-accepted keep-alive connections
  // alive until they go idle; the exporter's agent pools exactly such a
  // connection. Dropping them makes `close()` deterministic.
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
