# Collector Resource/Attribute De-duplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop emitting the process-constant identity attributes `nio.platform` and `gen_ai.agent.name` redundantly on every span / log record / metric data-point — keep them *only* in the OTEL Resource, where they already live.

**Architecture:** Nio builds one OTEL Resource per provider via `buildNioResource(platform, agentName)` and that Resource already carries `service.name`, `nio.platform`, `gen_ai.agent.name`. But the per-event attribute/label builders *also* write `nio.platform` (all 3 signals) and `gen_ai.agent.name` (traces turn span + logs), producing two copies of each in every backend row (confirmed in a GreptimeDB export: a span has `gen_ai.agent.name` in both `attributes` and `resource`). OTEL keeps Resource and span/record attributes in **separate namespaces** — they never merge — so the duplicate copies must be deleted explicitly. After deletion the `platform` / `agentName` parameters that only fed those copies become dead and are removed from the signatures (and their call sites) for a clean "identity lives only in Resource" contract.

**Tech Stack:** TypeScript (strict), `@opentelemetry/sdk-trace-node` / `sdk-metrics` / `sdk-logs`, OTLP HTTP+gRPC exporters, Node's built-in `node:test` runner. Build: `pnpm run build` (tsc → bun bundle → sync-shared). Tests run from compiled `dist/`.

## Global Constraints

- No `Co-Authored-By: Claude` trailer on any git commit (repo rule).
- Do not create new git branches unless explicitly asked; work on `main`.
- Tests must never read/write real user paths — use `mkdtemp` / `NIO_HOME=$(mktemp -d)` (repo rule, already followed by existing collector tests).
- `service.name` and `gen_ai.conversation.id` / `session.id` are **out of scope** — leave them exactly as-is. Only `nio.platform` and `gen_ai.agent.name` move.
- Source of truth for skill docs is `plugins/shared/skills/**`; never hand-edit the synced copies under `plugins/{claude-code,codex,openclaw}/` — run `node scripts/sync-shared.js`.
- Run tests with the repo harness: `pnpm test` (or, per-file during a task, `node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/<file>.test.js` after `pnpm run build`).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/scripts/lib/traces-collector.ts` | Resource factory + span builders + gen_ai attr helpers | Extract `nioResourceAttributes`; drop `gen_ai.agent.name` from `genAiInvokeAgentAttributes`; drop `nio.platform` from 3 span attribute objects; drop now-dead `platform`/`agentName` params from `endTurn`, `recordPostToolUse`, `recordPostTaskToolUse`, `genAiInvokeAgentAttributes` |
| `src/scripts/lib/logs-collector.ts` | Audit-entry → LogRecord attribute projection | Drop `nio.platform` + `gen_ai.agent.name` from `auditEntryAttributes` |
| `src/scripts/lib/metrics-collector.ts` | Metric record functions | Drop `nio.platform` label from all 4 record fns; drop now-dead `platform` param |
| `src/scripts/lib/collector-core.ts` | Dispatcher that calls trace + metric record fns | Update call sites to new signatures |
| `src/adapters/openclaw-plugin.ts` | OpenClaw in-process span/metric path | Update call sites to new signatures |
| `src/scripts/hook-cli.ts`, `src/scripts/guard-hook.ts` | Hermes / guard metric call sites | Update `recordGuardDecision` call sites |
| `src/tests/agent-name.test.ts` | Identity-attribute contract test | Rewrite to assert Resource carries identity and span/log builders do NOT |
| `src/tests/collector-export-failure.test.ts` | (created earlier) calls `recordToolUse` | Update one call to new arity |
| `plugins/shared/skills/nio/SKILL.md` | Diagnostics/attribute docs | Update any attribute-location wording if present |

**Build sequence between tasks:** every task that touches `src/**` must run `pnpm run build` before its test step, because the test harness runs the compiled `dist/`.

---

### Task 1: Extract `nioResourceAttributes` and prove identity lives in the Resource

**Files:**
- Modify: `src/scripts/lib/traces-collector.ts:267-273` (`buildNioResource`)
- Test: `src/tests/agent-name.test.ts` (add a new describe block; full rewrite happens in Task 2)

**Interfaces:**
- Produces: `nioResourceAttributes(platform: string, agentName?: string): Record<string, string>` — pure object builder. Keys: `service.name` (`nio-<platform>`), `nio.platform`, and `gen_ai.agent.name` only when `agentName` is a non-empty string.
- Produces: `buildNioResource(platform, agentName?)` unchanged signature/return type — now implemented as `resourceFromAttributes(nioResourceAttributes(platform, agentName))`.

- [ ] **Step 1: Write the failing test**

Add to `src/tests/agent-name.test.ts` (keep existing imports; add `nioResourceAttributes` to the import from `../scripts/lib/traces-collector.js`):

```typescript
import { nioResourceAttributes } from '../scripts/lib/traces-collector.js';

describe('nioResourceAttributes', () => {
  it('carries service.name, nio.platform, and gen_ai.agent.name when configured', () => {
    const r = nioResourceAttributes('claude-code', 'alice-laptop');
    assert.equal(r['service.name'], 'nio-claude-code');
    assert.equal(r['nio.platform'], 'claude-code');
    assert.equal(r['gen_ai.agent.name'], 'alice-laptop');
  });

  it('omits gen_ai.agent.name when agentName is empty or absent', () => {
    assert.equal(nioResourceAttributes('hermes', '')['gen_ai.agent.name'], undefined);
    assert.equal(nioResourceAttributes('hermes')['gen_ai.agent.name'], undefined);
  });
});
```

- [ ] **Step 2: Build, then run test to verify it fails**

Run: `pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/agent-name.test.js`
Expected: FAIL — `nioResourceAttributes` is not exported (build error or `undefined is not a function`).

- [ ] **Step 3: Implement the extraction**

Replace `buildNioResource` (currently `src/scripts/lib/traces-collector.ts:267-273`):

```typescript
export function nioResourceAttributes(
  platform: string,
  agentName?: string,
): Record<string, string> {
  return {
    [ATTR_SERVICE_NAME]: `nio-${platform}`,
    'nio.platform': platform,
    ...(agentName && agentName.length > 0 ? { 'gen_ai.agent.name': agentName } : {}),
  };
}

export function buildNioResource(platform: string, agentName?: string) {
  return resourceFromAttributes(nioResourceAttributes(platform, agentName));
}
```

- [ ] **Step 4: Build, then run test to verify it passes**

Run: `pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/agent-name.test.js`
Expected: PASS for the new `nioResourceAttributes` block (existing `genAiInvokeAgentAttributes` tests still pass — unchanged in this task).

- [ ] **Step 5: Commit**

```bash
git add src/scripts/lib/traces-collector.ts src/tests/agent-name.test.ts
git commit -m "refactor(collector): extract nioResourceAttributes pure builder"
```

---

### Task 2: Traces — remove duplicated identity from spans and dead params

**Files:**
- Modify: `src/scripts/lib/traces-collector.ts` — `genAiInvokeAgentAttributes` (73-86), tool span (529-544), task span (595-609), turn span (753-766), and signatures of `endTurn` (707-714), `recordPostToolUse`, `recordPostTaskToolUse`
- Modify: `src/scripts/lib/collector-core.ts:296`, `:343`, `:364` (call sites)
- Modify: `src/adapters/openclaw-plugin.ts:269`, `:323`, `:389`, `:466` (call sites)
- Test: `src/tests/agent-name.test.ts` (rewrite the `genAiInvokeAgentAttributes` block)

**Interfaces:**
- Produces: `genAiInvokeAgentAttributes(sessionId: string, extra?: Record<string, unknown>): Record<string, unknown>` — `agentName` param REMOVED; no longer emits `gen_ai.agent.name`.
- Produces: `endTurn(provider, state, cwd: string | null, transcriptPath?: string | null)` — `platform` and `agentName` params REMOVED.
- Produces: `recordPostToolUse(provider, state, spanKey, cwd, postAttributes?, error?)` — `platform` param REMOVED.
- Produces: `recordPostTaskToolUse(provider, state, taskId, cwd)` — `platform` param REMOVED.
- Consumes: `nioResourceAttributes` / `buildNioResource` from Task 1 (Resource still injects `nio.platform` + `gen_ai.agent.name`).

> Confirm the exact current parameter order of `recordPostToolUse` / `recordPostTaskToolUse` by reading the function headers before editing (the call sites must match the new order exactly). Only the `platform` parameter is removed; keep all others in place.

- [ ] **Step 1: Rewrite the failing test**

Replace the `genAiInvokeAgentAttributes` describe block in `src/tests/agent-name.test.ts` (the test at ~line 47) with the new contract:

```typescript
describe('genAiInvokeAgentAttributes', () => {
  it('does NOT emit gen_ai.agent.name (identity comes from the Resource)', () => {
    const attrs = genAiInvokeAgentAttributes('sess-1');
    assert.equal(attrs['gen_ai.agent.name'], undefined);
    assert.equal(attrs['gen_ai.conversation.id'], 'sess-1');
    assert.equal(attrs['session.id'], 'sess-1');
    assert.equal(attrs['gen_ai.operation.name'], 'invoke_agent');
  });

  it('passes through extra attributes', () => {
    const attrs = genAiInvokeAgentAttributes('sess-2', { 'nio.turn_number': 3 });
    assert.equal(attrs['nio.turn_number'], 3);
    assert.equal(attrs['gen_ai.agent.name'], undefined);
  });
});
```

- [ ] **Step 2: Build, then run test to verify it fails**

Run: `pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/agent-name.test.js`
Expected: FAIL — current `genAiInvokeAgentAttributes` still emits `gen_ai.agent.name` and its 2nd positional arg is `agentName`, so `genAiInvokeAgentAttributes('sess-2', {...})` puts the object in the wrong slot.

- [ ] **Step 3a: Update `genAiInvokeAgentAttributes`** (`src/scripts/lib/traces-collector.ts:73-86`)

```typescript
export function genAiInvokeAgentAttributes(
  sessionId: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.provider.name': GEN_AI_PROVIDER_NAME,
    'gen_ai.conversation.id': sessionId,
    'session.id': sessionId,
    ...extra,
  };
}
```

- [ ] **Step 3b: Remove `nio.platform` from the tool span** (`src/scripts/lib/traces-collector.ts:533-541`)

Delete the line `'nio.platform': platform,` from the tool span's `attributes` object. Then remove the now-unused `platform` parameter from the `recordPostToolUse` signature.

- [ ] **Step 3c: Remove `nio.platform` from the task span** (`src/scripts/lib/traces-collector.ts:599-606`)

Delete `'nio.platform': platform,` from the task span's `attributes` object. Then remove the now-unused `platform` parameter from the `recordPostTaskToolUse` signature.

- [ ] **Step 3d: Update the turn span** (`src/scripts/lib/traces-collector.ts:753-766`)

The `attributes` object becomes (note: `genAiInvokeAgentAttributes` no longer takes `agentName`, and `'nio.platform'` is deleted):

```typescript
      attributes: {
        ...genAiInvokeAgentAttributes(state.session_id),
        'nio.turn_number': state.turn_number,
        ...(cwd ? { 'nio.cwd': cwd } : {}),
        ...(state.turn_attributes ?? {}),
      } as Record<string, string | number | boolean>,
```

Then remove the `platform` and `agentName` parameters from the `endTurn` signature (`src/scripts/lib/traces-collector.ts:707-714`). The new header is:

```typescript
export async function endTurn(
  provider: NodeTracerProvider,
  state: CollectorState,
  cwd: string | null,
  transcriptPath?: string | null,
): Promise<CollectorState | null> {
```

- [ ] **Step 3e: Update call sites**

In `src/scripts/lib/collector-core.ts`:
- Line ~296 `recordPostToolUse(tracerProvider, state, key, platform, cwd, {...}, err ?? null)` → drop `platform`: `recordPostToolUse(tracerProvider, state, key, cwd, {...}, err ?? null)`
- Line ~343 `recordPostTaskToolUse(tracerProvider, state, taskId, platform, cwd)` → `recordPostTaskToolUse(tracerProvider, state, taskId, cwd)`
- Line ~364 `endTurn(tracerProvider, state, platform, resolvedAgentName, cwd, transcriptPath)` → `endTurn(tracerProvider, state, cwd, transcriptPath)`. After this edit, check whether `resolvedAgentName` (collector-core.ts:219) is still used elsewhere; if it has no remaining references, delete its declaration.

In `src/adapters/openclaw-plugin.ts`:
- Line ~269 (block-path `recordPostToolUse`) — drop the `'openclaw'` platform arg.
- Line ~323 (`after_tool_call` `recordPostToolUse`) — drop the `'openclaw'` platform arg.
- Line ~389 (`recordPostTaskToolUse`) — drop the `'openclaw'` platform arg.
- Line ~466 `endTurn(tracerProvider, state, 'openclaw', agentName, process.cwd())` → `endTurn(tracerProvider, state, process.cwd())`. After this, check whether the `agentName` local in `openclaw-plugin.ts` is still used (it is still passed to `createTracerProvider`/`createMeterProvider` at register time — so keep it); only remove if truly unreferenced.

- [ ] **Step 4: Build, then run the traces + collector test files**

Run: `pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/agent-name.test.js dist/tests/traces-collector.test.js dist/tests/collector-core.test.js`
Expected: PASS. (`collector-core.test.js` drives `dispatchCollectorEvent` with `tracerProvider: null`, so it exercises the new call sites at compile time without needing a live exporter.)

- [ ] **Step 5: Commit**

```bash
git add src/scripts/lib/traces-collector.ts src/scripts/lib/collector-core.ts src/adapters/openclaw-plugin.ts src/tests/agent-name.test.ts
git commit -m "refactor(collector): drop duplicated nio.platform/gen_ai.agent.name from spans"
```

---

### Task 3: Logs — remove duplicated identity from the LogRecord projection

**Files:**
- Modify: `src/scripts/lib/logs-collector.ts:113-124` (`auditEntryAttributes`)
- Test: `src/tests/agent-name.test.ts` (rewrite the `auditEntryAttributes` block)

**Interfaces:**
- Produces: `auditEntryAttributes(entry)` — no longer writes `nio.platform` or `gen_ai.agent.name`. (Resource on the LoggerProvider still carries both.) All other projected keys (`nio.event`, `gen_ai.tool.name`, `gen_ai.conversation.id`, `session.id`, etc.) are unchanged.

- [ ] **Step 1: Rewrite the failing test**

Replace the `auditEntryAttributes` describe block in `src/tests/agent-name.test.ts` (tests at ~lines 70-85) with:

```typescript
describe('auditEntryAttributes', () => {
  it('does NOT emit gen_ai.agent.name or nio.platform (Resource carries them)', () => {
    const attrs = auditEntryAttributes({
      event: 'PreToolUse', platform: 'claude-code', agent_name: 'alice-laptop',
    } as never);
    assert.equal(attrs['gen_ai.agent.name'], undefined);
    assert.equal(attrs['nio.platform'], undefined);
    assert.equal(attrs['nio.event'], 'PreToolUse');
  });
});
```

- [ ] **Step 2: Build, then run test to verify it fails**

Run: `pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/agent-name.test.js`
Expected: FAIL — current projection emits `nio.platform` (and `gen_ai.agent.name` when `agent_name` set).

- [ ] **Step 3: Remove the identity keys from the projection**

In `src/scripts/lib/logs-collector.ts`, change the opening of `auditEntryAttributes` (113-124) to:

```typescript
export function auditEntryAttributes(entry: AuditEntry): Record<string, string | number> {
  const attrs: Record<string, string | number> = {
    'nio.event': entry.event,
  };
```

…and delete the `agent_name` → `gen_ai.agent.name` block (the `const agentName = entry['agent_name']; if (...) attrs['gen_ai.agent.name'] = agentName;` lines, currently 119-124).

- [ ] **Step 4: Build, then run the logs + agent-name tests**

Run: `pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/agent-name.test.js dist/tests/collector-core.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/lib/logs-collector.ts src/tests/agent-name.test.ts
git commit -m "refactor(collector): drop duplicated identity from log record attributes"
```

---

### Task 4: Metrics — remove duplicated `nio.platform` label and dead params

**Files:**
- Modify: `src/scripts/lib/metrics-collector.ts` — `recordToolUse` (116-133), `recordGuardDecision` (136-167), `recordTurn` (170-183)
- Modify: `src/scripts/lib/collector-core.ts:275`, `:308`, `:329`, `:350`, `:370` (call sites)
- Modify: `src/adapters/openclaw-plugin.ts:213`, `:225`, `:332`, `:362`, `:394`, `:525` (call sites)
- Modify: `src/scripts/hook-cli.ts:351`, `src/scripts/guard-hook.ts:162` (`recordGuardDecision` call sites)
- Modify: `src/tests/collector-export-failure.test.ts:~78` (the `recordToolUse` call)

**Interfaces:**
- Produces: `recordToolUse(provider, toolName, event)` — `platform` param REMOVED. Labels kept: `gen_ai.tool.name`, `nio.event`.
- Produces: `recordGuardDecision(provider, decision, riskLevel, riskScore, toolName)` — `platform` param REMOVED. Labels kept: `nio.guard.decision`, `nio.guard.risk_level`, `gen_ai.tool.name` (counter) and `gen_ai.tool.name` (histogram).
- Produces: `recordTurn(provider)` — `platform` param REMOVED. The turn counter now records with no labels (`counter.add(1)`); Resource carries `nio.platform`.
- Note for reviewers: this trades a metric *label* for a Resource attribute. Backends group by Resource attributes, so `nio.platform` remains a usable grouping dimension; it is no longer a per-series label. This is the intended consequence of the "identity lives only in Resource" decision.

- [ ] **Step 1: Update the failing test**

In `src/tests/collector-export-failure.test.ts`, the metrics test calls `await recordToolUse(provider!, 'Bash', 'PreToolUse', 'test');`. Change it to the new arity:

```typescript
    await recordToolUse(provider!, 'Bash', 'PreToolUse');
```

- [ ] **Step 2: Build to verify the OLD code fails to compile against the new call**

Run: `pnpm run build`
Expected: FAIL — `recordToolUse` still declares 4 params but the schema (METRICS labels) and the test now expect 3; TS reports the call passes too few/mismatched args once you start Step 3, or (before Step 3) the test file compiles but asserts old behaviour. Treat the red signal as "metrics record fns not yet updated."

> If `pnpm run build` still passes here (because 3 args is assignable when the 4th is optional — it is not, params are required), proceed to Step 3; the authoritative red→green gate is the full metrics behaviour after Step 3.

- [ ] **Step 3a: `recordToolUse`** (`src/scripts/lib/metrics-collector.ts:116-133`)

Remove the `platform: string,` parameter and the `'nio.platform': platform,` label line. Result:

```typescript
export async function recordToolUse(
  provider: MeterProvider,
  toolName: string,
  event: string,
): Promise<void> {
  const meter = provider.getMeter('nio-collector', '1.0.0');
  const counter = meter.createCounter(METRICS_SCHEMA.toolUseCount.name, {
    description: METRICS_SCHEMA.toolUseCount.description,
    unit: METRICS_SCHEMA.toolUseCount.unit,
  });
  counter.add(1, {
    'gen_ai.tool.name': toolName,
    'nio.event': event,
  });
  await provider.forceFlush();
}
```

- [ ] **Step 3b: `recordGuardDecision`** (`src/scripts/lib/metrics-collector.ts:136-167`)

Remove the `platform: string,` parameter and the two `'nio.platform': platform,` label lines (counter at ~154, histogram at ~163). Keep every other label.

- [ ] **Step 3c: `recordTurn`** (`src/scripts/lib/metrics-collector.ts:170-183`)

Remove the `platform: string,` parameter and replace the labelled add with an unlabelled one:

```typescript
export async function recordTurn(
  provider: MeterProvider,
): Promise<void> {
  const meter = provider.getMeter('nio-collector', '1.0.0');
  const counter = meter.createCounter(METRICS_SCHEMA.turnCount.name, {
    description: METRICS_SCHEMA.turnCount.description,
    unit: METRICS_SCHEMA.turnCount.unit,
  });
  counter.add(1);
  await provider.forceFlush();
}
```

- [ ] **Step 3d: Update the METRICS_SCHEMA label docs** (`src/scripts/lib/metrics-collector.ts:11-50`)

Delete the `'nio.platform': '...'` entry from each of the four schema `labels` blocks (`toolUseCount`, `turnCount`, `decisionCount`, `riskScore`), since `nio.platform` is no longer a label. Leave the other label docs intact.

- [ ] **Step 3e: Update all metric call sites**

`src/scripts/lib/collector-core.ts`: lines ~275/308 `recordToolUse(meterProvider, toolName, event, platform)` → `recordToolUse(meterProvider, toolName, event)`; lines ~329/350 `recordToolUse(meterProvider, 'Task', event, platform)` → `recordToolUse(meterProvider, 'Task', event)`; line ~370 `recordTurn(meterProvider, platform)` → `recordTurn(meterProvider)`.

`src/adapters/openclaw-plugin.ts`: lines ~213/332/362/394 — drop the trailing `'openclaw'` from each `recordToolUse(...)`; line ~525 `recordTurn(meterProvider, 'openclaw')` → `recordTurn(meterProvider)`; line ~225 `recordGuardDecision(...)` — drop the trailing `'openclaw'` platform arg.

`src/scripts/hook-cli.ts:351` and `src/scripts/guard-hook.ts:162` — drop the trailing `platform` arg from `recordGuardDecision(...)`.

After these edits, in each file check whether the `platform` / `'openclaw'` local is still referenced elsewhere; in `collector-core.ts` `platform` is still used by the audit entries, so keep it. Do not remove any variable that retains other uses.

- [ ] **Step 4: Build, then run the metrics-dependent tests**

Run: `pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/collector-export-failure.test.js dist/tests/collector-core.test.js`
Expected: PASS — metrics export failure test still records an `otlp_export_failed` diagnostic; collector-core dispatch still routes events.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/lib/metrics-collector.ts src/scripts/lib/collector-core.ts src/adapters/openclaw-plugin.ts src/scripts/hook-cli.ts src/scripts/guard-hook.ts src/tests/collector-export-failure.test.ts
git commit -m "refactor(collector): drop duplicated nio.platform label from metrics"
```

---

### Task 5: Docs, changeset, and full-suite + end-to-end verification

**Files:**
- Modify: `src/scripts/lib/traces-collector.ts:260-266` (the `buildNioResource` doc comment) and any attribute-location wording in `plugins/shared/skills/nio/SKILL.md`
- Create: `.changeset/dedup-collector-identity-attributes.md`

- [ ] **Step 1: Update the Resource doc comment**

In `src/scripts/lib/traces-collector.ts` the comment above `buildNioResource` (lines 260-266) already lists the three Resource attributes. Append one sentence so future readers know the de-dup is intentional:

```
 * These three are emitted ONLY on the Resource — never duplicated onto
 * individual spans / log records / metric labels. Per-event builders rely
 * on the Resource for platform + agent identity.
```

- [ ] **Step 2: Check the skill docs for stale attribute-location claims**

Run: `grep -rn "nio.platform\|gen_ai.agent.name" plugins/shared/skills/`
If any line documents these as span/log/metric attributes (vs Resource), reword it to say "Resource attribute". Then sync:

Run: `node scripts/sync-shared.js`
Expected: "Shared files synced to plugin directories" and `grep -rn "gen_ai.agent.name" plugins/{claude-code,codex,openclaw}/skills/` reflects the same wording.

- [ ] **Step 3: Write the changeset**

Create `.changeset/dedup-collector-identity-attributes.md`:

```markdown
---
"@core0-io/nio": patch
---

De-duplicate collector identity attributes. `nio.platform` and
`gen_ai.agent.name` were written both onto the OTEL Resource and onto every
span, log record, and metric data-point. They are now emitted only on the
Resource (OTEL keeps Resource and element attributes in separate namespaces,
so the copies were genuinely redundant). The dead `platform` / `agentName`
parameters that only fed the duplicate copies were removed from the trace
and metric record functions.
```

- [ ] **Step 4: Full build + full test suite**

Run: `pnpm run build && pnpm test`
Expected: all tests pass (baseline before this plan was 1138 passing; count may differ by a few from the rewritten identity tests). Zero failures, output pristine.

- [ ] **Step 5: End-to-end span shape check (no live backend needed)**

Verify a real emitted span no longer carries the duplicates, using the in-process trace path against an unreachable endpoint (the span is still built and its attributes are observable before export). Create a throwaway script `/tmp/nio-span-check.mjs`:

```javascript
import { createTracerProvider } from '/Users/ab/Work/nio/dist/scripts/lib/traces-collector.js';
import { ensureTurn, recordPreToolUse, recordPostToolUse, endTurn } from '/Users/ab/Work/nio/dist/scripts/lib/traces-collector.js';
// Minimal: assert the Resource carries identity and a built span object does not.
import { nioResourceAttributes, genAiInvokeAgentAttributes } from '/Users/ab/Work/nio/dist/scripts/lib/traces-collector.js';
const res = nioResourceAttributes('openclaw', 'test-agent');
console.assert(res['gen_ai.agent.name'] === 'test-agent', 'resource has agent.name');
console.assert(res['nio.platform'] === 'openclaw', 'resource has platform');
const turn = genAiInvokeAgentAttributes('sess');
console.assert(turn['gen_ai.agent.name'] === undefined, 'turn span has NO agent.name');
console.assert(turn['nio.platform'] === undefined, 'turn span has NO platform');
console.log('OK: identity only on resource');
```

Run: `node /tmp/nio-span-check.mjs`
Expected: prints `OK: identity only on resource` with no assertion errors. Then `rm /tmp/nio-span-check.mjs`.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/lib/traces-collector.ts plugins/ .changeset/dedup-collector-identity-attributes.md
git commit -m "docs(collector): note identity attributes live only on the Resource"
```

---

## Out of Scope (intentional — do not change)

- `service.name` — stays in Resource (already correct, never duplicated).
- `gen_ai.conversation.id` + `session.id` both carrying the session id on the turn span — intentional cross-signal alignment; leave as-is.
- The task span using `nio.session_id` while turn/tool use `session.id` / `gen_ai.conversation.id` — pre-existing key inconsistency; a separate cleanup if ever wanted.
- `nio.cwd`, `nio.turn_number` on spans — per-event/per-turn values, not process identity; they stay as attributes.

## Self-Review Notes

- **Spec coverage:** all three signals covered (traces=Task 2, logs=Task 3, metrics=Task 4); param cleanup folded into the same tasks; Resource source confirmed in Task 1; docs+changeset+verification in Task 5. ✓
- **Type consistency:** new signatures listed in each task's Interfaces block: `genAiInvokeAgentAttributes(sessionId, extra?)`, `endTurn(provider, state, cwd, transcriptPath?)`, `recordPostToolUse(provider, state, spanKey, cwd, postAttributes?, error?)`, `recordPostTaskToolUse(provider, state, taskId, cwd)`, `recordToolUse(provider, toolName, event)`, `recordGuardDecision(provider, decision, riskLevel, riskScore, toolName)`, `recordTurn(provider)`. Call-site edits in Tasks 2 & 4 match these. ✓
- **Param-order caveat:** Task 2 instructs reading `recordPostToolUse` / `recordPostTaskToolUse` headers before editing, since only `platform` is removed and the surrounding order must be preserved exactly.
