// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * An engine failure must not become a silent allow of a destructive action.
 *
 * ── The defect ────────────────────────────────────────────────────────
 *
 * `evaluateHook` wrapped the whole Phase 1-6 call in one try/catch whose
 * catch wrote `risk_tags: ["ENGINE_ERROR"]` to the audit log and returned
 * `{ decision: 'allow' }`, commented `// Engine error → fail open`. Nothing
 * reached the user: exit 0, empty stderr, no additionalContext. The only
 * trace was one line in a JSONL file nobody reads until afterwards.
 *
 * The asymmetry that makes that the wrong default: the engine is most
 * likely to fail when its input is strangest, and a strange input is one
 * of the shapes an attack takes.
 *
 * ── Measured, through the shipped bundles, before the fix ─────────────
 *
 * A `tool_input` nested 200 000 deep is plain JSON — `JSON.parse` accepts
 * it — but the orchestrator's `JSON.stringify(args, null, 2)` on the
 * `mcp_tool_call` branch is recursive and blows the stack. So an MCP call
 * carrying `{ path: "<tmp>/.ssh/authorized_keys", content: "ssh-rsa …" }`
 * measured, with NO collector endpoint configured:
 *
 *   guard-hook.js   mcp__filesystem__write_file   rc=0, stderr empty
 *                                                 audit: decision "error"
 *   hook-cli.js     filesystem__write_file        rc=0, stdout "{}"
 *
 * After: rc=2 with a reason / `{"decision":"block"}`, both naming
 * ENGINE_ERROR and saying it is Nio that failed, not the action.
 *
 * ── The rule ──────────────────────────────────────────────────────────
 *
 * On an engine error the decision is taken from `envelope.action.type`
 * ALONE — a value the adapter resolved before the pipeline was entered,
 * so it costs no analysis and cannot have been corrupted by whatever just
 * threw. `read_file` fails open with a diagnostic; everything else,
 * including action types a third-party adapter invents, fails closed.
 *
 * MUTATION (each kills a named test on its own):
 *   - `ENGINE_ERROR_ALLOWED_ACTIONS` → all six action types
 *     → every fail-closed case + both e2e host cases go red
 *   - `ENGINE_ERROR_ALLOWED_ACTIONS` → empty set
 *     → the read_file fail-open case goes red
 *   - drop `diagnostics` from the allow return  → the read diagnostic case
 *   - drop `diagnostics` from the deny return   → the deny diagnostic case
 *   - `entry.decision = decision` → `'error'`   → both audit cases
 *   - `describeEngineError`'s non-Error branch → `''`  → the thrown-string case
 *   - `describeEngineError`'s truncation removed       → the long-message case
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { evaluateHook } from '../adapters/hook-engine.js';
import type { EngineOptions, HookAdapter, HookInput } from '../adapters/types.js';
import type { ActionEnvelope } from '../types/action.js';
import { createTestContext } from './helpers/test-utils.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

function freshDir(prefix: string): string {
  return trackTempDir(mkdtempSync(join(tmpdir(), prefix)));
}

function readEntries(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/**
 * Replace the orchestrator with one that throws, leaving every other part
 * of the path real: real adapter, real parseInput, real Phase 0 gate, real
 * envelope. Only the engine is broken, which is exactly the scenario.
 */
function withThrowingEngine(options: EngineOptions, err: unknown): EngineOptions {
  return {
    ...options,
    nio: {
      orchestrator: { evaluate: async () => { throw err; } },
    } as unknown as EngineOptions['nio'],
  };
}

/** A sensitive path INSIDE the test's own temp dir. Never a real HOME. */
function sensitivePath(dir: string): string {
  return join(dir, '.ssh', 'authorized_keys');
}

// ── 1. The catch is reachable with the real engine, no stubs ────────────

describe('engine error: reachable for real', () => {
  let ctx: ReturnType<typeof createTestContext> | undefined;
  afterEach(() => { ctx?.cleanup(); ctx = undefined; });

  it('a genuine orchestrator throw on an MCP write is denied, not silently allowed', async () => {
    ctx = createTestContext('balanced');
    const dir = freshDir('nio-engine-error-real-');
    const auditPath = join(dir, 'audit.jsonl');

    // Circular args: `JSON.stringify(args, null, 2)` on the orchestrator's
    // mcp_tool_call branch throws TypeError. The in-process runtimes hand
    // the adapters live host objects, so this shape is reachable there —
    // and NOTHING here is stubbed, so it proves the catch is live code.
    const args: Record<string, unknown> = {
      path: sensitivePath(dir),
      content: 'ssh-rsa AAAA',
    };
    args.self = args;

    const result = await evaluateHook(
      ctx.claudeAdapter,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__filesystem__write_file',
        tool_input: args,
        session_id: 'sess-real-engine-error',
        cwd: dir,
      },
      ctx.options,
      { logsConfig: { path: auditPath } },
    );

    assert.equal(
      result.decision, 'deny',
      'a real engine throw on an MCP write must not fall through to allow',
    );
    assert.deepEqual(result.riskTags, ['ENGINE_ERROR']);
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['decision'], 'deny');
    assert.deepEqual(entries[0]!['risk_tags'], ['ENGINE_ERROR']);
  });
});

// ── 2. The tiering itself ───────────────────────────────────────────────

describe('engine error: fail closed for anything that changes the world', () => {
  let ctx: ReturnType<typeof createTestContext> | undefined;
  afterEach(() => { ctx?.cleanup(); ctx = undefined; });

  it('a write to a sensitive path is DENIED when the engine throws', async () => {
    ctx = createTestContext('balanced');
    const dir = freshDir('nio-engine-error-write-');
    const auditPath = join(dir, 'audit.jsonl');

    const result = await evaluateHook(
      ctx.claudeAdapter,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: sensitivePath(dir), content: 'ssh-rsa AAAA' },
        session_id: 'sess-write',
        cwd: dir,
      },
      withThrowingEngine(ctx.options, new Error('phase 3 exploded')),
      { logsConfig: { path: auditPath } },
    );

    assert.equal(
      result.decision, 'deny',
      'a write_file the guard could not evaluate must not be allowed',
    );
    assert.equal(result.riskLevel, 'critical');
    assert.equal(result.riskScore, 1.0);
    assert.deepEqual(result.riskTags, ['ENGINE_ERROR']);
  });

  it('the deny reason says Nio failed, not that the action broke a rule', async () => {
    ctx = createTestContext('balanced');
    const dir = freshDir('nio-engine-error-reason-');

    const result = await evaluateHook(
      ctx.claudeAdapter,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: sensitivePath(dir), content: 'x' },
        session_id: 'sess-reason',
        cwd: dir,
      },
      withThrowingEngine(ctx.options, new Error('phase 3 exploded')),
      { logsConfig: { local: false } },
    );

    assert.equal(result.decision, 'deny');
    const reason = result.reason ?? '';
    assert.match(reason, /ENGINE_ERROR/, 'the tag must be in the host-visible reason');
    assert.match(reason, /engine failed/i, 'the user must be able to tell this apart from a rule hit');
    assert.match(reason, /write_file/, 'the reason must name the action that was refused');
    assert.match(reason, /phase 3 exploded/, 'the underlying failure must be quoted');
  });

  it('the deny carries a diagnostic the hosts can surface', async () => {
    ctx = createTestContext('balanced');
    const dir = freshDir('nio-engine-error-denydiag-');

    const result = await evaluateHook(
      ctx.claudeAdapter,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: sensitivePath(dir), content: 'x' },
        session_id: 'sess-denydiag',
        cwd: dir,
      },
      withThrowingEngine(ctx.options, new Error('phase 3 exploded')),
      { logsConfig: { local: false } },
    );

    const diags = result.diagnostics ?? [];
    assert.equal(diags.length, 1, 'exactly one diagnostic, from the one triage site');
    assert.equal(diags[0]!.kind, 'engine_error');
    assert.equal(diags[0]!.severity, 'error');
    assert.equal(diags[0]!.component, 'write_file');
    assert.match(diags[0]!.hint ?? '', /Nio failure/i);
  });

  it('an exec_command is DENIED when the engine throws', async () => {
    ctx = createTestContext('balanced');
    const dir = freshDir('nio-engine-error-exec-');

    const result = await evaluateHook(
      ctx.claudeAdapter,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: `rm -rf ${dir}` },
        session_id: 'sess-exec',
        cwd: dir,
      },
      withThrowingEngine(ctx.options, new Error('boom')),
      { logsConfig: { local: false } },
    );

    assert.equal(result.decision, 'deny');
    assert.deepEqual(result.riskTags, ['ENGINE_ERROR']);
  });

  it('a network_request is DENIED when the engine throws', async () => {
    ctx = createTestContext('balanced');
    const dir = freshDir('nio-engine-error-net-');

    const result = await evaluateHook(
      ctx.claudeAdapter,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'WebFetch',
        tool_input: { url: 'https://example.invalid/exfil' },
        session_id: 'sess-net',
        cwd: dir,
      },
      withThrowingEngine(ctx.options, new Error('boom')),
      { logsConfig: { local: false } },
    );

    assert.equal(result.decision, 'deny');
    assert.deepEqual(result.riskTags, ['ENGINE_ERROR']);
  });

  it('an mcp_tool_call is DENIED when the engine throws — its effect is unknowable', async () => {
    ctx = createTestContext('balanced');
    const dir = freshDir('nio-engine-error-mcp-');

    const result = await evaluateHook(
      ctx.claudeAdapter,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__filesystem__write_file',
        tool_input: { path: sensitivePath(dir), content: 'ssh-rsa AAAA' },
        session_id: 'sess-mcp',
        cwd: dir,
      },
      withThrowingEngine(ctx.options, new Error('boom')),
      { logsConfig: { local: false } },
    );

    assert.equal(result.decision, 'deny');
    assert.deepEqual(result.riskTags, ['ENGINE_ERROR']);
  });

  it('an action type the engine cannot classify is DENIED, not waved through', async () => {
    ctx = createTestContext('balanced');
    const dir = freshDir('nio-engine-error-unknown-');

    // `HookAdapter` is exported public API, so a library consumer can hand
    // the engine an action type Nio has never heard of. "Unrecognised" is
    // the same epistemic position as "could not be determined": deny.
    const exoticAdapter: HookAdapter = {
      name: 'exotic',
      parseInput: () => ({
        toolName: 'teleport',
        toolInput: { target: 'mars' },
        eventType: 'pre',
        sessionId: 'sess-exotic',
        cwd: dir,
        raw: {},
      } as HookInput),
      mapToolToActionType: () => 'teleport',
      buildEnvelope: () => ({
        actor: { skill: { id: 'x', source: 'x', version_ref: '0', artifact_hash: '' } },
        action: { type: 'teleport' as unknown as ActionEnvelope['action']['type'], data: {} as never },
        context: { session_id: 'sess-exotic', user_present: true, env: 'prod', time: new Date().toISOString() },
      } as ActionEnvelope),
      inferInitiatingSkill: async () => null,
    };

    const result = await evaluateHook(
      exoticAdapter,
      {},
      withThrowingEngine(ctx.options, new Error('boom')),
      { logsConfig: { local: false } },
    );

    assert.equal(result.decision, 'deny');
    assert.deepEqual(result.riskTags, ['ENGINE_ERROR']);
  });

  it('the audit row records the deny that actually happened, tagged ENGINE_ERROR', async () => {
    ctx = createTestContext('balanced');
    const dir = freshDir('nio-engine-error-audit-deny-');
    const auditPath = join(dir, 'audit.jsonl');

    await evaluateHook(
      ctx.claudeAdapter,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: sensitivePath(dir), content: 'x' },
        session_id: 'sess-audit-deny',
        cwd: dir,
      },
      withThrowingEngine(ctx.options, new Error('phase 3 exploded')),
      { logsConfig: { path: auditPath } },
    );

    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1);
    assert.equal(
      entries[0]!['decision'], 'deny',
      'the audit log must say what was done, not just that something failed',
    );
    assert.deepEqual(entries[0]!['risk_tags'], ['ENGINE_ERROR']);
    assert.equal(entries[0]!['action_type'], 'write_file');
    assert.match(String(entries[0]!['explanation']), /engine failed/i);
  });
});

describe('engine error: fail open only for actions that cannot change anything', () => {
  let ctx: ReturnType<typeof createTestContext> | undefined;
  afterEach(() => { ctx?.cleanup(); ctx = undefined; });

  /** Hermes is the adapter with a first-class `read_file` tool mapping. */
  async function readWithBrokenEngine(dir: string, auditPath?: string) {
    return evaluateHook(
      ctx!.hermesAdapter,
      {
        hook_event_name: 'pre_tool_call',
        tool_name: 'read_file',
        tool_input: { path: sensitivePath(dir) },
        session_id: 'sess-read',
        cwd: dir,
        extra: {},
      },
      withThrowingEngine(ctx!.options, new Error('phase 2 exploded')),
      auditPath ? { logsConfig: { path: auditPath } } : { logsConfig: { local: false } },
    );
  }

  it('a read_file is ALLOWED when the engine throws', async () => {
    ctx = createTestContext('balanced');
    const dir = freshDir('nio-engine-error-read-');

    const result = await readWithBrokenEngine(dir);

    assert.equal(
      result.decision, 'allow',
      'blocking every read on an engine bug would make Nio unusable for no safety gain',
    );
  });

  it('a read_file that failed open still tells the user, via diagnostics', async () => {
    ctx = createTestContext('balanced');
    const dir = freshDir('nio-engine-error-readdiag-');

    const result = await readWithBrokenEngine(dir);

    const diags = result.diagnostics ?? [];
    assert.equal(diags.length, 1, 'the allow must not be silent — that was the whole defect');
    assert.equal(diags[0]!.kind, 'engine_error');
    assert.equal(diags[0]!.component, 'read_file');
    assert.match(diags[0]!.message, /allowed unanalysed/);
  });

  it('the audit row for a failed-open read says allow, tagged ENGINE_ERROR', async () => {
    ctx = createTestContext('balanced');
    const dir = freshDir('nio-engine-error-audit-allow-');
    const auditPath = join(dir, 'audit.jsonl');

    await readWithBrokenEngine(dir, auditPath);

    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['decision'], 'allow');
    assert.deepEqual(entries[0]!['risk_tags'], ['ENGINE_ERROR']);
    assert.equal(entries[0]!['action_type'], 'read_file');
  });
});

// ── 3. What the engine threw is reported, whatever it was ───────────────

describe('engine error: the thrown value is rendered without throwing again', () => {
  let ctx: ReturnType<typeof createTestContext> | undefined;
  afterEach(() => { ctx?.cleanup(); ctx = undefined; });

  async function denyWith(thrown: unknown, dir: string) {
    return evaluateHook(
      ctx!.claudeAdapter,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: sensitivePath(dir), content: 'x' },
        session_id: 'sess-thrown',
        cwd: dir,
      },
      withThrowingEngine(ctx!.options, thrown),
      { logsConfig: { local: false } },
    );
  }

  it('a thrown non-Error still reaches the reason', async () => {
    ctx = createTestContext('balanced');
    const dir = freshDir('nio-engine-error-thrown-str-');

    const result = await denyWith('not-an-error-object', dir);

    assert.equal(result.decision, 'deny');
    assert.match(result.reason ?? '', /not-an-error-object/);
  });

  it('a huge error message is truncated instead of pasted into the host output', async () => {
    ctx = createTestContext('balanced');
    const dir = freshDir('nio-engine-error-thrown-long-');

    const result = await denyWith(new Error('E'.repeat(50_000)), dir);

    assert.equal(result.decision, 'deny');
    assert.ok(
      (result.reason ?? '').length < 1_000,
      `the reason must stay host-sized, got ${(result.reason ?? '').length} chars`,
    );
    assert.match(result.reason ?? '', /…/, 'truncation must be visible, not silent');
  });
});

// ── 4. The tiering does not consult the collector ───────────────────────

describe('engine error: the decision is independent of capture state', () => {
  let ctx: ReturnType<typeof createTestContext> | undefined;
  afterEach(() => { ctx?.cleanup(); ctx = undefined; });

  it('the same write denies with the OTLP log leg on, off, and with no local log', async () => {
    ctx = createTestContext('balanced');
    const dir = freshDir('nio-engine-error-gate-');

    const shapes = [
      { logsConfig: { enabled: false, local: true, path: join(dir, 'a.jsonl') } },
      { logsConfig: { enabled: true, local: true, path: join(dir, 'b.jsonl') } },
      { logsConfig: { enabled: true, local: false } },
    ];

    for (const auditOpts of shapes) {
      const result = await evaluateHook(
        ctx.claudeAdapter,
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: { file_path: sensitivePath(dir), content: 'x' },
          session_id: 'sess-gate',
          cwd: dir,
        },
        withThrowingEngine(ctx.options, new Error('boom')),
        auditOpts,
      );
      assert.equal(
        result.decision, 'deny',
        `guard ⟂ monitor: ${JSON.stringify(auditOpts)} must not change the decision`,
      );
    }

    // The local JSONL leg is never gated: both `enabled` variants wrote.
    assert.equal(readEntries(join(dir, 'a.jsonl')).length, 1);
    assert.equal(readEntries(join(dir, 'b.jsonl')).length, 1);
  });
});

// ── 5. Controls: a working engine is untouched ──────────────────────────

describe('engine error: a working engine still decides on its own merits', () => {
  let ctx: ReturnType<typeof createTestContext> | undefined;
  afterEach(() => { ctx?.cleanup(); ctx = undefined; });

  it('the same sensitive write denies via SENSITIVE_PATH, not ENGINE_ERROR', async () => {
    ctx = createTestContext('balanced');
    const dir = freshDir('nio-engine-error-ctl-write-');

    const result = await evaluateHook(
      ctx.claudeAdapter,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: sensitivePath(dir), content: 'ssh-rsa AAAA' },
        session_id: 'sess-ctl-write',
        cwd: dir,
      },
      ctx.options,
      { logsConfig: { local: false } },
    );

    assert.equal(result.decision, 'deny');
    assert.ok(
      !(result.riskTags ?? []).includes('ENGINE_ERROR'),
      'the real deny must come from the rules, not from the fallback',
    );
    assert.match(result.reason ?? '', /SENSITIVE_PATH/);
  });

  it('a benign read allows with no diagnostics at all', async () => {
    ctx = createTestContext('balanced');
    const dir = freshDir('nio-engine-error-ctl-read-');
    const target = join(dir, 'notes.txt');
    writeFileSync(target, 'hello', 'utf-8');

    const result = await evaluateHook(
      ctx.hermesAdapter,
      {
        hook_event_name: 'pre_tool_call',
        tool_name: 'read_file',
        tool_input: { path: target },
        session_id: 'sess-ctl-read',
        cwd: dir,
        extra: {},
      },
      ctx.options,
      { logsConfig: { local: false } },
    );

    assert.equal(result.decision, 'allow');
    assert.equal(
      result.diagnostics?.length ?? 0, 0,
      'a healthy evaluation must not emit the engine-error diagnostic',
    );
  });
});

// ── 6. The decision reaches the host ────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const GUARD_HOOK = join(
  REPO, 'plugins', 'claude-code', 'skills', 'nio', 'scripts', 'guard-hook.js',
);
const HOOK_CLI = join(REPO, 'plugins', 'hermes', 'scripts', 'hook-cli.js');

/** Guard-only runs: no endpoint, no network, no flush budget to wait out. */
const EXIT_BOUND_MS = 30_000;

/**
 * Depth at which `JSON.stringify(value, null, 2)` overflows the stack while
 * `JSON.parse` still accepts the text. `JSON.parse` is iterative in V8 and
 * handled 100 000 in measurement; `JSON.stringify` with an indent recursed
 * and threw from 20 000 up. 200 000 is far enough past the boundary that no
 * plausible stack size makes it flaky in either direction.
 */
const OVERFLOW_DEPTH = 200_000;

/**
 * Build the payload as TEXT — `JSON.stringify` cannot produce it, which is
 * the whole point.
 */
function deepPayload(head: Record<string, unknown>, leaf: Record<string, unknown>): string {
  const body = '{"n":'.repeat(OVERFLOW_DEPTH) + JSON.stringify(leaf) + '}'.repeat(OVERFLOW_DEPTH);
  return JSON.stringify(head).slice(0, -1) + ',"tool_input":' + body + '}';
}

interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function runHook(cli: string, args: string[], home: string, payload: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [cli, ...args], { env: { ...process.env, NIO_HOME: home } });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, EXIT_BOUND_MS);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/** No collector endpoint: every case here is the guard's own path. */
function nioHome(): string {
  const home = freshDir('nio-engine-error-e2e-');
  writeFileSync(join(home, 'config.yaml'), `guard:
  protection_level: balanced
  confirm_action: deny
`, 'utf-8');
  return home;
}

describe('engine error: the decision reaches the host', () => {
  const runs = new Map<string, Promise<RunResult>>();

  before(() => {
    const ccHome = nioHome();
    runs.set('cc-overflow', runHook(GUARD_HOOK, [], ccHome, deepPayload(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-cc-overflow',
        cwd: ccHome,
        tool_name: 'mcp__filesystem__write_file',
      },
      { path: sensitivePath(ccHome), content: 'ssh-rsa AAAA' },
    )));

    // Control: the same tool, same sensitive path, shallow args. The engine
    // succeeds, so a green "cc-overflow" cannot be an artefact of the tool
    // name or the path being blocked for some unrelated reason.
    const ctlHome = nioHome();
    runs.set('cc-control', runHook(GUARD_HOOK, [], ctlHome, JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'sess-cc-control',
      cwd: ctlHome,
      tool_name: 'mcp__filesystem__write_file',
      tool_input: { path: sensitivePath(ctlHome), content: 'ssh-rsa AAAA' },
    })));

    const hHome = nioHome();
    runs.set('hermes-overflow', runHook(HOOK_CLI, ['--platform', 'hermes', '--stdin'], hHome, deepPayload(
      {
        hook_event_name: 'pre_tool_call',
        session_id: 'sess-hermes-overflow',
        cwd: hHome,
        extra: {},
        tool_name: 'filesystem__write_file',
      },
      { path: sensitivePath(hHome), content: 'ssh-rsa AAAA' },
    )));
  });

  it('claude code: an engine overflow on a sensitive write exits 2 with a reason', async () => {
    const r = await runs.get('cc-overflow')!;
    assert.ok(!r.timedOut, 'guard-hook did not exit');
    assert.equal(
      r.code, 2,
      `exited ${r.code} instead of 2 — 0 means the write ran, 1 is Claude Code's ` +
      `NON-blocking error code, so it ran then too. stderr: ${r.stderr.slice(0, 400)}`,
    );
    assert.match(r.stderr, /ENGINE_ERROR/, 'the reason must name the failure class');
    assert.match(r.stderr, /engine failed/i, 'the user must be told it was Nio that broke');
  });

  it('control: the same write with shallow args is evaluated normally', async () => {
    const r = await runs.get('cc-control')!;
    assert.ok(!r.timedOut, 'guard-hook did not exit');
    assert.ok(
      !/ENGINE_ERROR/.test(r.stderr),
      `a well-formed payload must not hit the fallback. stderr: ${r.stderr.slice(0, 400)}`,
    );
  });

  it('hermes: an engine overflow on a sensitive write blocks on stdout', async () => {
    const r = await runs.get('hermes-overflow')!;
    assert.ok(!r.timedOut, 'hook-cli did not exit');
    assert.equal(r.code, 0, `hook-cli exited ${r.code}. stderr: ${r.stderr.slice(0, 400)}`);
    assert.ok(
      r.stdout.trim().length > 0,
      'Hermes reads empty stdout as "no action" — the block must be written',
    );
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.decision, 'block');
    assert.match(String(parsed.reason), /ENGINE_ERROR/);
  });
});
