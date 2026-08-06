// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Every adapter's boundary must be TOTAL over unvalidated host input.
 *
 * ── The defect class ──────────────────────────────────────────────────
 *
 * `HookAdapter.parseInput` takes `unknown` by signature and then reads it
 * through `as string` casts. Nothing between the host and here checks a
 * type: the payload is `JSON.parse`d stdin (Claude Code / Codex / Hermes)
 * or a live host object (OpenClaw / Pi / opencode, which run Nio
 * in-process). So `hook_event_name`, `tool_name` and every `tool_input`
 * field can be a number, `null`, an array, a nested object or an empty
 * string at runtime — and three kinds of site then called a string method
 * on them:
 *
 *   parseInput      `hookEvent.startsWith('Post')`
 *   checkToolGate   `parseMcpToolName`'s `name.startsWith('mcp__')`,
 *                   `matchesCaseInsensitive`'s `c.toLowerCase()`,
 *                   Hermes/OpenClaw's prefix-matching `mapToolToActionType`
 *   buildEnvelope   `content.slice(0, 10_000)`
 *
 * All three run inside `evaluateHook`, which has NO catch around them —
 * its only try/catch wraps the Phase 1-6 orchestrator. A throw therefore
 * propagates out of `evaluateHook`, past `main()` in the hook scripts,
 * and kills the process. Both host contracts read a dead hook as "no
 * action taken": Claude Code's exit 1 is its NON-blocking error code and
 * Hermes treats missing stdout the same way. The end-to-end proof of that
 * consequence lives in guard-decision-survives-malformed-payload.test.ts;
 * this file pins the boundary itself, per adapter, without spawning.
 *
 * MUTATION: revert any `asText(...)` in an adapter's `parseInput` or
 * `buildEnvelope` to its old `(x as string) || ''` form — the matching
 * generated case below throws instead of returning.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { CodexAdapter } from '../adapters/codex.js';
import { HermesAdapter } from '../adapters/hermes.js';
import { OpenClawAdapter } from '../adapters/openclaw.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import { PiAdapter } from '../adapters/pi.js';
import { buildGuardAuditEntry, asText } from '../adapters/common.js';
import type { HookAdapter, HookInput } from '../adapters/types.js';

/**
 * The type zoo, one entry per shape the acceptance criteria name.
 *
 * `''` and the long string are in here for a reason beyond completeness:
 * they are the two values a coercion is most likely to get WRONG in the
 * other direction — collapsing `''` into a placeholder would change which
 * branch a `|| fallback` takes, and truncating a long value at the
 * boundary would silently shrink what the analysers see.
 */
const LONG = 'x'.repeat(300_000);
const MALFORMED: ReadonlyArray<readonly [string, unknown]> = [
  ['number', 12345],
  ['zero', 0],
  ['boolean', true],
  ['null', null],
  ['array', ['rm', '-rf', '/']],
  ['nested object', { argv: { deep: ['a'] } }],
  ['empty string', ''],
  ['long string', LONG],
  ['lone surrogate', '\uD800'],
];

/**
 * How each adapter names the same three things. `writeTool` must map to
 * `write_file` under the adapter's DEFAULT native mapping, because the
 * `content.slice` site only exists on that branch.
 */
interface AdapterCase {
  name: string;
  make: () => HookAdapter;
  /** Build a raw host payload with these fields set. */
  raw: (fields: {
    event?: unknown; tool?: unknown; input?: Record<string, unknown>;
  }) => unknown;
  execTool: string;
  writeTool: string;
  /** Field name the write tool reads its body from. */
  contentField: string;
  /** Field name the write tool reads its path from. */
  pathField: string;
  /** Whether this adapter reads `hook_event_name` at all. */
  readsEventName: boolean;
  /** Tool mapping to `read_file`, when the adapter has one. */
  readTool?: string;
  /** Tool mapping to `network_request`, when the adapter has one. */
  netTool?: string;
  /** Field name the network tool reads its URL from. */
  urlField?: string;
}

const ADAPTERS: readonly AdapterCase[] = [
  {
    name: 'claude-code',
    make: () => new ClaudeCodeAdapter(),
    raw: ({ event, tool, input }) => ({
      hook_event_name: event, tool_name: tool, tool_input: input ?? {},
    }),
    execTool: 'Bash', writeTool: 'Write',
    contentField: 'content', pathField: 'file_path', readsEventName: true,
    netTool: 'WebFetch', urlField: 'url',
  },
  {
    name: 'codex',
    make: () => new CodexAdapter({
      nativeToolMapping: { Bash: 'exec_command', Write: 'write_file', WebFetch: 'network_request' },
    }),
    raw: ({ event, tool, input }) => ({
      hook_event_name: event, tool_name: tool, tool_input: input ?? {},
    }),
    execTool: 'Bash', writeTool: 'Write',
    contentField: 'content', pathField: 'file_path', readsEventName: true,
    netTool: 'WebFetch', urlField: 'url',
  },
  {
    name: 'hermes',
    make: () => new HermesAdapter(),
    raw: ({ event, tool, input }) => ({
      hook_event_name: event, tool_name: tool, tool_input: input ?? {},
    }),
    execTool: 'terminal', writeTool: 'write_file',
    contentField: 'content', pathField: 'path', readsEventName: true,
    readTool: 'read_file', netTool: 'fetch', urlField: 'url',
  },
  {
    name: 'openclaw',
    make: () => new OpenClawAdapter(),
    raw: ({ tool, input }) => ({ toolName: tool, params: input ?? {} }),
    execTool: 'exec', writeTool: 'write',
    contentField: 'content', pathField: 'path', readsEventName: false,
    readTool: 'read', netTool: 'web_fetch', urlField: 'url',
  },
  {
    name: 'opencode',
    make: () => new OpenCodeAdapter(),
    raw: ({ tool, input }) => ({ tool, args: input ?? {} }),
    execTool: 'bash', writeTool: 'write',
    contentField: 'content', pathField: 'filePath', readsEventName: false,
    readTool: 'read', netTool: 'webfetch', urlField: 'url',
  },
  {
    name: 'pi',
    make: () => new PiAdapter(),
    raw: ({ tool, input }) => ({ toolName: tool, input: input ?? {} }),
    execTool: 'bash', writeTool: 'write',
    contentField: 'content', pathField: 'path', readsEventName: false,
    readTool: 'read',
  },
];

describe('asText', () => {
  it('passes strings through byte-identically, including empty and lone surrogates', () => {
    assert.equal(asText(''), '');
    assert.equal(asText('\uD800'), '\uD800');
    assert.equal(asText(LONG), LONG);
    assert.equal(asText('ls /tmp'), 'ls /tmp');
  });

  it('maps null and undefined to the empty string so `|| fallback` still fires', () => {
    assert.equal(asText(null), '');
    assert.equal(asText(undefined), '');
  });

  it('serialises objects and arrays instead of producing [object Object]', () => {
    assert.equal(asText({ a: 1 }), '{"a":1}');
    assert.equal(asText(['rm', '-rf', '/']), '["rm","-rf","/"]');
  });

  it('stringifies scalars', () => {
    assert.equal(asText(12345), '12345');
    assert.equal(asText(0), '0');
    assert.equal(asText(true), 'true');
  });

  it('degrades a circular value to the empty string rather than throwing', () => {
    const circular: Record<string, unknown> = { name: 'x' };
    circular['self'] = circular;
    assert.equal(asText(circular), '');
  });

  it('degrades a value whose own String() throws', () => {
    // The non-object branch's catch. Reachable, not decoration: `typeof`
    // a proxied function is 'function', not 'object', so it skips the
    // JSON.stringify branch and `String()` runs the proxy's get trap.
    // The in-process runtimes (OpenClaw / Pi / opencode) hand the
    // adapters live host objects, proxies included.
    const hostile = new Proxy(function noop() { /* */ }, {
      get() { throw new Error('hostile host object'); },
    });
    assert.equal(asText(hostile), '');
  });
});

for (const a of ADAPTERS) {
  describe(`${a.name} adapter is total over malformed host input`, () => {
    if (a.readsEventName) {
      for (const [label, value] of MALFORMED) {
        it(`parseInput survives a ${label} hook_event_name`, () => {
          const parsed = a.make().parseInput(
            a.raw({ event: value, tool: a.execTool, input: { command: 'ls' } }),
          );
          // Nothing but a literal Post*/post_* prefix may mean "post".
          assert.equal(parsed.eventType, 'pre');
        });
      }
    }

    for (const [label, value] of MALFORMED) {
      it(`parseInput yields a string toolName for a ${label} tool_name`, () => {
        const parsed = a.make().parseInput(a.raw({ event: 'PreToolUse', tool: value }));
        assert.equal(
          typeof parsed.toolName, 'string',
          'downstream reads call .startsWith / .toLowerCase on this',
        );
      });
    }

    for (const [label, value] of MALFORMED) {
      it(`buildEnvelope survives a ${label} write body`, () => {
        const adapter = a.make();
        const parsed = adapter.parseInput(a.raw({
          event: 'PreToolUse',
          tool: a.writeTool,
          input: { [a.pathField]: '/tmp/nio-totality-fixture', [a.contentField]: value },
        }));
        const envelope = adapter.buildEnvelope(parsed, null);
        assert.ok(envelope, `${a.writeTool} must map to write_file for this adapter`);
        const data = envelope.action.data as { path?: string; content_preview?: string };
        assert.equal(typeof data.content_preview, 'string');
        assert.equal(typeof data.path, 'string');
        // The 10 000-char cap still applies — coercion must not remove it.
        assert.ok((data.content_preview ?? '').length <= 10_000);
      });

      it(`buildEnvelope survives a ${label} command`, () => {
        const adapter = a.make();
        const parsed = adapter.parseInput(a.raw({
          event: 'PreToolUse', tool: a.execTool, input: { command: value },
        }));
        const envelope = adapter.buildEnvelope(parsed, null);
        assert.ok(envelope, `${a.execTool} must map to exec_command for this adapter`);
        const data = envelope.action.data as { command?: string };
        assert.equal(typeof data.command, 'string');
      });

      it(`buildEnvelope survives a ${label} write path`, () => {
        // `FileOperationData.path` is not merely stringified downstream:
        // `isSensitivePath` calls `.replace` on it and the orchestrator
        // hands it to Phase 3/4 as `phase34Path`, which is regex-tested
        // for an executable extension. Those throws land in the
        // orchestrator's own catch, which fails OPEN — so a non-string
        // path turned a SENSITIVE_PATH deny into a silent allow.
        const adapter = a.make();
        const parsed = adapter.parseInput(a.raw({
          event: 'PreToolUse',
          tool: a.writeTool,
          input: { [a.pathField]: value, [a.contentField]: 'x' },
        }));
        const data = adapter.buildEnvelope(parsed, null)!.action.data as { path?: string };
        assert.equal(typeof data.path, 'string');
      });

      if (a.readTool) {
        it(`buildEnvelope survives a ${label} read path`, () => {
          const adapter = a.make();
          const parsed = adapter.parseInput(a.raw({
            event: 'PreToolUse', tool: a.readTool!, input: { [a.pathField]: value },
          }));
          const data = adapter.buildEnvelope(parsed, null)!.action.data as { path?: string };
          assert.equal(typeof data.path, 'string');
        });
      }

      if (a.netTool) {
        it(`buildEnvelope survives a ${label} url`, () => {
          const adapter = a.make();
          const parsed = adapter.parseInput(a.raw({
            event: 'PreToolUse', tool: a.netTool!, input: { [a.urlField!]: value },
          }));
          const data = adapter.buildEnvelope(parsed, null)!.action.data as { url?: string };
          assert.equal(typeof data.url, 'string');
        });
      }
    }

    it('keeps a well-formed payload byte-identical (control)', () => {
      const adapter = a.make();
      const parsed = adapter.parseInput(a.raw({
        event: 'PreToolUse', tool: a.execTool, input: { command: 'rm -rf /' },
      }));
      assert.equal(parsed.toolName, a.execTool);
      const envelope = adapter.buildEnvelope(parsed, null);
      assert.equal((envelope!.action.data as { command?: string }).command, 'rm -rf /');
    });

    it('a dangerous command survives coercion from an array of argv', () => {
      // Not just "does not throw": the analysers see the WORDS. Before
      // the fix an array reached `ExecCommandData.command` unchanged and
      // the first `.toLowerCase()` inside the orchestrator threw, which
      // `evaluateHook` catches as "engine error → fail open".
      const adapter = a.make();
      const parsed = adapter.parseInput(a.raw({
        event: 'PreToolUse', tool: a.execTool, input: { command: ['rm', '-rf', '/'] },
      }));
      const command = (adapter.buildEnvelope(parsed, null)!.action.data as { command?: string }).command!;
      assert.ok(command.includes('rm'), `expected the argv words to survive, got ${command}`);
    });
  });
}

describe('opencode apply_patch is total over a malformed patch body', () => {
  /**
   * `apply_patch` is the one write shape with NO `filePath`: the targets
   * are marker lines inside `patchText`, so `firstPatchTarget` splits it.
   * That is a second string method on the same unvalidated field, and it
   * only runs when `filePath` is absent — which is exactly the shape
   * apply_patch always has.
   *
   * MUTATION: restore `input.toolInput.patchText as string | undefined`
   * — these cases throw out of `firstPatchTarget`.
   */
  for (const [label, value] of MALFORMED) {
    it(`buildEnvelope survives a ${label} patchText`, () => {
      const adapter = new OpenCodeAdapter();
      const parsed = adapter.parseInput({ tool: 'apply_patch', args: { patchText: value } });
      const envelope = adapter.buildEnvelope(parsed, null);
      assert.ok(envelope);
      const data = envelope.action.data as { path?: string; content_preview?: string };
      assert.equal(typeof data.path, 'string');
      assert.equal(typeof data.content_preview, 'string');
    });
  }

  it('still extracts the first patch target from a well-formed body (control)', () => {
    const adapter = new OpenCodeAdapter();
    const parsed = adapter.parseInput({
      tool: 'apply_patch',
      args: { patchText: '*** Update File: /tmp/nio-fixture.ts\n@@\n-a\n+b\n' },
    });
    const data = adapter.buildEnvelope(parsed, null)!.action.data as { path?: string };
    assert.equal(data.path, '/tmp/nio-fixture.ts');
  });
});

describe('buildGuardAuditEntry is total over a live host object', () => {
  /**
   * The in-process runtimes (OpenClaw / Pi / opencode) hand the adapters
   * the host's own objects, which can be self-referential. This builder
   * runs on the Phase 0 deny path in `evaluateHook`, OUTSIDE any
   * try/catch, so a `JSON.stringify` throw here lost the deny itself.
   *
   * MUTATION: restore `JSON.stringify(toolInput).slice(0, 200)` in
   * `summariseToolInput` — this case throws.
   */
  it('summarises a circular tool_input instead of throwing', () => {
    const circular: Record<string, unknown> = { tool: 'x' };
    circular['self'] = circular;
    const input: HookInput = {
      toolName: 'exec', toolInput: circular, eventType: 'pre', raw: {},
    };
    const entry = buildGuardAuditEntry(input, null, null, 'openclaw');
    assert.equal(typeof entry.tool_input_summary, 'string');
  });

  it('still summarises a well-formed tool_input (control)', () => {
    const input: HookInput = {
      toolName: 'exec', toolInput: { command: 'ls /tmp' }, eventType: 'pre', raw: {},
    };
    assert.equal(
      buildGuardAuditEntry(input, null, null, 'openclaw').tool_input_summary,
      'ls /tmp',
    );
  });
});
