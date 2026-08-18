// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared OTLP flush deadline for the per-event hook processes.
 *
 * Every hook entrypoint on the three fork-per-event platforms
 * (Claude Code, Codex, Hermes) awaits OTEL exports before it is allowed
 * to hand its answer back to the host. Those awaits are the host's tool
 * call sitting frozen, so they need a ceiling.
 *
 * `collector.timeout` is NOT that ceiling. It governs the request timeout
 * once a socket is connected and does nothing during TCP connect. Against
 * an endpoint that silently DROPS packets (firewalled or unroutable IP,
 * VPN torn down mid-session) connect() blocks until the OS-level TCP
 * timeout, and the OTLP exporter then retries — so the observable stall
 * is longer still. Measured against RFC 5737 TEST-NET-1
 * (192.0.2.1:4318), all unbounded and killed at the 95s mark, none had
 * exited:
 *
 *   collector-hook  PostToolUse           95023ms (SIGKILL)
 *   hook-cli        pre_tool_call allow   95026ms (SIGKILL)
 *   hook-cli        pre_tool_call deny    95023ms (SIGKILL)
 *   hook-cli        post_tool_call        95023ms (SIGKILL)
 *
 * A merely *refused* endpoint (RST from the kernel) is far milder, which
 * is why drop, not refusal, is the case this module is sized against.
 *
 * Losing a span/metric against an unreachable endpoint is strictly better
 * than stalling the agent: telemetry never blocks the host. On the guard
 * hooks it is stronger than that — Hermes runs the hook under
 * `subprocess.run(timeout=60)`, so a `deny` that arrives late is a
 * dangerous action allowed through.
 *
 * ── Why one budget object rather than a timer per await ───────────────
 *
 * The hang is almost never at the closing `Promise.all([...forceFlush])`.
 * The library helpers reached earlier — `recordGuardDecision`,
 * `recordToolUse`, `recordPostToolUse`, `endTurn`, … — each END with
 * their own internal `provider.forceFlush()`, so control never reaches
 * the closing flush at all. Bounding only that last call is a no-op fix
 * (verified: still 40s+). Every OTLP-touching await on the path has to
 * be inside the budget, and they have to SHARE one deadline — N
 * sequential 5s races would be an N×5s ceiling.
 */

/** Wall-clock ceiling for ALL OTLP-touching awaits on one hook run. */
export const FLUSH_BACKSTOP_MS = 5000;

/**
 * Bound a promise by the shared deadline, resolving to `onTimeout`
 * instead if the deadline passes first. The losing promise is abandoned,
 * not cancelled — the process exits out from under it.
 */
export type FlushBudget = <T>(p: Promise<T>, onTimeout: T) => Promise<T>;

/**
 * Open a flush budget. The deadline starts NOW, so call this at the point
 * the OTLP-touching section begins — not at module load, and not before
 * work that is allowed to take its own time (guard evaluation, stdin
 * read).
 *
 * `configuredTimeoutMs` is `collector.timeout`: it can only ever make the
 * budget *shorter*, never longer than {@link FLUSH_BACKSTOP_MS}. A user
 * who deliberately lowers `collector.timeout` is asking for a snappier
 * hook, and a user who raises it is asking about request timeouts, not
 * about how long the agent may freeze.
 */
export function createFlushBudget(
  configuredTimeoutMs?: number,
  backstopMs: number = FLUSH_BACKSTOP_MS,
): FlushBudget {
  const budgetMs = Math.min(configuredTimeoutMs ?? backstopMs, backstopMs);
  const deadline = Date.now() + budgetMs;
  return function withFlushBudget<T>(p: Promise<T>, onTimeout: T): Promise<T> {
    const remaining = Math.max(0, deadline - Date.now());
    return Promise.race([
      p,
      new Promise<T>((resolve) => {
        // unref'd: this timer must never be the reason the process stays
        // alive once the real work has already settled.
        setTimeout(() => resolve(onTimeout), remaining).unref();
      }),
    ]);
  };
}
