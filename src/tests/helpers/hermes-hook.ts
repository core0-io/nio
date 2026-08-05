// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared harness for driving the bundled Hermes `hook-cli.js` from tests.
 *
 * Two suites need the same thing and had a byte-identical ~35-line copy
 * each (`hermes-exit.test.ts`, `monitor-hermes.test.ts`), with a comment
 * in one telling the reader to keep its timeout constant in sync with the
 * other by hand. That is the kind of duplication that silently drifts:
 * the moment one copy learns something (a new kill signal, a different
 * failure message, a changed timeout), the other keeps testing the old
 * shape.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The bundled hook-cli, as Hermes actually invokes it.
 *
 * Bundled by bun into `plugins/claude-code/skills/nio/scripts/`, NOT
 * `dist/scripts/` — same resolution as hook-cli.test.ts. Tests must run
 * against the bundle: `bun` rewrites `require` and resolves
 * `@opentelemetry/*` differently from `tsc`, and that difference has
 * already hidden one real bug (see common.ts's `createRequire` fix).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
export const HERMES_HOOK_CLI = join(
  HERE, '..', '..', '..', 'plugins', 'claude-code', 'skills', 'nio', 'scripts', 'hook-cli.js',
);

/**
 * Default per-run ceiling for a hook-cli subprocess.
 *
 * Sized against a fixture whose `collector.endpoint` is configured but
 * REFUSED. The exporter's per-attempt budget is `config.timeout` (5s),
 * but a refused connection is retried inside that budget
 * (RetryingTransport, up to 5 attempts with jittered backoff), and the
 * meter / tracer / logger `forceFlush()` calls run concurrently, each
 * with its own retry cycle plus whatever the 1s periodic metrics tick
 * already had in flight. Measured directly across 3 concurrent runs:
 * collector path (`post_tool_call`) ~10.6-12.1s, guard deny branch
 * (meter + tracer both flushing) ~17.9-21.1s — the consistent worst case
 * — guard allow branch ~14.4-16.1s.
 *
 * 45s keeps ~2x headroom over that ~21s worst case for slower CI without
 * masking a real hang as a slow pass. Note this bounds a REFUSED
 * endpoint; an endpoint that drops packets is a different and much worse
 * case, bounded in production by `lib/flush-budget.ts` and pinned by
 * `collector-flush-timeout.test.ts`.
 *
 * Without an explicit timeout, a regression that reintroduced both the
 * hang (hook-cli's `writeAndExit`) and a gate failure at once would block
 * CI forever instead of failing fast.
 */
export const HERMES_HOOK_TIMEOUT_MS = 45000;

/**
 * Spawn hook-cli asynchronously and resolve with its stdout.
 *
 * Async (not `execFileSync`) is required, not merely preferred, for two
 * independent reasons:
 *
 *  1. **In-process sinks.** `execFileSync` / `spawnSync` block the
 *     calling process's entire event loop until the child exits —
 *     including an `http.createServer` OTLP sink the test itself stood
 *     up. The child connects BACK to that server, so a sync spawn
 *     deadlocks: the connection sits unserviced until the parent's loop
 *     is free, which only happens once the (still-waiting) child exits.
 *     Confirmed empirically; switching to `spawn` fixed it with no other
 *     change.
 *  2. **Concurrency.** Cases that each wait multi-second retry cycles
 *     would otherwise serialize behind one another.
 *
 * Each call owns its own timeout, so one hung case cannot stall the
 * others sharing a `before` kickoff. A non-zero exit rejects — callers
 * asserting on a deliberate non-zero exit code should spawn directly.
 */
export function runHermesHookAsync(
  home: string,
  envelope: unknown,
  timeoutMs: number = HERMES_HOOK_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [HERMES_HOOK_CLI, '--platform', 'hermes', '--stdin'], {
      env: { ...process.env, NIO_HOME: home },
    });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`hook-cli timed out after ${timeoutMs}ms; stderr so far: ${err}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`hook-cli exited with code ${code}; stderr: ${err}`));
        return;
      }
      resolve(out);
    });
    child.stdin.write(JSON.stringify(envelope));
    child.stdin.end();
  });
}
