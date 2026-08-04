# Collector Monitor Gate 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 nio 加一个 session 级采集总闸——默认所有 session 静默，用户在 session 内执行 `/nio-monitor` 后该 session 才外发 metrics / traces / logs。

**Architecture:** 新增两个纯模块（`monitor-store` 负责持久化，`monitor-gate` 负责判定），在四个平台入口的 OTEL provider 创建之前插入判定点——不监控就不创建 provider，三个信号从源头静默。guard 的拦截逻辑与本地 audit 写入不受影响。

**Tech Stack:** TypeScript / Node 18+ / node:test / OpenTelemetry SDK / js-yaml

**对应 spec:** `docs/superpowers/specs/2026-08-04-traces-full-capture-design.md` 的 Phase 1

## Global Constraints

- 所有新文件以 `// Copyright 2026 core0-io` + `// SPDX-License-Identifier: Apache-2.0` 开头，紧跟 `export {};`（沿用 `src/scripts/lib/` 现有文件的头部格式）
- 测试框架用 `node:test` + `node:assert/strict`，不引入新依赖
- 测试临时目录一律用 `mkdtempSync(join(tmpdir(), 'nio-...'))`，**禁止**读写真实 `~/.nio/`、`~/.hermes/` 或任何真实用户路径
- 遥测代码永不向宿主抛异常：新增路径包 try/catch，失败走 `reportDiagnostic`
- guard 的 Phase 0–6 拦截逻辑与本地 `audit.jsonl` 写入**不受总闸影响**
- 内容类数据（prompt / thinking / response）在本 Phase 不涉及
- git commit 不带 Claude 署名 trailer
- 不新建分支，直接在 `traces-track` 上提交

## 关键设计约束（来自 spec）

- 状态文件 `monitored-sessions.json` 与 `traces-state-store.json` **分离**：前者是 session 级持久状态，后者是 turn 级易失状态
- session 绑定两级策略：环境变量直绑优先，`pending_arm` 兜底
- `pending_arm` TTL = 60 秒，靠 `cwd` 匹配防止并发 session 争抢
- session 记录 7 天过期兜底
- 开关**从下一个 hook 事件开始生效**（per-hook 进程模型的固有行为）
- **不提供回溯**

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/scripts/lib/monitor-store.ts`（新建） | `monitored-sessions.json` 的读写与路径解析，无业务逻辑 |
| `src/scripts/lib/monitor-gate.ts`（新建） | 纯判定函数：给定 store + sessionId + config，回答"这个 session 该不该采集"，并产出需要持久化的 store 变更 |
| `src/scripts/monitor-cli.ts`（新建） | `/nio-monitor` 背后的 CLI：on / off / status |
| `src/scripts/lib/config-loader.ts`（修改） | 新增 `loadMonitorConfig()` 读 `collector.monitor_all_sessions` |
| `src/scripts/collector-hook.ts`（修改） | provider 创建前插判定（Claude Code / Codex） |
| `src/scripts/guard-hook.ts`（修改） | provider 创建前插判定，本地 audit 不受影响 |
| `src/scripts/hook-cli.ts`（修改） | Hermes 侧同样判定 |
| `src/adapters/openclaw-plugin.ts`（修改） | OpenClaw 侧同样判定 |
| `plugins/shared/skills/nio-monitor/SKILL.md`（新建） | focused skill 定义 |
| `plugins/shared/config.default.yaml`（修改） | 配置模板加 `monitor_all_sessions` |

`monitor-store` 与 `monitor-gate` 拆开是有意为之：判定逻辑是纯函数，可以脱离文件系统完整测试；存储层只做 IO，跟现有 `traces-state-store.ts` 的分层方式保持一致。

---

### Task 1: monitor-store 持久化模块

**Files:**
- Create: `src/scripts/lib/monitor-store.ts`
- Test: `src/tests/monitor-store.test.ts`

**Interfaces:**
- Consumes: `CollectorLogsConfig`（来自 `src/adapters/config-schema.ts`）
- Produces:
  - `interface MonitoredSession { armed_at: number; cwd: string }`
  - `interface PendingArm { at: number; cwd: string }`
  - `interface MonitorStore { sessions: Record<string, MonitoredSession>; pending_arm?: PendingArm }`
  - `monitorStorePath(logsConfig?: CollectorLogsConfig): string`
  - `loadMonitorStore(logsConfig?: CollectorLogsConfig): MonitorStore`
  - `saveMonitorStore(logsConfig: CollectorLogsConfig | undefined, store: MonitorStore): void`

- [ ] **Step 1: 写失败的测试**

创建 `src/tests/monitor-store.test.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  monitorStorePath,
  loadMonitorStore,
  saveMonitorStore,
  type MonitorStore,
} from '../scripts/lib/monitor-store.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'nio-monitor-store-'));
}

describe('monitorStorePath', () => {
  it('sits next to the audit log when logs.path is set', () => {
    const dir = freshDir();
    const logsConfig = { path: join(dir, 'audit.jsonl') } as CollectorLogsConfig;
    assert.equal(monitorStorePath(logsConfig), join(dir, 'monitored-sessions.json'));
  });

  it('falls back to NIO_HOME when logs.path is absent', () => {
    const dir = freshDir();
    const prev = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = dir;
    try {
      assert.equal(monitorStorePath(undefined), join(dir, 'monitored-sessions.json'));
    } finally {
      if (prev === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = prev;
    }
  });
});

describe('loadMonitorStore', () => {
  it('returns an empty store when the file is missing', () => {
    const dir = freshDir();
    const logsConfig = { path: join(dir, 'audit.jsonl') } as CollectorLogsConfig;
    assert.deepEqual(loadMonitorStore(logsConfig), { sessions: {} });
  });

  it('returns an empty store when the file is corrupt', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'monitored-sessions.json'), '{not json', 'utf-8');
    const logsConfig = { path: join(dir, 'audit.jsonl') } as CollectorLogsConfig;
    assert.deepEqual(loadMonitorStore(logsConfig), { sessions: {} });
  });

  it('normalises a file with no sessions key', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'monitored-sessions.json'), '{}', 'utf-8');
    const logsConfig = { path: join(dir, 'audit.jsonl') } as CollectorLogsConfig;
    assert.deepEqual(loadMonitorStore(logsConfig), { sessions: {} });
  });

  it('round-trips a saved store', () => {
    const dir = freshDir();
    const logsConfig = { path: join(dir, 'audit.jsonl') } as CollectorLogsConfig;
    const store: MonitorStore = {
      sessions: { 'sess-1': { armed_at: 1754300000000, cwd: '/work/proj' } },
      pending_arm: { at: 1754300001000, cwd: '/work/other' },
    };
    saveMonitorStore(logsConfig, store);
    assert.deepEqual(loadMonitorStore(logsConfig), store);
  });
});

describe('saveMonitorStore', () => {
  it('creates the parent directory when missing', () => {
    const dir = freshDir();
    const nested = join(dir, 'a', 'b');
    const logsConfig = { path: join(nested, 'audit.jsonl') } as CollectorLogsConfig;
    saveMonitorStore(logsConfig, { sessions: {} });
    assert.deepEqual(loadMonitorStore(logsConfig), { sessions: {} });
  });

  it('omits pending_arm when absent', () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    const logsConfig = { path: join(dir, 'audit.jsonl') } as CollectorLogsConfig;
    saveMonitorStore(logsConfig, { sessions: {} });
    const loaded = loadMonitorStore(logsConfig);
    assert.equal('pending_arm' in loaded, false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/monitor-store.test.js
```

预期：编译失败，`Cannot find module '../scripts/lib/monitor-store.js'`

- [ ] **Step 3: 写实现**

创建 `src/scripts/lib/monitor-store.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Monitor store — owns `monitored-sessions.json`, the persistent record
 * of which sessions the user explicitly opted into telemetry for.
 *
 * Deliberately separate from `traces-state-store.json`: that file holds
 * turn-scoped ephemeral state (cleared every turn), this one holds
 * session-scoped durable state. Different lifecycles, different files.
 *
 * Path: derived from `collector.logs.path` so it sits next to the audit
 * log, same convention as the traces state store. Default
 * `${NIO_HOME ?? ~/.nio}/monitored-sessions.json`.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { CollectorLogsConfig } from '../../adapters/config-schema.js';

/** A session the user explicitly armed via `/nio-monitor`. */
export interface MonitoredSession {
  armed_at: number;
  cwd: string;
}

/**
 * A pending arm request from a platform where the CLI could not resolve
 * the session id itself. The next hook event matching `cwd` within the
 * TTL claims it.
 */
export interface PendingArm {
  at: number;
  cwd: string;
}

export interface MonitorStore {
  sessions: Record<string, MonitoredSession>;
  pending_arm?: PendingArm;
}

const STORE_FILE_NAME = 'monitored-sessions.json';

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function defaultStoreDir(): string {
  return process.env['NIO_HOME'] || join(homedir(), '.nio');
}

/** Resolve the store location — next to the audit log. */
export function monitorStorePath(logsConfig?: CollectorLogsConfig): string {
  const auditPath = logsConfig?.path ? expandHome(logsConfig.path) : null;
  const dir = auditPath ? dirname(auditPath) : defaultStoreDir();
  return join(dir, STORE_FILE_NAME);
}

/**
 * Load the store. Returns an empty store when the file is missing or
 * corrupt — a broken store must never enable telemetry that the user
 * did not ask for, and must never crash the hook.
 */
export function loadMonitorStore(logsConfig?: CollectorLogsConfig): MonitorStore {
  try {
    const raw = readFileSync(monitorStorePath(logsConfig), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<MonitorStore>;
    const store: MonitorStore = { sessions: parsed.sessions ?? {} };
    if (parsed.pending_arm) store.pending_arm = parsed.pending_arm;
    return store;
  } catch {
    return { sessions: {} };
  }
}

/** Persist the store. Creates the parent directory if missing. */
export function saveMonitorStore(
  logsConfig: CollectorLogsConfig | undefined,
  store: MonitorStore,
): void {
  const path = monitorStorePath(logsConfig);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(store, null, 2), 'utf-8');
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/monitor-store.test.js
```

预期：全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/scripts/lib/monitor-store.ts src/tests/monitor-store.test.ts
git commit -m "feat(collector): add monitor-store for session opt-in persistence"
```

---

### Task 2: monitor-gate 判定逻辑

**Files:**
- Create: `src/scripts/lib/monitor-gate.ts`
- Test: `src/tests/monitor-gate.test.ts`

**Interfaces:**
- Consumes: `MonitorStore` / `MonitoredSession` / `PendingArm`（Task 1）
- Produces:
  - `PENDING_ARM_TTL_MS: number`（60000）
  - `SESSION_TTL_MS: number`（604800000）
  - `interface GateInput { store: MonitorStore; sessionId: string; cwd: string | null; monitorAllSessions: boolean; nowMs: number }`
  - `interface GateResult { monitored: boolean; store: MonitorStore; changed: boolean }`
  - `resolveMonitorGate(input: GateInput): GateResult`

判定顺序（实现时必须严格按此顺序，测试依赖它）：

1. `monitorAllSessions === true` → 直接 monitored，不碰 store
2. 该 session 已在 `sessions` 中且未超过 `SESSION_TTL_MS` → monitored
3. 存在 `pending_arm`、未超过 `PENDING_ARM_TTL_MS`、且 `cwd` 匹配 → 认领：写入 `sessions`、清除 `pending_arm`、monitored、`changed = true`
4. 其余 → 不 monitored

无论走哪条分支，过期的 session 记录与过期的 `pending_arm` 都要被清理（`changed = true`）。

- [ ] **Step 1: 写失败的测试**

创建 `src/tests/monitor-gate.test.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveMonitorGate,
  PENDING_ARM_TTL_MS,
  SESSION_TTL_MS,
} from '../scripts/lib/monitor-gate.js';
import type { MonitorStore } from '../scripts/lib/monitor-store.js';

const NOW = 1754300000000;

function emptyStore(): MonitorStore {
  return { sessions: {} };
}

describe('resolveMonitorGate — monitor_all_sessions', () => {
  it('monitors everything when the global flag is on', () => {
    const r = resolveMonitorGate({
      store: emptyStore(),
      sessionId: 'sess-unknown',
      cwd: '/work',
      monitorAllSessions: true,
      nowMs: NOW,
    });
    assert.equal(r.monitored, true);
    assert.equal(r.changed, false);
  });

  it('does not mutate the store when the global flag is on', () => {
    const store: MonitorStore = { sessions: {}, pending_arm: { at: NOW, cwd: '/work' } };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-1',
      cwd: '/work',
      monitorAllSessions: true,
      nowMs: NOW,
    });
    assert.deepEqual(r.store.pending_arm, { at: NOW, cwd: '/work' });
  });
});

describe('resolveMonitorGate — default silence', () => {
  it('does not monitor an unknown session', () => {
    const r = resolveMonitorGate({
      store: emptyStore(),
      sessionId: 'sess-1',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, false);
    assert.equal(r.changed, false);
  });

  it('monitors a session that was explicitly armed', () => {
    const store: MonitorStore = {
      sessions: { 'sess-1': { armed_at: NOW - 1000, cwd: '/work' } },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-1',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, true);
  });

  it('does not monitor a different session in the same store', () => {
    const store: MonitorStore = {
      sessions: { 'sess-1': { armed_at: NOW - 1000, cwd: '/work' } },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-2',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, false);
  });
});

describe('resolveMonitorGate — pending arm claiming', () => {
  it('claims a fresh pending arm with matching cwd', () => {
    const store: MonitorStore = {
      sessions: {},
      pending_arm: { at: NOW - 1000, cwd: '/work' },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-new',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, true);
    assert.equal(r.changed, true);
    assert.equal(r.store.sessions['sess-new']?.cwd, '/work');
    assert.equal('pending_arm' in r.store, false);
  });

  it('does not claim a pending arm from a different cwd', () => {
    const store: MonitorStore = {
      sessions: {},
      pending_arm: { at: NOW - 1000, cwd: '/other' },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-new',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, false);
    assert.deepEqual(r.store.pending_arm, { at: NOW - 1000, cwd: '/other' });
  });

  it('drops an expired pending arm without claiming it', () => {
    const store: MonitorStore = {
      sessions: {},
      pending_arm: { at: NOW - PENDING_ARM_TTL_MS - 1, cwd: '/work' },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-new',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, false);
    assert.equal(r.changed, true);
    assert.equal('pending_arm' in r.store, false);
  });

  it('does not claim when cwd is null', () => {
    const store: MonitorStore = {
      sessions: {},
      pending_arm: { at: NOW - 1000, cwd: '/work' },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-new',
      cwd: null,
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, false);
  });
});

describe('resolveMonitorGate — expiry GC', () => {
  it('drops a session past the TTL and stops monitoring it', () => {
    const store: MonitorStore = {
      sessions: { 'sess-old': { armed_at: NOW - SESSION_TTL_MS - 1, cwd: '/work' } },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-old',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, false);
    assert.equal(r.changed, true);
    assert.equal('sess-old' in r.store.sessions, false);
  });

  it('drops unrelated expired sessions while serving a live one', () => {
    const store: MonitorStore = {
      sessions: {
        'sess-live': { armed_at: NOW - 1000, cwd: '/work' },
        'sess-old': { armed_at: NOW - SESSION_TTL_MS - 1, cwd: '/elsewhere' },
      },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-live',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, true);
    assert.equal(r.changed, true);
    assert.equal('sess-old' in r.store.sessions, false);
    assert.equal('sess-live' in r.store.sessions, true);
  });
});

describe('resolveMonitorGate — purity', () => {
  it('does not mutate the input store', () => {
    const store: MonitorStore = {
      sessions: {},
      pending_arm: { at: NOW - 1000, cwd: '/work' },
    };
    resolveMonitorGate({
      store,
      sessionId: 'sess-new',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.deepEqual(store.pending_arm, { at: NOW - 1000, cwd: '/work' });
    assert.deepEqual(store.sessions, {});
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/monitor-gate.test.js
```

预期：编译失败，`Cannot find module '../scripts/lib/monitor-gate.js'`

- [ ] **Step 3: 写实现**

创建 `src/scripts/lib/monitor-gate.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Monitor gate — decides whether a given session's telemetry may leave
 * the machine.
 *
 * Pure: takes a store snapshot in, returns a verdict plus the store as
 * it should be persisted. The caller owns all filesystem IO, mirroring
 * how `traces-collector.ts` stays pure while `collector-core.ts`
 * orchestrates load → mutate → save.
 *
 * Default posture is silence. A session emits telemetry only when the
 * user explicitly armed it (`/nio-monitor`) or when the operator set
 * `collector.monitor_all_sessions: true` globally.
 */

import type { MonitorStore } from './monitor-store.js';

/**
 * How long a `pending_arm` stays claimable. Short on purpose: the arm is
 * meant to be picked up by the very next hook event of the session the
 * user just typed into. A long window would let an unrelated concurrent
 * session in the same directory steal it.
 */
export const PENDING_ARM_TTL_MS = 60_000;

/**
 * Backstop expiry for armed sessions. `SessionEnd` normally removes the
 * record; this catches sessions that died without firing it, so the
 * store cannot grow without bound.
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface GateInput {
  store: MonitorStore;
  sessionId: string;
  cwd: string | null;
  monitorAllSessions: boolean;
  nowMs: number;
}

export interface GateResult {
  /** Whether this session's telemetry may be exported. */
  monitored: boolean;
  /** The store as it should be persisted. */
  store: MonitorStore;
  /** True when `store` differs from the input and needs saving. */
  changed: boolean;
}

/** Drop session records past SESSION_TTL_MS. Returns null when nothing changed. */
function gcExpiredSessions(
  sessions: MonitorStore['sessions'],
  nowMs: number,
): MonitorStore['sessions'] | null {
  const live: MonitorStore['sessions'] = {};
  let dropped = false;
  for (const [id, entry] of Object.entries(sessions)) {
    if (nowMs - entry.armed_at > SESSION_TTL_MS) {
      dropped = true;
      continue;
    }
    live[id] = entry;
  }
  return dropped ? live : null;
}

export function resolveMonitorGate(input: GateInput): GateResult {
  const { store, sessionId, cwd, monitorAllSessions, nowMs } = input;

  // Global override — never touches the store. Operators who set this
  // want blanket capture and should not have their store churned by
  // every hook event.
  if (monitorAllSessions) {
    return { monitored: true, store, changed: false };
  }

  let changed = false;
  let sessions = store.sessions;
  let pendingArm = store.pending_arm;

  const gcd = gcExpiredSessions(sessions, nowMs);
  if (gcd) {
    sessions = gcd;
    changed = true;
  }

  // Expired arm: drop it before anyone can claim it.
  if (pendingArm && nowMs - pendingArm.at > PENDING_ARM_TTL_MS) {
    pendingArm = undefined;
    changed = true;
  }

  const armed = sessions[sessionId];
  if (armed) {
    const next: MonitorStore = { sessions };
    if (pendingArm) next.pending_arm = pendingArm;
    return { monitored: true, store: next, changed };
  }

  // Claim a fresh arm whose cwd matches this event's. cwd matching is
  // what keeps two concurrent sessions from stealing each other's arm.
  if (pendingArm && cwd !== null && pendingArm.cwd === cwd) {
    const next: MonitorStore = {
      sessions: { ...sessions, [sessionId]: { armed_at: nowMs, cwd } },
    };
    return { monitored: true, store: next, changed: true };
  }

  const next: MonitorStore = { sessions };
  if (pendingArm) next.pending_arm = pendingArm;
  return { monitored: false, store: next, changed };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/monitor-gate.test.js
```

预期：全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/scripts/lib/monitor-gate.ts src/tests/monitor-gate.test.ts
git commit -m "feat(collector): add monitor-gate session opt-in decision logic"
```

---

### Task 3: config 读取 monitor_all_sessions

**Files:**
- Modify: `src/scripts/lib/config-loader.ts`
- Test: `src/tests/monitor-config.test.ts`

**Interfaces:**
- Produces: `loadMonitorAllSessions(): boolean`（默认 `false`）

- [ ] **Step 1: 写失败的测试**

创建 `src/tests/monitor-config.test.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function withConfig<T>(yaml: string, fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'nio-monitor-config-'));
  writeFileSync(join(dir, 'config.yaml'), yaml, 'utf-8');
  const prev = process.env['NIO_HOME'];
  process.env['NIO_HOME'] = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env['NIO_HOME'];
    else process.env['NIO_HOME'] = prev;
  }
}

describe('loadMonitorAllSessions', () => {
  it('defaults to false when the key is absent', async () => {
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    const result = withConfig('collector:\n  endpoint: "http://x"\n', () =>
      loadMonitorAllSessions());
    assert.equal(result, false);
  });

  it('defaults to false when there is no config file at all', async () => {
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    const dir = mkdtempSync(join(tmpdir(), 'nio-monitor-config-empty-'));
    const prev = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = dir;
    try {
      assert.equal(loadMonitorAllSessions(), false);
    } finally {
      if (prev === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = prev;
    }
  });

  it('reads true when explicitly set', async () => {
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    const result = withConfig('collector:\n  monitor_all_sessions: true\n', () =>
      loadMonitorAllSessions());
    assert.equal(result, true);
  });

  it('treats a non-boolean value as false', async () => {
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    const result = withConfig('collector:\n  monitor_all_sessions: "yes"\n', () =>
      loadMonitorAllSessions());
    assert.equal(result, false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/monitor-config.test.js
```

预期：FAIL，`loadMonitorAllSessions is not a function`

- [ ] **Step 3: 写实现**

在 `src/scripts/lib/config-loader.ts` 末尾追加：

```typescript
/**
 * Read `collector.monitor_all_sessions`.
 *
 * Defaults to `false` — nio's default posture is silence. Telemetry
 * leaves the machine only for sessions the user explicitly armed via
 * `/nio-monitor`, unless an operator opts the whole install in.
 *
 * Strict boolean check: any non-boolean value (string "yes", number 1)
 * reads as false. A typo in the config must not silently turn on
 * blanket capture.
 */
export function loadMonitorAllSessions(): boolean {
  const raw = readRawConfig();
  const collector = (raw['collector'] ?? {}) as Record<string, unknown>;
  return collector['monitor_all_sessions'] === true;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/monitor-config.test.js
```

预期：全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/scripts/lib/config-loader.ts src/tests/monitor-config.test.ts
git commit -m "feat(collector): read collector.monitor_all_sessions from config"
```

---

### Task 4: monitor-cli（on / off / status）

**Files:**
- Create: `src/scripts/monitor-cli.ts`
- Test: `src/tests/monitor-cli.test.ts`

**Interfaces:**
- Consumes: `loadMonitorStore` / `saveMonitorStore` / `MonitorStore`（Task 1）、`loadMonitorAllSessions`（Task 3）、`loadLogsConfig`
- Produces: 可执行 CLI，用法 `node monitor-cli.js <on|off|status>`，stdout 输出 JSON

**CLI 行为契约:**

| 参数 | 行为 | stdout |
|---|---|---|
| `on` | 能解析 session id 就直接写 `sessions`；否则写 `pending_arm` | `{"action":"on","mode":"direct"\|"pending","session_id":"..."\|null}` |
| `off` | 移除当前 session 记录；同时清掉 `pending_arm` | `{"action":"off","removed":true\|false}` |
| `status` | 报告全局开关 + 当前 session 是否被监控 | `{"action":"status","monitor_all_sessions":bool,"session_id":"..."\|null,"monitored":bool,"armed_sessions":N}` |

session id 解析：只读 `CLAUDE_CODE_SESSION_ID`（唯一已实机验证的变量）。其他平台走 `pending_arm` 兜底，等 Phase 2 验证后再补各自的环境变量。

- [ ] **Step 1: 写失败的测试**

创建 `src/tests/monitor-cli.test.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Scripts are bundled by bun (not tsc) into
// plugins/claude-code/skills/nio/scripts/, not dist/scripts/ —
// tsconfig.lib.json excludes src/scripts entirely. Same pattern as
// hook-cli.test.ts and config-cli.test.ts.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(
  HERE, '..', '..', 'plugins', 'claude-code', 'skills', 'nio', 'scripts', 'monitor-cli.js',
);

interface RunResult { [key: string]: unknown }

function run(args: string[], env: Record<string, string>, cwd: string): RunResult {
  const out = execFileSync('node', [CLI, ...args], {
    env: { ...process.env, ...env },
    cwd,
    encoding: 'utf-8',
  });
  return JSON.parse(out) as RunResult;
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'nio-monitor-cli-'));
}

function storeAt(home: string): Record<string, unknown> {
  const p = join(home, 'monitored-sessions.json');
  if (!existsSync(p)) return { sessions: {} };
  return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

describe('monitor-cli on', () => {
  it('arms the session directly when CLAUDE_CODE_SESSION_ID is present', () => {
    const home = freshHome();
    const r = run(['on'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-abc' }, home);
    assert.equal(r['action'], 'on');
    assert.equal(r['mode'], 'direct');
    assert.equal(r['session_id'], 'sess-abc');

    const store = storeAt(home) as { sessions: Record<string, unknown> };
    assert.equal('sess-abc' in store.sessions, true);
  });

  it('falls back to a pending arm when no session id is available', () => {
    const home = freshHome();
    const r = run(['on'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: '' }, home);
    assert.equal(r['mode'], 'pending');
    assert.equal(r['session_id'], null);

    const store = storeAt(home) as { pending_arm?: { cwd: string } };
    assert.equal(store.pending_arm?.cwd, home);
  });
});

describe('monitor-cli off', () => {
  it('removes an armed session', () => {
    const home = freshHome();
    run(['on'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-abc' }, home);
    const r = run(['off'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-abc' }, home);
    assert.equal(r['removed'], true);

    const store = storeAt(home) as { sessions: Record<string, unknown> };
    assert.equal('sess-abc' in store.sessions, false);
  });

  it('reports removed=false when nothing was armed', () => {
    const home = freshHome();
    const r = run(['off'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-none' }, home);
    assert.equal(r['removed'], false);
  });

  it('clears a pending arm too', () => {
    const home = freshHome();
    run(['on'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: '' }, home);
    run(['off'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: '' }, home);
    const store = storeAt(home) as { pending_arm?: unknown };
    assert.equal(store.pending_arm, undefined);
  });
});

describe('monitor-cli status', () => {
  it('reports not monitored on a fresh home', () => {
    const home = freshHome();
    const r = run(['status'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-x' }, home);
    assert.equal(r['monitored'], false);
    assert.equal(r['monitor_all_sessions'], false);
    assert.equal(r['armed_sessions'], 0);
  });

  it('reports monitored after arming', () => {
    const home = freshHome();
    run(['on'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-x' }, home);
    const r = run(['status'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-x' }, home);
    assert.equal(r['monitored'], true);
    assert.equal(r['armed_sessions'], 1);
  });
});

describe('monitor-cli usage', () => {
  it('exits non-zero on an unknown subcommand', () => {
    const home = freshHome();
    assert.throws(() => run(['bogus'], { NIO_HOME: home }, home));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/monitor-cli.test.js
```

预期：FAIL，找不到 `dist/scripts/monitor-cli.js`

- [ ] **Step 3: 写实现**

创建 `src/scripts/monitor-cli.ts`：

```typescript
#!/usr/bin/env node
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Nio — Monitor CLI
 *
 * Backs the `/nio-monitor` skill. Arms or disarms telemetry capture for
 * the current agent session.
 *
 * Session resolution is two-tier. When the host exposes the session id
 * in the environment (Claude Code sets CLAUDE_CODE_SESSION_ID) we bind
 * directly and the arm takes effect on the next hook event. When it does
 * not, we leave a `pending_arm` stamped with this process's cwd, and the
 * next hook event from a matching directory claims it.
 *
 * Output is JSON on stdout so the calling skill can present it without
 * parsing prose.
 */

import { loadLogsConfig, loadMonitorAllSessions } from './lib/config-loader.js';
import {
  loadMonitorStore,
  saveMonitorStore,
  type MonitorStore,
} from './lib/monitor-store.js';

/**
 * Environment variables that carry the host's session id. Only Claude
 * Code is listed — it is the one platform whose variable has been
 * verified on a real session. Other platforms fall through to the
 * pending-arm path until their variables are confirmed.
 */
const SESSION_ENV_VARS = ['CLAUDE_CODE_SESSION_ID'] as const;

function resolveSessionId(): string | null {
  for (const name of SESSION_ENV_VARS) {
    const value = process.env[name];
    if (value && value.length > 0) return value;
  }
  return null;
}

function usage(): never {
  process.stderr.write(
    'Usage: monitor-cli.js <on|off|status>\n\n' +
    '  on      Start capturing telemetry for the current session\n' +
    '  off     Stop capturing, and clear any pending arm\n' +
    '  status  Report global and per-session capture state\n',
  );
  process.exit(1);
}

function main(): void {
  const command = process.argv[2];
  if (!command || !['on', 'off', 'status'].includes(command)) usage();

  const logsConfig = loadLogsConfig();
  const store = loadMonitorStore(logsConfig);
  const sessionId = resolveSessionId();
  const cwd = process.cwd();
  const now = Date.now();

  if (command === 'on') {
    if (sessionId) {
      const next: MonitorStore = {
        sessions: { ...store.sessions, [sessionId]: { armed_at: now, cwd } },
      };
      saveMonitorStore(logsConfig, next);
      process.stdout.write(JSON.stringify({
        action: 'on', mode: 'direct', session_id: sessionId,
      }) + '\n');
    } else {
      const next: MonitorStore = {
        sessions: store.sessions,
        pending_arm: { at: now, cwd },
      };
      saveMonitorStore(logsConfig, next);
      process.stdout.write(JSON.stringify({
        action: 'on', mode: 'pending', session_id: null,
      }) + '\n');
    }
    return;
  }

  if (command === 'off') {
    const sessions = { ...store.sessions };
    const removed = sessionId !== null && sessionId in sessions;
    if (sessionId) delete sessions[sessionId];
    saveMonitorStore(logsConfig, { sessions });
    process.stdout.write(JSON.stringify({ action: 'off', removed }) + '\n');
    return;
  }

  const monitorAll = loadMonitorAllSessions();
  const monitored = monitorAll || (sessionId !== null && sessionId in store.sessions);
  process.stdout.write(JSON.stringify({
    action: 'status',
    monitor_all_sessions: monitorAll,
    session_id: sessionId,
    monitored,
    armed_sessions: Object.keys(store.sessions).length,
  }) + '\n');
}

main();
```

- [ ] **Step 4: 把 monitor-cli 加进构建产物**

修改 `scripts/build.js` 第 57–66 行的 entrypoints 数组，在 `doctor-cli` 之后加一行 `'monitor-cli',`：

```javascript
  entrypoints: [
    'scanner-hook',
    'guard-hook',
    'collector-hook',
    'action-cli',
    'config-cli',
    'external-score-cli',
    'doctor-cli',
    'monitor-cli',
    'hook-cli',
  ].map((n) => join(ROOT, `src/scripts/${n}.ts`)),
```

这个数组的产物会被 bundle 到 `plugins/claude-code/skills/nio/scripts/`，随后由同文件下方的 `cpSync` 镜像到 OpenClaw 与 Codex 的 skill 目录。Hermes 用的是另一个独立的 bundle 列表（只含 `hook-cli` / `nio-cli`），**不需要**加 `monitor-cli` —— Hermes 上 `/nio-monitor` 走 umbrella skill 的 `nio-cli` 分发。

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/monitor-cli.test.js
```

预期：全部 PASS

同时确认 bundle 产物存在：

```bash
ls plugins/claude-code/skills/nio/scripts/monitor-cli.js
```

- [ ] **Step 6: 提交**

```bash
git add src/scripts/monitor-cli.ts src/tests/monitor-cli.test.ts scripts/build.js
git commit -m "feat(collector): add monitor-cli for /nio-monitor on|off|status"
```

**不要** `git add` bundle 产物：`.gitignore:21` 忽略 `plugins/claude-code/skills/nio/scripts/*.js`，显式 add 会直接报错。产物由 `pnpm run build` 在打包时生成，不进版本库。

---

### Task 5: 接线 collector-hook 与 guard-hook（Claude Code / Codex）

**Files:**
- Create: `src/scripts/lib/monitor-check.ts`
- Modify: `src/scripts/collector-hook.ts:70-75`
- Modify: `src/scripts/guard-hook.ts`
- Test: `src/tests/monitor-integration.test.ts`

**Interfaces:**
- Consumes: `resolveMonitorGate`（Task 2）、`loadMonitorStore` / `saveMonitorStore`（Task 1）、`loadMonitorAllSessions`（Task 3）
- Produces: `isSessionMonitored(sessionId: string, cwd: string | null, logsConfig?: CollectorLogsConfig): boolean`

这一步把纯判定接到真实 IO 上。抽出 `monitor-check.ts` 是因为四个平台入口都要用同一段"读 store → 判定 → 有变更就写回"的逻辑，重复四遍必然漂移。

- [ ] **Step 1: 写失败的测试**

创建 `src/tests/monitor-integration.test.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSessionMonitored } from '../scripts/lib/monitor-check.js';
import { saveMonitorStore } from '../scripts/lib/monitor-store.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';

function freshHome(): { home: string; logsConfig: CollectorLogsConfig } {
  const home = mkdtempSync(join(tmpdir(), 'nio-monitor-int-'));
  return { home, logsConfig: { path: join(home, 'audit.jsonl') } as CollectorLogsConfig };
}

function withNioHome<T>(home: string, yaml: string | null, fn: () => T): T {
  if (yaml !== null) writeFileSync(join(home, 'config.yaml'), yaml, 'utf-8');
  const prev = process.env['NIO_HOME'];
  process.env['NIO_HOME'] = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env['NIO_HOME'];
    else process.env['NIO_HOME'] = prev;
  }
}

describe('isSessionMonitored', () => {
  it('returns false for an unarmed session', () => {
    const { home, logsConfig } = freshHome();
    const result = withNioHome(home, null, () =>
      isSessionMonitored('sess-1', '/work', logsConfig));
    assert.equal(result, false);
  });

  it('returns true for an armed session', () => {
    const { home, logsConfig } = freshHome();
    saveMonitorStore(logsConfig, {
      sessions: { 'sess-1': { armed_at: Date.now(), cwd: '/work' } },
    });
    const result = withNioHome(home, null, () =>
      isSessionMonitored('sess-1', '/work', logsConfig));
    assert.equal(result, true);
  });

  it('returns true for any session when monitor_all_sessions is on', () => {
    const { home, logsConfig } = freshHome();
    const result = withNioHome(home, 'collector:\n  monitor_all_sessions: true\n', () =>
      isSessionMonitored('sess-anything', '/work', logsConfig));
    assert.equal(result, true);
  });

  it('claims a pending arm and persists the binding', () => {
    const { home, logsConfig } = freshHome();
    saveMonitorStore(logsConfig, {
      sessions: {},
      pending_arm: { at: Date.now(), cwd: '/work' },
    });
    const result = withNioHome(home, null, () =>
      isSessionMonitored('sess-new', '/work', logsConfig));
    assert.equal(result, true);

    const raw = JSON.parse(
      readFileSync(join(home, 'monitored-sessions.json'), 'utf-8'),
    ) as { sessions: Record<string, unknown>; pending_arm?: unknown };
    assert.equal('sess-new' in raw.sessions, true);
    assert.equal(raw.pending_arm, undefined);
  });

  it('never throws when the store file is corrupt', () => {
    const { home, logsConfig } = freshHome();
    writeFileSync(join(home, 'monitored-sessions.json'), 'garbage', 'utf-8');
    const result = withNioHome(home, null, () =>
      isSessionMonitored('sess-1', '/work', logsConfig));
    assert.equal(result, false);
  });

  it('does not create the store file when nothing changed', () => {
    const { home, logsConfig } = freshHome();
    withNioHome(home, null, () => isSessionMonitored('sess-1', '/work', logsConfig));
    assert.equal(existsSync(join(home, 'monitored-sessions.json')), false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/monitor-integration.test.js
```

预期：编译失败，`Cannot find module '../scripts/lib/monitor-check.js'`

- [ ] **Step 3: 写 monitor-check 实现**

创建 `src/scripts/lib/monitor-check.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Monitor check — the one place that turns the pure gate decision into
 * a filesystem-backed answer.
 *
 * All four platform entry points call this before creating any OTEL
 * provider. Keeping it in a single module means the load → decide →
 * persist sequence cannot drift between platforms.
 *
 * Fails closed: any error answers "not monitored". Telemetry must never
 * escape because a state file was unreadable, and a hook must never die
 * because of the gate.
 */

import type { CollectorLogsConfig } from '../../adapters/config-schema.js';
import { loadMonitorStore, saveMonitorStore } from './monitor-store.js';
import { resolveMonitorGate } from './monitor-gate.js';
import { loadMonitorAllSessions } from './config-loader.js';

/**
 * Decide whether this session's telemetry may be exported, persisting
 * any store change (pending-arm claim, expiry GC) as a side effect.
 */
export function isSessionMonitored(
  sessionId: string,
  cwd: string | null,
  logsConfig?: CollectorLogsConfig,
): boolean {
  try {
    const store = loadMonitorStore(logsConfig);
    const result = resolveMonitorGate({
      store,
      sessionId,
      cwd,
      monitorAllSessions: loadMonitorAllSessions(),
      nowMs: Date.now(),
    });
    if (result.changed) {
      saveMonitorStore(logsConfig, result.store);
    }
    return result.monitored;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/monitor-integration.test.js
```

预期：全部 PASS

- [ ] **Step 5: 接到 collector-hook**

修改 `src/scripts/collector-hook.ts`。当前第 70–75 行无条件创建三个 provider：

```typescript
const resourceAgentName = AGENT_NAME.length > 0 ? AGENT_NAME : undefined;
const meterProvider = createMeterProvider(config, PLATFORM, resourceAgentName);
const tracerProvider = createTracerProvider(config, PLATFORM, resourceAgentName);
const loggerProvider = (config.enabled && logsConfig.enabled !== false)
  ? createLoggerProvider(config, PLATFORM, resourceAgentName)
  : null;
```

问题在于此处还没读 stdin，拿不到 session id。所以 provider 创建必须挪到 `main()` 里、读完 stdin 之后。把上面四行删掉，并把 `main()` 改成：

```typescript
async function main(): Promise<void> {
  const input = await readStdin();
  if (!input) process.exit(0);

  // Gate before creating any provider — an unmonitored session must not
  // even initialise the OTLP exporters. The local audit log is written
  // regardless (see dispatchCollectorEvent), which is why we still call
  // dispatch with null providers instead of returning early.
  const monitored = isSessionMonitored(
    input.session_id ?? 'unknown',
    input.cwd ?? null,
    logsConfig,
  );

  const resourceAgentName = AGENT_NAME.length > 0 ? AGENT_NAME : undefined;
  const meterProvider = monitored
    ? createMeterProvider(config, PLATFORM, resourceAgentName)
    : null;
  const tracerProvider = monitored
    ? createTracerProvider(config, PLATFORM, resourceAgentName)
    : null;
  const loggerProvider = (monitored && config.enabled && logsConfig.enabled !== false)
    ? createLoggerProvider(config, PLATFORM, resourceAgentName)
    : null;

  await dispatchCollectorEvent({
    event: input.hook_event_name ?? '',
    input,
    platform: PLATFORM,
    agentName: AGENT_NAME,
    config,
    meterProvider,
    tracerProvider,
    loggerProvider,
    logsConfig,
  });

  await Promise.all([
    meterProvider?.forceFlush().catch(e => reportFlushFailure('metrics', config.endpoint, e)),
    tracerProvider?.forceFlush().catch(e => reportFlushFailure('traces', config.endpoint, e)),
    loggerProvider?.forceFlush().catch(e => reportFlushFailure('logs', config.endpoint, e)),
  ]);

  process.exit(0);
}
```

顶部加 import：

```typescript
import { isSessionMonitored } from './lib/monitor-check.js';
```

**注意**：`dispatchCollectorEvent` 在三个 provider 均为 null 时仍会写本地 audit log —— 这正是 spec 要求的行为，不要改成提前 return。

- [ ] **Step 6: 接到 guard-hook**

修改 `src/scripts/guard-hook.ts`，顶部加 import：

```typescript
import { isSessionMonitored } from './lib/monitor-check.js';
```

把第 134–146 行整段替换为：

```typescript
  // Set up OTEL providers for metrics + audit logs + traces
  const collectorConfig = loadCollectorConfig();
  const resourceAgentName = config.agent_name && config.agent_name.length > 0
    ? config.agent_name
    : undefined;
  const logsConfig = config.collector?.logs;

  // Gate telemetry export behind the session's monitor state.
  //
  // Two things deliberately stay outside the gate:
  //   1. evaluateHook below runs unconditionally — enforcement is
  //      orthogonal to capture. An unmonitored session still gets its
  //      dangerous commands blocked.
  //   2. Local audit writes continue — evaluateHook writes those via
  //      `logsConfig`, not via `loggerProvider`, so nulling the provider
  //      stops OTLP export without touching ~/.nio/audit.jsonl.
  const gatePayload = input as Record<string, unknown>;
  const monitored = isSessionMonitored(
    (gatePayload['session_id'] as string) ?? 'unknown',
    (gatePayload['cwd'] as string) ?? null,
    logsConfig,
  );

  const meterProvider = monitored
    ? createMeterProvider(collectorConfig, PLATFORM, resourceAgentName)
    : null;
  const tracerProvider = (monitored && collectorConfig.enabled)
    ? createTracerProvider(collectorConfig, PLATFORM, resourceAgentName)
    : null;
  const loggerProvider = (monitored && logsConfig?.enabled !== false)
    ? createLoggerProvider(collectorConfig, PLATFORM, resourceAgentName)
    : null;
```

注意 `logsConfig` 的声明位置从第 143 行**上移**到了 provider 创建之前——判定函数需要它来定位 store 文件。

**绝对不要改动**：第 152 行的 `evaluateHook` 调用、决策解析（`resolvedDecision` / `isBlock`）、stdout 的 block 输出。guard 的拦截行为与总闸正交。

**关于 deny 路径的 span**：第 201 行 `if (tracerProvider && hookEventName === 'PreToolUse')` 这个条件天然覆盖了新逻辑——未监控时 `tracerProvider` 为 null，拦截 span 不发出，但拦截本身照常执行，本地 audit 也照常记录。无需额外改动。

- [ ] **Step 7: 跑全量测试**

```bash
pnpm run build && pnpm test
```

预期：全部 PASS，尤其 `collector-core.test.js`、`traces-collector.test.js`、`audit-log.test.js` 无回归

- [ ] **Step 8: 提交**

```bash
git add src/scripts/lib/monitor-check.ts src/tests/monitor-integration.test.ts src/scripts/collector-hook.ts src/scripts/guard-hook.ts
git commit -m "feat(collector): gate provider creation behind session monitor state"
```

---

### Task 6: 接线 hook-cli（Hermes）

**Files:**
- Modify: `src/scripts/hook-cli.ts`（`runHermesCollector` 内的 provider 创建；guard 分支的 provider 创建）
- Test: `src/tests/monitor-hermes.test.ts`

**Interfaces:**
- Consumes: `isSessionMonitored`（Task 5）

- [ ] **Step 1: 写失败的测试**

创建 `src/tests/monitor-hermes.test.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Bundled by bun into plugins/claude-code/skills/nio/scripts/, not
// dist/scripts/ — see hook-cli.test.ts for the same resolution.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(
  HERE, '..', '..', 'plugins', 'claude-code', 'skills', 'nio', 'scripts', 'hook-cli.js',
);

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'nio-monitor-hermes-'));
}

function runHook(home: string, envelope: unknown): string {
  return execFileSync('node', [CLI, '--platform', 'hermes', '--stdin'], {
    env: { ...process.env, NIO_HOME: home },
    input: JSON.stringify(envelope),
    encoding: 'utf-8',
  });
}

describe('hermes collector gating', () => {
  it('still writes the local audit log for an unmonitored session', () => {
    const home = freshHome();
    writeFileSync(join(home, 'config.yaml'),
      'collector:\n  endpoint: "http://127.0.0.1:19999"\n', 'utf-8');

    const out = runHook(home, {
      hook_event_name: 'post_tool_call',
      tool_name: 'terminal',
      tool_input: { command: 'ls' },
      session_id: 'sess-hermes-1',
      cwd: home,
      extra: { tool_call_id: 'call-1', result: 'ok' },
    });
    assert.equal(out.trim(), '{}');

    const auditPath = join(home, 'audit.jsonl');
    assert.equal(existsSync(auditPath), true);
    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length >= 1, true);
  });

  it('emits {} on stdout regardless of monitor state', () => {
    const home = freshHome();
    const out = runHook(home, {
      hook_event_name: 'on_session_start',
      session_id: 'sess-hermes-2',
      cwd: home,
      extra: {},
    });
    assert.equal(out.trim(), '{}');
  });
});
```

- [ ] **Step 2: 跑测试确认当前状态**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/monitor-hermes.test.js
```

预期：PASS（这两条测的是"不能破坏现有契约"，接线前后都该通过）。若此时就 FAIL，说明现有行为已有问题，先修再继续。

- [ ] **Step 3: 接线**

在 `src/scripts/hook-cli.ts` 顶部加 import：

```typescript
import { isSessionMonitored } from './lib/monitor-check.js';
```

在 `runHermesCollector` 中，把三处 provider 创建加上判定。原代码：

```typescript
const meterProvider = collectorConfig.enabled ? createMeterProvider(collectorConfig, 'hermes', resourceAgentName) : null;
const tracerProvider = collectorConfig.enabled ? createTracerProvider(collectorConfig, 'hermes', resourceAgentName) : null;
const loggerProvider = (collectorConfig.enabled && logsConfig?.enabled !== false)
  ? createLoggerProvider(collectorConfig, 'hermes', resourceAgentName)
  : null;
```

改为先求出 `monitored`，再作为前置条件：

```typescript
const collectorInput = hermesToCollectorInput(rawPayload, canonicalEvent);
const monitored = isSessionMonitored(
  collectorInput.session_id ?? 'unknown',
  collectorInput.cwd ?? null,
  logsConfig,
);

const meterProvider = (monitored && collectorConfig.enabled)
  ? createMeterProvider(collectorConfig, 'hermes', resourceAgentName) : null;
const tracerProvider = (monitored && collectorConfig.enabled)
  ? createTracerProvider(collectorConfig, 'hermes', resourceAgentName) : null;
const loggerProvider = (monitored && collectorConfig.enabled && logsConfig?.enabled !== false)
  ? createLoggerProvider(collectorConfig, 'hermes', resourceAgentName)
  : null;
```

并把后面 `dispatchCollectorEvent` 的 `input:` 改为复用已算好的 `collectorInput`，避免重复构造。

guard 分支（`pre_tool_call`）的 provider 创建同样加 `monitored &&` 前置条件；**stdout 的 block 输出与 `evaluateHook` 调用不得改动**。

- [ ] **Step 4: 跑全量测试**

```bash
pnpm run build && pnpm test
```

预期：全部 PASS，`hook-cli.test.js` 无回归

- [ ] **Step 5: 提交**

```bash
git add src/scripts/hook-cli.ts src/tests/monitor-hermes.test.ts
git commit -m "feat(collector): gate hermes provider creation behind monitor state"
```

---

### Task 7: 接线 openclaw-plugin

**Files:**
- Modify: `src/adapters/openclaw-plugin.ts`
- Test: `src/tests/monitor-openclaw.test.ts`

**Interfaces:**
- Consumes: `isSessionMonitored`（Task 5）

OpenClaw 是长驻进程，provider 在插件注册时就创建了，不像其他三个平台每事件新建。所以这里的判定点不同：provider 照常创建，但在每个事件处理器内部判定，未监控则跳过所有 OTEL 写入。

- [ ] **Step 1: 写失败的测试**

创建 `src/tests/monitor-openclaw.test.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSessionMonitored } from '../scripts/lib/monitor-check.js';
import { saveMonitorStore } from '../scripts/lib/monitor-store.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';

describe('openclaw monitor gating helper', () => {
  it('gates per session id, not per process', () => {
    const home = mkdtempSync(join(tmpdir(), 'nio-monitor-oc-'));
    const logsConfig = { path: join(home, 'audit.jsonl') } as CollectorLogsConfig;
    saveMonitorStore(logsConfig, {
      sessions: { 'oc-armed': { armed_at: Date.now(), cwd: home } },
    });

    const prev = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = home;
    try {
      assert.equal(isSessionMonitored('oc-armed', home, logsConfig), true);
      assert.equal(isSessionMonitored('oc-other', home, logsConfig), false);
    } finally {
      if (prev === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = prev;
    }
  });
});
```

- [ ] **Step 2: 跑测试确认通过**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/monitor-openclaw.test.js
```

预期：PASS（`isSessionMonitored` 已在 Task 5 实现）

- [ ] **Step 3: 接线**

在 `src/adapters/openclaw-plugin.ts` 顶部加 import：

```typescript
import { isSessionMonitored } from '../scripts/lib/monitor-check.js';
```

在每个会写 OTEL 的处理器（`before_tool_call`、`after_tool_call`、`subagent_spawning`、`subagent_ended`、`before_agent_reply`、`llm_output`、`session_start`、`session_end`、`agent_end`）开头，解析出 sessionId 之后立刻判定，未监控就跳过 OTEL 部分。以 `after_tool_call` 为例：

```typescript
api.on('after_tool_call', async (event: unknown, ctx: unknown) => {
  try {
    const c = (ctx ?? {}) as { sessionKey?: string; sessionId?: string; runId?: string };
    const sessionId = c.sessionKey || c.sessionId || c.runId || 'openclaw';
    if (!isSessionMonitored(sessionId, process.cwd())) return;
    // ...原有逻辑
  } catch { /* non-critical */ }
});
```

`before_tool_call` 是唯一的例外：**guard 评估必须无条件执行**，只有其中的 OTEL 记录部分受判定控制。该处理器内的 `evaluateHook` 调用与返回的 block 决策不得包在判定之后。

- [ ] **Step 4: 跑全量测试**

```bash
pnpm run build && pnpm test
```

预期：全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/openclaw-plugin.ts src/tests/monitor-openclaw.test.ts
git commit -m "feat(collector): gate openclaw telemetry behind monitor state"
```

---

### Task 8: nio-monitor skill、SessionEnd 清理与文档

**Files:**
- Create: `plugins/shared/skills/nio-monitor/SKILL.md`
- Modify: `plugins/shared/config.default.yaml`
- Modify: `plugins/shared/skills/nio/SKILL.md`（umbrella 路由表加 monitor 行）
- Modify: `src/scripts/lib/collector-core.ts`（`SessionEnd` 分支清理 session 记录）
- Modify: `docs/COLLECTOR-SIGNALS.md`
- Test: `src/tests/monitor-lifecycle.test.ts`

- [ ] **Step 1: 写 SessionEnd 清理的失败测试**

创建 `src/tests/monitor-lifecycle.test.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetSession } from '../scripts/lib/monitor-check.js';
import { saveMonitorStore, loadMonitorStore } from '../scripts/lib/monitor-store.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';

function freshHome(): { home: string; logsConfig: CollectorLogsConfig } {
  const home = mkdtempSync(join(tmpdir(), 'nio-monitor-life-'));
  return { home, logsConfig: { path: join(home, 'audit.jsonl') } as CollectorLogsConfig };
}

describe('forgetSession', () => {
  it('removes the session record', () => {
    const { logsConfig } = freshHome();
    saveMonitorStore(logsConfig, {
      sessions: {
        'sess-1': { armed_at: Date.now(), cwd: '/work' },
        'sess-2': { armed_at: Date.now(), cwd: '/work' },
      },
    });
    forgetSession('sess-1', logsConfig);
    const store = loadMonitorStore(logsConfig);
    assert.equal('sess-1' in store.sessions, false);
    assert.equal('sess-2' in store.sessions, true);
  });

  it('is a no-op for an unknown session', () => {
    const { logsConfig } = freshHome();
    saveMonitorStore(logsConfig, {
      sessions: { 'sess-1': { armed_at: Date.now(), cwd: '/work' } },
    });
    forgetSession('sess-unknown', logsConfig);
    assert.equal('sess-1' in loadMonitorStore(logsConfig).sessions, true);
  });

  it('never throws when the store is unwritable', () => {
    const logsConfig = { path: '/proc/nonexistent/audit.jsonl' } as CollectorLogsConfig;
    assert.doesNotThrow(() => forgetSession('sess-1', logsConfig));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/monitor-lifecycle.test.js
```

预期：FAIL，`forgetSession is not exported`

- [ ] **Step 3: 实现 forgetSession**

在 `src/scripts/lib/monitor-check.ts` 末尾追加：

```typescript
/**
 * Drop a session's arm record. Called on SessionEnd so a finished
 * session does not linger in the store until the 7-day backstop.
 * Never throws — cleanup failure must not break session teardown.
 */
export function forgetSession(
  sessionId: string,
  logsConfig?: CollectorLogsConfig,
): void {
  try {
    const store = loadMonitorStore(logsConfig);
    if (!(sessionId in store.sessions)) return;
    const sessions = { ...store.sessions };
    delete sessions[sessionId];
    const next = { sessions, ...(store.pending_arm ? { pending_arm: store.pending_arm } : {}) };
    saveMonitorStore(logsConfig, next);
  } catch {
    // Cleanup is best-effort; the TTL backstop covers failures.
  }
}
```

- [ ] **Step 4: 在 collector-core 的 SessionEnd 分支调用**

修改 `src/scripts/lib/collector-core.ts`，顶部加 import：

```typescript
import { forgetSession } from './monitor-check.js';
```

在 `Stop / SubagentStop / SessionEnd` 分支末尾（`recordTurn` 之后）加：

```typescript
if (event === 'SessionEnd') {
  forgetSession(sessionId, logsConfig);
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/monitor-lifecycle.test.js && pnpm test
```

预期：全部 PASS

- [ ] **Step 6: 写 nio-monitor skill**

创建 `plugins/shared/skills/nio-monitor/SKILL.md`：

```markdown
---
name: nio-monitor
description: Nio telemetry capture switch. Use when the user wants to start or stop collecting telemetry for the current agent session — e.g. "start monitoring this session", "enable nio monitoring", "stop collecting", "is nio monitoring on". Focused single-purpose skill; for other Nio operations use /nio.
compatibility: Requires Node.js 18+.
metadata:
  author: core0-io
  version: "2.5.1"
user-invocable: true
command-arg-mode: raw
argument-hint: "[on|off|status]"
---

# Nio — Monitor

Turn telemetry capture on or off for the **current agent session**.

Nio captures nothing by default. Every session stays silent until it is explicitly armed here. Arming affects all three OTLP signals (metrics, traces, logs); it does **not** affect guard enforcement, which always runs, and does not affect the local audit log at `~/.nio/audit.jsonl`, which is always written.

> **Passive invocation.** If the user asks to start/stop monitoring, enable/disable telemetry, or check whether capture is on, you MUST run the CLI below rather than describing behaviour from memory.

## Resolving the Script Path

The CLI for this skill lives in the **sibling `nio` skill**, not in this skill's own directory:

1. This SKILL.md's parent directory is THIS skill's directory (e.g. `<plugins>/skills/nio-monitor/`).
2. The script is the sibling `nio` skill's `scripts/monitor-cli.js` — i.e. `../nio/scripts/monitor-cli.js` relative to this directory. Derive the absolute path; do **not** hard-code `~/.claude/...`.
3. Invoke with a **single** `node` command — no `cd`, no `;`/`&&`/`|`/`$(...)`/backticks.

## Routing

| Input | Action |
|-------|--------|
| `on`, `start`, or empty | Run `node ../nio/scripts/monitor-cli.js on` |
| `off`, `stop` | Run `node ../nio/scripts/monitor-cli.js off` |
| `status`, `show` | Run `node ../nio/scripts/monitor-cli.js status` |

## Interpreting the Output

The CLI prints JSON.

**`on`** returns `mode`:

- `direct` — the session id was resolved from the environment. Capture begins on the next tool call. Tell the user monitoring is on.
- `pending` — the session id was not available on this platform, so a pending arm was left in place. It is claimed by the next hook event from this directory, within 60 seconds. Tell the user monitoring will begin on their next action, and that it expires in 60s if nothing happens.

**`off`** returns `removed`: `true` if a session was armed and is now disarmed, `false` if nothing was armed.

**`status`** returns:

- `monitor_all_sessions` — the global config flag. When `true`, every session is captured regardless of per-session state.
- `monitored` — whether the current session is being captured right now.
- `armed_sessions` — how many sessions are armed in total.

## Scope of Capture

When a session is armed, these are exported to the configured OTLP endpoint:

- **traces** — turn / tool-call spans
- **metrics** — tool-use and guard-decision counters
- **logs** — audit records

When it is not armed, none of the three leave the machine.

## What This Does Not Control

| Behaviour | Affected by this switch? |
|-----------|--------------------------|
| Guard blocking dangerous commands | No — always active |
| Risk scoring (Phase 0–6) | No — always active |
| Local `~/.nio/audit.jsonl` | No — always written |
| OTLP export of metrics/traces/logs | **Yes** |

## Notes

- Capture takes effect from the **next** hook event; the currently executing tool call is not retroactively captured.
- There is no backfill. Anything that happened before `on` is not captured.
- Records expire after 7 days as a backstop; `SessionEnd` normally clears them sooner.
- To capture every session without arming each one, set `collector.monitor_all_sessions: true` in `~/.nio/config.yaml`.
```

- [ ] **Step 7: 在 umbrella skill 挂载**

`plugins/shared/skills/nio/SKILL.md` 有四处需要同步改：

**7a. frontmatter 的 `argument-hint`（第 12 行）**

```yaml
argument-hint: "[scan|action|report|config|doctor|external-score|monitor|reset] [args...]"
```

**7b. 子命令清单（"Parse `$ARGUMENTS`" 之后的列表）**，在 `external-score` 与 `reset` 之间插入：

```markdown
- **`monitor [on|off|status]`** — Turn telemetry capture on or off for the current session
```

**7c. Focused skills 表格**，在 `nio-external-score` 行之后加：

```markdown
| `nio-monitor` | Turn telemetry capture on/off for this session | `monitor` |
```

**7d. Routing 表格**，加三行：

```markdown
| `monitor`, `monitor on` | Run `node scripts/monitor-cli.js on` and report the returned `mode` |
| `monitor off` | Run `node scripts/monitor-cli.js off` |
| `monitor status` | Run `node scripts/monitor-cli.js status` |
```

- [ ] **Step 8: 更新配置模板**

打开 `plugins/shared/config.default.yaml`，在 `collector:` 段的 `endpoint` 之后加：

```yaml
  # Session-level capture switch.
  #
  # false (default) — no session exports telemetry until it is explicitly
  #   armed with `/nio-monitor` inside that session.
  # true            — every session exports telemetry (CI / team machines).
  #
  # Guard enforcement and the local audit log are unaffected either way.
  monitor_all_sessions: false
```

- [ ] **Step 9: 更新信号文档**

打开 `docs/COLLECTOR-SIGNALS.md`，在 "Architecture" 一节之后插入新的一节：

```markdown
## Capture gating

Nio exports nothing by default. Each of the three signals is created only
for sessions the user explicitly armed with `/nio-monitor`, or for every
session when `collector.monitor_all_sessions: true` is set.

The gate sits **before OTEL provider creation** — an unmonitored session
does not initialise exporters at all, so the cost is one small file read
per hook event.

Two things are outside the gate:

- **Guard enforcement.** Phase 0–6 risk evaluation and blocking run
  regardless. The switch controls reporting, not enforcement.
- **Local audit log.** `~/.nio/audit.jsonl` is written regardless, since
  it never leaves the machine and backs `/nio report`.

State lives in `${NIO_HOME}/monitored-sessions.json`, separate from
`traces-state-store.json` — session-scoped durable state versus
turn-scoped ephemeral state.

There is **no backfill**: capture starts at the moment `/nio-monitor`
runs. Platforms differ in whether historical session data exists at all
(Claude Code and Codex keep session files; Hermes and OpenClaw do not),
so retroactive capture is not offered anywhere, keeping behaviour uniform.
```

- [ ] **Step 10: 构建并验证 skill 同步**

```bash
pnpm run build
ls plugins/claude-code/skills/nio-monitor/SKILL.md
ls plugins/codex/skills/nio-monitor/SKILL.md
ls plugins/claude-code/skills/nio/scripts/monitor-cli.js
```

预期：三个文件都存在。`sync-shared.js` 会自动同步所有 `nio-*` 目录到 Claude Code 与 Codex（OpenClaw / Hermes 只拿 umbrella skill，符合现有约定）。

- [ ] **Step 11: 跑全量测试**

```bash
pnpm test
```

预期：全部 PASS

- [ ] **Step 12: 提交**

```bash
git add plugins/shared/skills/nio-monitor/ plugins/shared/skills/nio/SKILL.md \
        plugins/shared/config.default.yaml docs/COLLECTOR-SIGNALS.md \
        src/scripts/lib/monitor-check.ts src/scripts/lib/collector-core.ts \
        src/tests/monitor-lifecycle.test.ts plugins/claude-code/skills/ plugins/codex/skills/
git commit -m "feat(collector): add nio-monitor skill, SessionEnd cleanup and docs"
```

---

### Task 9: 端到端验收

**Files:**
- Test: `src/tests/monitor-e2e.test.ts`

这个任务不写新功能，只验证整条链路在真实子进程里成立。

- [ ] **Step 1: 写端到端测试**

创建 `src/tests/monitor-e2e.test.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Bundled by bun into plugins/claude-code/skills/nio/scripts/, not
// dist/scripts/ — see hook-cli.test.ts for the same resolution.
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', '..', 'plugins', 'claude-code', 'skills', 'nio', 'scripts');
const COLLECTOR = join(SCRIPTS, 'collector-hook.js');
const MONITOR = join(SCRIPTS, 'monitor-cli.js');

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'nio-monitor-e2e-'));
  // Point at a closed port: if the gate leaks, the exporter will try to
  // reach it and we can detect the attempt via diagnostics.
  writeFileSync(join(home, 'config.yaml'),
    'collector:\n  endpoint: "http://127.0.0.1:19999"\n', 'utf-8');
  return home;
}

function fireHook(home: string, payload: unknown): void {
  execFileSync('node', [COLLECTOR, '--platform', 'claude-code'], {
    env: { ...process.env, NIO_HOME: home },
    input: JSON.stringify(payload),
    encoding: 'utf-8',
  });
}

function preToolUse(sessionId: string, cwd: string): unknown {
  return {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    cwd,
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_use_id: 'toolu_e2e_1',
  };
}

describe('monitor gate end-to-end', () => {
  it('writes local audit but no trace state when unmonitored', () => {
    const home = freshHome();
    fireHook(home, preToolUse('sess-e2e-off', home));

    assert.equal(existsSync(join(home, 'audit.jsonl')), true,
      'local audit log must be written even when unmonitored');
    assert.equal(existsSync(join(home, 'traces-state-store.json')), false,
      'no tracer provider means no pending span state');
  });

  it('creates trace state once the session is armed', () => {
    const home = freshHome();
    execFileSync('node', [MONITOR, 'on'], {
      env: { ...process.env, NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-e2e-on' },
      cwd: home,
      encoding: 'utf-8',
    });

    fireHook(home, preToolUse('sess-e2e-on', home));

    assert.equal(existsSync(join(home, 'traces-state-store.json')), true,
      'armed session must open a pending span');
    const state = JSON.parse(
      readFileSync(join(home, 'traces-state-store.json'), 'utf-8'),
    ) as { session_id: string; pending_spans: Record<string, unknown> };
    assert.equal(state.session_id, 'sess-e2e-on');
    assert.equal('toolu_e2e_1' in state.pending_spans, true);
  });

  it('stops creating trace state after off', () => {
    const home = freshHome();
    const env = { ...process.env, NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-e2e-toggle' };
    execFileSync('node', [MONITOR, 'on'], { env, cwd: home, encoding: 'utf-8' });
    execFileSync('node', [MONITOR, 'off'], { env, cwd: home, encoding: 'utf-8' });

    fireHook(home, preToolUse('sess-e2e-toggle', home));
    assert.equal(existsSync(join(home, 'traces-state-store.json')), false);
  });

  it('monitor_all_sessions captures without arming', () => {
    const home = mkdtempSync(join(tmpdir(), 'nio-monitor-e2e-all-'));
    writeFileSync(join(home, 'config.yaml'),
      'collector:\n  endpoint: "http://127.0.0.1:19999"\n  monitor_all_sessions: true\n',
      'utf-8');

    fireHook(home, preToolUse('sess-e2e-all', home));
    assert.equal(existsSync(join(home, 'traces-state-store.json')), true);
  });
});
```

- [ ] **Step 2: 跑端到端测试**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/monitor-e2e.test.js
```

预期：4 条全部 PASS

- [ ] **Step 3: 跑全量测试与类型检查**

```bash
pnpm run build && pnpm test && pnpm run typecheck
```

预期：全部 PASS，无类型错误

- [ ] **Step 4: 提交**

```bash
git add src/tests/monitor-e2e.test.ts
git commit -m "test(collector): add end-to-end coverage for the monitor gate"
```

- [ ] **Step 5: 写 changeset**

```bash
pnpm version-select
```

选 `minor`，描述填：

```
Add session-level telemetry capture gate. Nio now captures nothing by
default — arm a session with `/nio-monitor` to start exporting metrics,
traces and logs. Guard enforcement and the local audit log are
unaffected. Set `collector.monitor_all_sessions: true` to restore
blanket capture.
```

提交 changeset：

```bash
git add .changeset/
git commit -m "chore: add changeset for session monitor gate"
```

---

## Phase 2 调研清单（不属于本 plan 的 TDD 范围）

以下为 Plan 2（trace 骨架 + 内容管线）动工前必须取得的事实。每项都要产出**真实样本文件**存进 `src/tests/fixtures/`，而不只是结论描述。

| # | 待验证 | 方法 | 产出物 |
|---|---|---|---|
| 1 | Codex rollout JSONL 的条目结构 | 跑一次真实 Codex 会话，找到 `~/.codex/sessions/**/rollout-*.jsonl`，统计 entry `type` 与消息结构 | `src/tests/fixtures/codex/rollout-sample.jsonl`（脱敏） |
| 2 | Codex rollout 是否含 reasoning / thinking | 在样本里检索 reasoning 相关块 | 结论写入 spec 的平台矩阵 |
| 3 | Hermes `post_llm_call` 完整 payload | 临时把 `hook-cli.js` 换成 `tee` 脚本 dump 一次 envelope | `src/tests/fixtures/hermes/post-llm-call.json`（脱敏） |
| 4 | Hermes 是否提供 transcript 路径 | 同上，检查 envelope 里有无路径字段 | 决定 spec Phase 6 的修法 |
| 5 | OpenClaw `llm_output` 是否含 reasoning | 查上游事件类型定义 + 实机 dump | 结论写入平台矩阵 |
| 6 | Codex / Hermes / OpenClaw 的 session id 环境变量 | 各平台内跑 `env \| grep -i session` | 补进 `monitor-cli.ts` 的 `SESSION_ENV_VARS` |

调研完成后更新 spec 的"平台覆盖矩阵"，把 ❓ 换成结论，再开始写 Plan 2。

---

## 验收标准

Phase 1 完成的判据：

- [ ] 全新安装、未执行 `/nio-monitor` 时，任何 session 都不向 OTLP 端点发送 metrics / traces / logs
- [ ] 执行 `/nio-monitor` 后，该 session 从下一个 hook 事件开始正常上报三个信号
- [ ] `/nio-monitor off` 后立即停止上报
- [ ] `collector.monitor_all_sessions: true` 时无需 arming 即全量上报
- [ ] 在所有上述状态下，`rm -rf /` 一律被 guard 拦截
- [ ] 在所有上述状态下，`~/.nio/audit.jsonl` 一律照常写入
- [ ] `pnpm test` 全绿，`pnpm run typecheck` 无错误
- [ ] 没有任何测试写入真实 `~/.nio/` 或其他真实用户路径
