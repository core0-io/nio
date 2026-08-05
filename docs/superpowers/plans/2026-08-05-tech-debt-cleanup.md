# 技术债清理实施计划（Phase 5 + 6 + 高价值 deferred）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清掉 Phase 1 遗留的技术债与两处已确认的文档错误，让 Phase 3/4 在干净的代码库上开工。

**Architecture:** 六个彼此独立的小修，无共享状态、无先后依赖，可任意顺序执行。

**Tech Stack:** TypeScript / Node 18+ / node:test / OpenTelemetry SDK

**对应来源:** spec 的 Phase 5 与 Phase 6，加上 `.superpowers/sdd/2026-08-04-collector-monitor-gate/progress.md` 里 triage 为「后续处理」的高价值 deferred 项。

## Global Constraints

- 新文件以 `// Copyright 2026 core0-io` + `// SPDX-License-Identifier: Apache-2.0` 开头，紧跟 `export {};`
- 测试用 `node:test` + `node:assert/strict`，不引入新依赖
- 测试临时目录一律 `mkdtempSync`，**严禁**读写真实 `~/.nio/`、`~/.hermes/`
- spawn 子进程的测试必须带 `timeout`（本仓库有 CI 挂死前科）
- 遥测永不破坏宿主：新路径包 try/catch，失败走 `reportDiagnostic`
- guard 拦截能力与采集开关正交，任何改动不得影响 `evaluateHook` 的无条件执行
- 跑测试前 `pnpm run build`；`--import ./dist/tests/helpers/isolate-nio-home.js` 不能省
- 每个任务完成后跑全量 `pnpm test`，**当前基线 1267**
- git commit 不带 `Co-Authored-By` 之类 AI 署名 trailer
- 不新建分支（在 `traces-track` 上）
- 不要 `git add` `dist/`、`plugins/**/scripts/*.js`、`pnpm-lock.yaml`

## 测试质量要求（本仓库的特殊教训）

Phase 1 执行期间，评审用变异测试抓出了**六次**「测试通过但实际什么都没测」。因此本 plan 每个任务都要求：

**做变异验证** —— 把该任务的修复还原成修复前的写法，确认对应测试转红；还原后转绿。两次结果写进报告。做不到转红的测试等于没写。

---

### Task 1: 修复并发同名工具调用的 spanKey 冲突

**Files:**
- Modify: `src/scripts/lib/collector-core.ts`
- Test: `src/tests/span-key-collision.test.ts`

**Interfaces:**
- Produces: `spanKey` 行为不变（纯函数）；新增 `allocateSpanKey(state, input): string` 处理冲突

**问题**：`spanKey` 在无 `tool_use_id` 时回落到 `${tool_name}:${tool_summary}`。两个**同时进行**的同名同参调用会得到相同 key——第二个 pre 覆盖第一个的 pending 条目，第一个 post 关闭的是第二个的 span。代码注释（`collector-core.ts:152-159`）已承认这个取舍。

Hermes 是唯一走此路径的平台（其 `pre_tool_call` 不带 `tool_call_id`）。

**修法**：`spanKey` 保持纯函数不变；在 PreToolUse 分支改用新的 `allocateSpanKey`，它感知已有的 pending 条目并追加序号。

- [ ] **Step 1: 写失败的测试**

创建 `src/tests/span-key-collision.test.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allocateSpanKey, spanKey } from '../scripts/lib/collector-core.js';
import type { CollectorState } from '../scripts/lib/traces-state-store.js';

function emptyState(): CollectorState {
  return {
    session_id: 'sess-1',
    turn_number: 1,
    turn_trace_id: 'a'.repeat(32),
    turn_start_ms: 1700000000000,
    pending_spans: {},
    pending_task_spans: {},
  };
}

const input = { tool_name: 'terminal', tool_input: { command: 'ls' } };

describe('allocateSpanKey', () => {
  it('returns the plain key when nothing is pending', () => {
    assert.equal(allocateSpanKey(emptyState(), input), 'terminal:ls');
  });

  it('appends a suffix when the plain key is already pending', () => {
    const s = emptyState();
    s.pending_spans['terminal:ls'] = {
      tool_name: 'terminal', tool_summary: 'ls',
      start_ms: 1, span_id: 'b'.repeat(16),
    };
    assert.equal(allocateSpanKey(s, input), 'terminal:ls#2');
  });

  it('keeps incrementing for a third concurrent call', () => {
    const s = emptyState();
    for (const k of ['terminal:ls', 'terminal:ls#2']) {
      s.pending_spans[k] = {
        tool_name: 'terminal', tool_summary: 'ls',
        start_ms: 1, span_id: 'b'.repeat(16),
      };
    }
    assert.equal(allocateSpanKey(s, input), 'terminal:ls#3');
  });

  it('prefers tool_use_id and never suffixes it', () => {
    const s = emptyState();
    s.pending_spans['toolu_x'] = {
      tool_name: 'Bash', tool_summary: 'ls',
      start_ms: 1, span_id: 'b'.repeat(16),
    };
    // A real tool_use_id is unique by construction; colliding on it would
    // mean the host reused an id, which we must not paper over.
    assert.equal(allocateSpanKey(s, { ...input, tool_use_id: 'toolu_x' }), 'toolu_x');
  });

  it('does not mutate the input state', () => {
    const s = emptyState();
    allocateSpanKey(s, input);
    assert.deepEqual(s.pending_spans, {});
  });

  it('spanKey itself stays pure and unsuffixed', () => {
    assert.equal(spanKey(input), 'terminal:ls');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/span-key-collision.test.js
```

预期：编译失败，`allocateSpanKey` 未导出

- [ ] **Step 3: 实现**

在 `src/scripts/lib/collector-core.ts` 的 `spanKey` 之后追加：

```typescript
/**
 * Pick a pending-span key that is free right now.
 *
 * `spanKey`'s composite fallback (`name:summary`) collides when two
 * identical calls are in flight at once — the second PRE overwrites the
 * first's pending entry, and the first POST then closes the second's
 * span. Suffixing keeps concurrent calls apart.
 *
 * A real `tool_use_id` is unique by construction, so it is returned
 * untouched: a collision there would mean the host reused an id, and
 * silently renaming it would hide that bug rather than surface it.
 */
export function allocateSpanKey(
  state: CollectorState,
  input: HookStdinPayload,
): string {
  const base = spanKey(input);
  if (input.tool_use_id) return base;
  if (!state.pending_spans[base]) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}#${n}`;
    if (!state.pending_spans[candidate]) return candidate;
  }
}
```

然后把 PreToolUse 分支里的 `const key = spanKey(input);` 改为：

```typescript
        const key = allocateSpanKey(state, input);
```

注意：该行位于 `ensureTurn` 之后（需要 state），确认改后顺序仍正确。

**不要改 `resolveSpanKey`** —— POST 侧先按 `tool_use_id` 查、再按 composite 查，带序号的 key 会被 composite 分支的精确匹配命中；FIFO 语义由 `#2`/`#3` 的分配顺序天然保证。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/span-key-collision.test.js && pnpm test
```

- [ ] **Step 5: 变异验证**

把 `allocateSpanKey` 的函数体改成 `return spanKey(input);`，重新 build，确认「appends a suffix」与「keeps incrementing」两条转红；还原后转绿。结果写进报告。

- [ ] **Step 6: 提交**

```bash
git add src/scripts/lib/collector-core.ts src/tests/span-key-collision.test.ts
git commit -m "fix(collector): keep concurrent same-signature tool calls on distinct span keys"
```

---

### Task 2: MCP 工具独立成维度

**Files:**
- Modify: `src/scripts/lib/traces-collector.ts`（`genAiToolAttributes` 的调用侧）
- Modify: `src/scripts/lib/collector-core.ts`
- Test: `src/tests/mcp-tool-dimension.test.ts`

**Interfaces:**
- Produces: `parseMcpToolName(toolName: string): { server: string; tool: string } | null`

**问题**：MCP 调用与普通工具混在同一个 `execute_tool` span 里，无法统计「MCP 调用占比」「哪个 server 最慢」。`gen_ai.tool.type` 目前无调用方传值。

MCP 工具名形如 `mcp__<server>__<tool>`（Claude Code 惯例）。

- [ ] **Step 1: 写失败的测试**

创建 `src/tests/mcp-tool-dimension.test.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpToolName } from '../scripts/lib/collector-core.js';

describe('parseMcpToolName', () => {
  it('splits a well-formed mcp tool name', () => {
    assert.deepEqual(parseMcpToolName('mcp__github__create_issue'),
      { server: 'github', tool: 'create_issue' });
  });

  it('keeps underscores inside the tool name', () => {
    assert.deepEqual(parseMcpToolName('mcp__my_server__do_a_thing'),
      { server: 'my_server', tool: 'do_a_thing' });
  });

  it('returns null for non-mcp tools', () => {
    for (const n of ['Bash', 'Read', 'terminal', 'exec_command']) {
      assert.equal(parseMcpToolName(n), null, `${n} must not parse as mcp`);
    }
  });

  it('returns null for malformed mcp-looking names', () => {
    for (const n of ['mcp__', 'mcp__onlyserver', 'mcp____empty']) {
      assert.equal(parseMcpToolName(n), null, `${n} must not parse`);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/mcp-tool-dimension.test.js
```

- [ ] **Step 3: 实现解析函数**

在 `src/scripts/lib/collector-core.ts` 追加：

```typescript
/**
 * Split an MCP tool name into its server and tool halves.
 *
 * MCP tools arrive as `mcp__<server>__<tool>`. Splitting them lets the
 * span carry `nio.mcp.server` as its own dimension, so "how much of this
 * agent's work goes through MCP" and "which server is slow" become
 * answerable without string-matching tool names at query time.
 *
 * Returns null for anything that is not a well-formed MCP name — the
 * caller then emits the span exactly as before.
 */
export function parseMcpToolName(
  toolName: string,
): { server: string; tool: string } | null {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice(5);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (!server || !tool) return null;
  return { server, tool };
}
```

- [ ] **Step 4: 接到 span 属性上**

在 `src/scripts/lib/traces-collector.ts` 的 `recordPostToolUse` 中，span 属性构造处（`genAiToolAttributes(pending.tool_name, toolCallId)` 那一行附近）追加 MCP 维度。由于 `traces-collector.ts` 不应依赖 `collector-core.ts`（会形成循环），把 `parseMcpToolName` 的调用放在 **collector-core 侧**，通过 `postAttributes` 传入。

具体：在 `collector-core.ts` 的 PostToolUse 分支，构造 `recordPostToolUse` 的 `postAttributes` 时合并：

```typescript
        const mcp = parseMcpToolName(toolName);
        const mcpAttrs = mcp
          ? { 'gen_ai.tool.type': 'mcp', 'nio.mcp.server': mcp.server, 'nio.mcp.tool': mcp.tool }
          : {};
```

然后把 `...mcpAttrs` 加进传给 `recordPostToolUse` 的属性对象。

同样在 guard-hook 的 deny 路径（`src/scripts/guard-hook.ts` 的 `guardAttrs` 构造处）加上同一份属性，否则被拦截的 MCP 调用会缺这个维度。

- [ ] **Step 5: 补接线测试**

在 `src/tests/mcp-tool-dimension.test.ts` 追加一个 describe：用 `dispatchCollectorEvent` 跑一次 `mcp__github__create_issue` 的 PreToolUse + PostToolUse，断言导出的 span 带 `gen_ai.tool.type === 'mcp'` 与 `nio.mcp.server === 'github'`。参照 `src/tests/collector-core.test.ts` 里既有的 `InMemorySpanExporter` 用法。

- [ ] **Step 6: 全量测试 + 变异验证**

```bash
pnpm run build && pnpm test
```

变异：把 `parseMcpToolName` 改成 `return null;`，确认接线测试转红；还原后转绿。

- [ ] **Step 7: 提交**

```bash
git add src/scripts/lib/collector-core.ts src/scripts/guard-hook.ts src/tests/mcp-tool-dimension.test.ts
git commit -m "feat(collector): give MCP tool calls their own server dimension"
```

---

### Task 3: config-loader 两项修正

**Files:**
- Modify: `src/scripts/lib/config-loader.ts`
- Test: `src/tests/config-loader-hardening.test.ts`

**问题 A（语义分歧）**：`config-loader.ts` 的 `nioDir()` 用 `??`，而 `src/adapters/common.ts:28` 的同名函数用 `||`。`NIO_HOME=''` 时两者对同一环境变量给出不同答案——一个读 `/config.yaml`，一个回落 `~/.nio`。低概率但会造成难查的测试串味。

**问题 B（热路径开销）**：`readRawConfig()` 每次调用都 `readFileSync` + YAML parse。单个 hook 进程内它被调用 4 次以上（`loadCollectorConfig` / `loadLogsConfig` / `loadAgentName` / `loadMonitorAllSessions`）。OpenClaw 是长驻进程且每次工具调用触发两次门控判定，同步 IO 持续累积。

- [ ] **Step 1: 写失败的测试**

创建 `src/tests/config-loader-hardening.test.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

function withEnv<T>(nioHome: string | undefined, fn: () => T): T {
  const prev = process.env['NIO_HOME'];
  if (nioHome === undefined) delete process.env['NIO_HOME'];
  else process.env['NIO_HOME'] = nioHome;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env['NIO_HOME'];
    else process.env['NIO_HOME'] = prev;
  }
}

describe('NIO_HOME empty-string handling', () => {
  it('treats NIO_HOME="" as unset, matching adapters/common.ts', async () => {
    const { loadLogsConfig } = await import('../scripts/lib/config-loader.js');
    const p = withEnv('', () => loadLogsConfig().path);
    assert.equal(p, join(homedir(), '.nio', 'audit.jsonl'),
      'empty NIO_HOME must fall back to ~/.nio, not resolve to /audit.jsonl');
  });
});

describe('readRawConfig caching', () => {
  it('reflects a config written before first read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nio-cfg-cache-'));
    writeFileSync(join(dir, 'config.yaml'), 'collector:\n  monitor_all_sessions: true\n', 'utf-8');
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    assert.equal(withEnv(dir, () => loadMonitorAllSessions()), true);
  });

  it('does not leak one NIO_HOME cached value into another', async () => {
    const a = mkdtempSync(join(tmpdir(), 'nio-cfg-a-'));
    const b = mkdtempSync(join(tmpdir(), 'nio-cfg-b-'));
    writeFileSync(join(a, 'config.yaml'), 'collector:\n  monitor_all_sessions: true\n', 'utf-8');
    writeFileSync(join(b, 'config.yaml'), 'collector:\n  monitor_all_sessions: false\n', 'utf-8');
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    assert.equal(withEnv(a, () => loadMonitorAllSessions()), true);
    assert.equal(withEnv(b, () => loadMonitorAllSessions()), false,
      'cache must be keyed by resolved config path, not global');
    assert.equal(withEnv(a, () => loadMonitorAllSessions()), true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/config-loader-hardening.test.js
```

预期：第一条与第三条失败（`??` 语义、无缓存或缓存未按路径分键）

- [ ] **Step 3: 实现**

在 `src/scripts/lib/config-loader.ts`：

把 `nioDir()` 的 `??` 改为 `||`：

```typescript
function nioDir(): string {
  // `||` not `??`: an empty NIO_HOME means "unset", matching
  // adapters/common.ts. With `??` an empty string would resolve the
  // config to `/config.yaml`, and the two modules would disagree about
  // the same environment variable.
  return process.env['NIO_HOME'] || join(homedir(), '.nio');
}
```

给 `readRawConfig` 加**按解析后路径分键**的缓存：

```typescript
// Cache keyed by resolved config path. A hook process reads config 4+
// times (collector / logs / agent name / monitor gate); OpenClaw's
// long-lived daemon does so twice per tool call. Keying by path rather
// than caching globally keeps tests that switch NIO_HOME honest.
const rawConfigCache = new Map<string, Record<string, unknown>>();

function readRawConfig(): Record<string, unknown> {
  const configDir = process.env['NIO_HOME'] || join(homedir(), '.nio');
  const configPath = join(configDir, 'config.yaml');

  const cached = rawConfigCache.get(configPath);
  if (cached) return cached;

  if (!existsSync(configPath)) {
    rawConfigCache.set(configPath, {});
    return {};
  }

  try {
    const parsed = (yamlLoad(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
    rawConfigCache.set(configPath, parsed);
    return parsed;
  } catch (err) {
    reportConfigError(configDir, configPath, err);
    rawConfigCache.set(configPath, {});
    return {};
  }
}
```

**注意**：缓存在进程生命周期内有效。对每事件新建进程的三个平台无影响；对 OpenClaw 长驻进程意味着改了 config.yaml 需重启 daemon 才生效——这与 provider 在注册时读取配置的既有行为一致，不引入新的不一致。请在注释里写明这一点。

- [ ] **Step 4: 跑测试 + 全量回归**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/config-loader-hardening.test.js && pnpm test
```

特别确认 `config-loader.test.js` 与 `monitor-config.test.js` 无回归——它们大量切换 `NIO_HOME`，是缓存分键正确性的天然检验。

- [ ] **Step 5: 变异验证**

分别还原两处改动（`||` 改回 `??`；删掉缓存），确认对应测试转红。

- [ ] **Step 6: 提交**

```bash
git add src/scripts/lib/config-loader.ts src/tests/config-loader-hardening.test.ts
git commit -m "fix(config): align empty NIO_HOME semantics and cache raw config per path"
```

---

### Task 4: monitor-store 原子写与损坏诊断

**Files:**
- Modify: `src/scripts/lib/monitor-store.ts`
- Test: `src/tests/monitor-store-durability.test.ts`

**问题 A（非原子写）**：`saveMonitorStore` 用裸 `writeFileSync` 截断写。Claude Code 的 PreToolUse 会并行拉起 guard-hook 与 collector-hook 两个进程，都可能写这个文件；`monitor-cli off` 与某个 hook 的 GC 写回也可能竞争。撕裂读的后果是 fail-closed（半截 JSON → 空 store → 不覆写），方向安全，但 `off` 之后被 GC 写回复活是真实风险。

**问题 B（损坏静默）**：`loadMonitorStore` 的 catch 完全静默。store 损坏时用户只会看到「arm 了但没数据」，无任何线索。

- [ ] **Step 1: 写失败的测试**

创建 `src/tests/monitor-store-durability.test.ts`，覆盖：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveMonitorStore, loadMonitorStore } from '../scripts/lib/monitor-store.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';

function freshDir(): { dir: string; logsConfig: CollectorLogsConfig } {
  const dir = mkdtempSync(join(tmpdir(), 'nio-store-dur-'));
  return { dir, logsConfig: { path: join(dir, 'audit.jsonl') } as CollectorLogsConfig };
}

describe('saveMonitorStore atomicity', () => {
  it('leaves no temp file behind on success', () => {
    const { dir, logsConfig } = freshDir();
    saveMonitorStore(logsConfig, { sessions: { s1: { armed_at: 1, cwd: '/w' } } });
    const stray = readdirSync(dir).filter(f => f !== 'monitored-sessions.json');
    assert.deepEqual(stray, [], `unexpected leftovers: ${stray.join(',')}`);
  });

  it('never leaves a partially written store readable', () => {
    // A reader must see either the old content or the new one, never a
    // truncated file. Writing via temp+rename is what guarantees this.
    const { dir, logsConfig } = freshDir();
    saveMonitorStore(logsConfig, { sessions: { old: { armed_at: 1, cwd: '/w' } } });
    saveMonitorStore(logsConfig, { sessions: { neu: { armed_at: 2, cwd: '/w' } } });
    const loaded = loadMonitorStore(logsConfig);
    assert.equal('neu' in loaded.sessions, true);
    assert.equal('old' in loaded.sessions, false);
  });
});

describe('loadMonitorStore corruption reporting', () => {
  it('still returns an empty store on corrupt JSON', () => {
    const { dir, logsConfig } = freshDir();
    writeFileSync(join(dir, 'monitored-sessions.json'), '{not json', 'utf-8');
    assert.deepEqual(loadMonitorStore(logsConfig), { sessions: {} });
  });

  it('does not report a diagnostic when the file is simply absent', () => {
    const { dir, logsConfig } = freshDir();
    loadMonitorStore(logsConfig);
    assert.equal(existsSync(join(dir, 'audit.jsonl')), false,
      'a missing store is normal and must stay silent');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/monitor-store-durability.test.js
```

- [ ] **Step 3: 实现原子写**

修改 `saveMonitorStore`：

```typescript
/** Persist the store atomically. Creates the parent directory if missing. */
export function saveMonitorStore(
  logsConfig: CollectorLogsConfig | undefined,
  store: MonitorStore,
): void {
  const path = monitorStorePath(logsConfig);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Write-then-rename: several processes touch this file concurrently
  // (guard-hook and collector-hook both fire on one PreToolUse, and
  // `/nio-monitor off` can race a hook's expiry sweep). A truncating
  // write would let a reader observe half a JSON document; rename is
  // atomic within a filesystem, so a reader sees either the old store
  // or the new one.
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    renameSync(tmp, path);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}
```

顶部 import 补 `renameSync` / `unlinkSync` 与 `randomBytes`：

```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
```

- [ ] **Step 4: 实现损坏诊断**

修改 `loadMonitorStore` 的 catch：文件不存在时保持静默（正常状态），仅在**读到了内容但解析失败**时报诊断。

```typescript
export function loadMonitorStore(logsConfig?: CollectorLogsConfig): MonitorStore {
  const path = monitorStorePath(logsConfig);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    // Absent store is the normal default state, not a fault.
    return { sessions: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MonitorStore>;
    // ...既有的形状校验逻辑保持不变
  } catch (err) {
    // A store that exists but cannot be parsed silently disables capture
    // for every session — the user sees "I armed it but no data" with no
    // clue why. Surface it. `/nio-monitor on` overwrites the bad file, so
    // this is self-healing once noticed.
    void import('../../adapters/diagnostics.js').then(({ reportDiagnostic }) => {
      reportDiagnostic({
        severity: 'warning',
        source: 'collector',
        kind: 'monitor_store_corrupt',
        message: '[nio] monitored-sessions.json is unreadable; no session will be captured',
        detail: err instanceof Error ? err.message : String(err),
        hint: 'Run /nio-monitor on to rewrite it, or delete the file.',
      });
    }).catch(() => { /* diagnostics must never break the gate */ });
    return { sessions: {} };
  }
}
```

**关键**：诊断走动态 import 且不 await——`loadMonitorStore` 在门控热路径上，必须保持同步返回。整段仍要保证永不抛异常。

实现时保留既有的形状校验（`isPlainObject` / `isValidSession` / `isValidPendingArm`），只改外层的读取与错误处理结构。

- [ ] **Step 5: 跑测试 + 全量回归**

```bash
pnpm run build && pnpm test
```

`monitor-store.test.js`（24 条）必须全绿——它覆盖了形状校验，是本次重构的安全网。

- [ ] **Step 6: 变异验证**

把原子写还原成裸 `writeFileSync`，确认「leaves no temp file behind」以外的用例行为；再把诊断删掉，确认对应断言。若某条在变异下不转红，说明它测的东西与改动无关，据实报告，不要硬凑。

- [ ] **Step 7: 提交**

```bash
git add src/scripts/lib/monitor-store.ts src/tests/monitor-store-durability.test.ts
git commit -m "fix(collector): write the monitor store atomically and surface corruption"
```

---

### Task 5: `monitor-cli on` 不再吞掉他人的 pending_arm

**Files:**
- Modify: `src/scripts/lib/monitor-commands.ts`
- Test: `src/tests/monitor-commands-pending.test.ts`

**问题**：`on` 的 direct 分支构造的新 store 只带 `sessions`，不带 `pending_arm`：

```typescript
const next: MonitorStore = {
  sessions: { ...store.sessions, [sessionId]: { armed_at: now, cwd } },
};
```

多平台共用 `~/.nio` 时，Codex 会话刚 `on`（写下 pending_arm 等待认领）、Claude Code 会话随后 `on`（走 direct 分支），前者的 arm 被静默抹掉，用户以为开了其实没开。

- [ ] **Step 1: 写失败的测试**

创建 `src/tests/monitor-commands-pending.test.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveMonitorStore, loadMonitorStore } from '../scripts/lib/monitor-store.js';
import { runMonitorCommand } from '../scripts/lib/monitor-commands.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';

// runMonitorCommand(command, {cwd}) resolves logsConfig via loadLogsConfig()
// and the session id via resolveSessionId() — both read the environment,
// neither is a parameter. So the fixture drives it through NIO_HOME and
// CLAUDE_CODE_SESSION_ID rather than passing them in.
function withEnv<T>(home: string, sessionId: string | null, fn: () => T): T {
  const prevHome = process.env['NIO_HOME'];
  const prevSid = process.env['CLAUDE_CODE_SESSION_ID'];
  process.env['NIO_HOME'] = home;
  if (sessionId === null) delete process.env['CLAUDE_CODE_SESSION_ID'];
  else process.env['CLAUDE_CODE_SESSION_ID'] = sessionId;
  try { return fn(); } finally {
    if (prevHome === undefined) delete process.env['NIO_HOME']; else process.env['NIO_HOME'] = prevHome;
    if (prevSid === undefined) delete process.env['CLAUDE_CODE_SESSION_ID']; else process.env['CLAUDE_CODE_SESSION_ID'] = prevSid;
  }
}

function fresh(): { home: string; logsConfig: CollectorLogsConfig } {
  const home = mkdtempSync(join(tmpdir(), 'nio-cmd-pending-'));
  return { home, logsConfig: { path: join(home, 'audit.jsonl') } as CollectorLogsConfig };
}

describe('monitor on (direct) preserves a foreign pending arm', () => {
  it('keeps another session-s pending_arm intact', () => {
    const { home, logsConfig } = fresh();
    saveMonitorStore(logsConfig, {
      sessions: {},
      pending_arm: { at: Date.now(), cwd: '/other/project' },
    });

    withEnv(home, 'sess-direct', () => runMonitorCommand('on', { cwd: '/my/project' }));

    const store = loadMonitorStore(logsConfig);
    assert.equal('sess-direct' in store.sessions, true, 'own session must be armed');
    assert.notEqual(store.pending_arm, undefined,
      'a pending arm belonging to another session must survive');
    assert.equal(store.pending_arm?.cwd, '/other/project');
  });

  it('off still clears the pending arm', () => {
    const { home, logsConfig } = fresh();
    saveMonitorStore(logsConfig, {
      sessions: {},
      pending_arm: { at: Date.now(), cwd: '/x' },
    });
    withEnv(home, 'sess-x', () => runMonitorCommand('off', { cwd: '/x' }));
    assert.equal(loadMonitorStore(logsConfig).pending_arm, undefined);
  });
});
```

**注意**：`loadLogsConfig()` 在无 `collector.logs.path` 配置时把 audit 路径解析到 `${NIO_HOME}/audit.jsonl`，因而 `monitorStorePath` 落在同一临时目录——`fresh()` 返回的 `logsConfig` 与 `runMonitorCommand` 内部解析出的是同一个路径。若发现不一致，先确认 `loadLogsConfig` 的默认路径行为，不要改生产代码去迁就测试。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/monitor-commands-pending.test.js
```

预期：第一条失败（pending_arm 被抹掉）

- [ ] **Step 3: 实现**

在 `on` 的 direct 分支保留既有 `pending_arm`：

```typescript
      const next: MonitorStore = {
        sessions: { ...store.sessions, [sessionId]: { armed_at: now, cwd } },
        // Preserve any pending arm: it belongs to a different session
        // (possibly on another platform sharing this NIO_HOME) that is
        // still waiting for its first hook event to claim it. Dropping it
        // here would silently un-arm that session.
        ...(store.pending_arm ? { pending_arm: store.pending_arm } : {}),
      };
```

`off` 分支维持现状（显式清除 pending_arm 是它的既定语义）。

- [ ] **Step 4: 跑测试 + 全量回归**

```bash
pnpm run build && pnpm test
```

- [ ] **Step 5: 变异验证**

删掉新增的 `...(store.pending_arm ? ... : {})`，确认第一条转红；还原后转绿。

- [ ] **Step 6: 提交**

```bash
git add src/scripts/lib/monitor-commands.ts src/tests/monitor-commands-pending.test.ts
git commit -m "fix(collector): stop monitor on from dropping another session-s pending arm"
```

---

### Task 6: 删除两处已被实测推翻的文档描述（Phase 6）

**Files:**
- Modify: `docs/COLLECTOR-SIGNALS.md:273`
- Modify: `docs/ARCHITECTURE.md:721`

**问题**：两处都声称 Hermes 在 `post_llm_call` 提供 transcript path 时走 Claude Code 同款 usage 路径。

Phase 2 的实机采样已确认：**`post_llm_call` 的 payload 里根本没有 transcript 路径字段**（实测 `extra` 只有 `user_message` / `assistant_response` / `conversation_history` / `model` / `platform`）。且 `hermesToCollectorInput` 从不提取该字段。

因此这个条件永不成立，Hermes 的 turn span **恒无 token usage**。文档应当**删除**这个不存在的分支，而非修正它。

- [ ] **Step 1: 改 `docs/COLLECTOR-SIGNALS.md`**

把第 273 行那段里 Hermes 的描述换掉。原文：

```
**Hermes**: same code path as Claude Code if the transcript path is included in the `post_llm_call` payload; otherwise empty.
```

改为：

```
**Hermes**: no usage. The `post_llm_call` payload carries no transcript path (verified by live capture — `extra` holds only `user_message`, `assistant_response`, `conversation_history`, `model`, `platform`), so there is nothing for `parseTranscriptUsage` to read. Token usage on Hermes turn spans is a known gap, not a payload-dependent behaviour.
```

- [ ] **Step 2: 改 `docs/ARCHITECTURE.md`**

原文第 721 行：

```
- **Hermes**: same code path as Claude Code — when `post_llm_call`'s payload supplies `transcriptPath`, `endTurn` runs `parseTranscriptUsage` against it; when not, the turn span carries no usage.
```

改为：

```
- **Hermes**: no usage on turn spans. `post_llm_call` supplies no transcript path (confirmed by live capture), and `hermesToCollectorInput` does not extract one, so `parseTranscriptUsage` never runs. Hermes does expose `assistant_response` and `conversation_history` in the same payload — both currently unread; see the Phase 4 content pipeline.
```

- [ ] **Step 3: 全文检查是否还有同类描述**

```bash
grep -rn "transcript" docs/*.md | grep -i "hermes"
```

预期：无其他残留。若有，一并按上述口径修正。

- [ ] **Step 4: 跑测试**

```bash
pnpm run build && pnpm test
```

纯文档改动，应无影响；跑一次确认没有测试断言依赖这些文本。

- [ ] **Step 5: 提交**

```bash
git add docs/COLLECTOR-SIGNALS.md docs/ARCHITECTURE.md
git commit -m "docs: drop the Hermes transcript-usage claim disproven by live capture"
```

---

## 验收标准

- [ ] 并发同名工具调用不再互相覆盖 span
- [ ] MCP 调用带 `gen_ai.tool.type` / `nio.mcp.server` / `nio.mcp.tool` 三个维度，拦截路径亦然
- [ ] `NIO_HOME=''` 在 `config-loader` 与 `adapters/common` 中行为一致
- [ ] 单进程内 `config.yaml` 只解析一次，且缓存按路径分键
- [ ] monitor store 原子写，损坏时有诊断
- [ ] `monitor on` 不再抹掉他人的 pending_arm
- [ ] 文档不再声称 Hermes 有 transcript path
- [ ] `pnpm test` 全绿（基线 1267，预期增至 1290 左右），`pnpm run typecheck` 无错
- [ ] 每个任务都完成了变异验证并写入报告
