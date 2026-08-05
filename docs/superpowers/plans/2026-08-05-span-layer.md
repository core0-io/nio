# Span 层实施计划（Phase 3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 trace 结构从「turn → tool」两层改成「session ⇢ turn → chat → tool」，让一条 trace 能读出 `prompt → 思考 → 调工具 → 再思考 → 结果` 的完整链条。

**Architecture:** 工具 span 不再即时发出，而是暂存到 state；turn 结束时从 `ConversationSource` 取回本轮的 `ChatCall[]`，生成 chat span，把工具 span 归属到发起它的那次调用之下，然后整棵树一次性发出。session 自成一条短 trace，turn 用 span link 指向它。

**Tech Stack:** TypeScript / Node 18+ / node:test / OpenTelemetry SDK

**对应 spec:** `docs/superpowers/specs/2026-08-04-traces-full-capture-design.md` 的「二、Trace 模型 v2」

**前置（均已交付）:**
- `src/scripts/lib/conversation/` — 四平台的 `ConversationSource`，产出 `ChatCall[]`
- `src/scripts/lib/content/` — 脱敏、截断、日志记录构造

## Global Constraints

- 新文件以 `// Copyright 2026 core0-io` + `// SPDX-License-Identifier: Apache-2.0` 开头，紧跟 `export {};`
- 测试用 `node:test` + `node:assert/strict`，不引入新依赖
- 测试临时目录一律 `mkdtempSync`，**严禁**读写真实 `~/.nio/` 等用户路径
- spawn 子进程的测试必须带 `timeout`（本仓库有 CI 挂死前科）
- 遥测永不破坏宿主：新路径包 try/catch，失败走 `reportDiagnostic`
- **guard 拦截能力与遥测完全正交**：`evaluateHook` 的调用、决策解析、stdout 输出、exit code 一律不得改动
- **本地 `~/.nio/audit.jsonl` 始终写入**，不受任何 span 层改动影响
- 跑测试前 `pnpm run build`；`--import ./dist/tests/helpers/isolate-nio-home.js` 不能省
- 每个任务完成后跑全量 `pnpm test`，**当前基线见 ledger**（Task 1 开始时约 1400）
- git commit 不带 `Co-Authored-By` 之类 AI 署名 trailer
- 不新建分支（在 `traces-track` 上）
- 不要 `git add` `dist/`、`plugins/**/scripts/*.js`、`pnpm-lock.yaml`

## 风险提示：本 plan 改动的是所有平台共用的核心

`traces-collector.ts` 与 `collector-core.ts` 被四个平台共同依赖。每个任务完成后必须确认这些既有测试无回归：

```
collector-core.test.js · traces-collector.test.js · traces-state-store.test.js
hook-cli.test.js · monitor-e2e.test.js · smoke.test.js
```

其中 `smoke.test.js` 与 `monitor-e2e.test.js` 是 guard 正交性的守护网——它们绿着，才说明拦截没被遥测改动波及。

## 测试质量要求

本仓库已被评审抓出**八次**「测试通过但实际什么都没测」。每个任务都要求**变异验证**：把核心逻辑改成退化实现，确认对应测试转红；还原后转绿。结果写进报告。做不到转红就如实报告，不要硬凑。

---

### Task 1: state 扩展 —— 延迟 span 与 session trace

**Files:**
- Modify: `src/scripts/lib/traces-state-store.ts`
- Test: `src/tests/traces-state-store.test.ts`（扩充既有文件）

**Interfaces:**
- Produces:
  - `interface DeferredSpan`
  - `CollectorState` 新增 `deferred_spans?` / `session_trace_id?` / `session_span_id?` / `session_start_ms?`

延迟发送要求把「已结束但尚未发出」的 span 暂存起来。session trace 要求 turn 侧能在 session 结束前就拿到 session 的 span id（用于 span link），所以它必须在 `SessionStart` 时预生成并持久化。

```typescript
/**
 * A span that has finished but is being held back until the turn ends.
 *
 * Tool spans can only be nested under the chat call that issued them,
 * and that attribution is not knowable at PostToolUse time — it comes
 * from the transcript once the turn is complete. So finished tool spans
 * park here, and the whole tree is emitted together at endTurn.
 *
 * Only metadata lives here. Content (prompts, thinking, results) goes
 * out through the logs signal as it happens, keyed by the span id that
 * was pre-allocated at PreToolUse — otherwise this file would grow with
 * every tool call and the per-event read/write would degrade.
 */
export interface DeferredSpan {
  kind: 'tool' | 'task';
  name: string;
  span_id: string;
  start_ms: number;
  end_ms: number;
  attributes: Record<string, unknown>;
  /** Sets the span status to ERROR and records an exception. */
  error?: string;
  /** Used to attribute this span to the chat call that issued it. */
  tool_use_id?: string;
}
```

`CollectorState` 追加：

```typescript
  /** Finished spans awaiting the end-of-turn flush. */
  deferred_spans?: DeferredSpan[];
  /** Session-level trace. Minted at SessionStart so turns can link to it. */
  session_trace_id?: string;
  session_span_id?: string;
  session_start_ms?: number;
```

- [ ] **Step 1: 写测试**

在 `src/tests/traces-state-store.test.ts` 追加一个 describe，覆盖：

- 含 `deferred_spans` 的 state 能完整往返（save → load 后深度相等）
- 含 session trace 三字段的 state 能完整往返
- 旧格式的 state（无这些字段）load 后不报错，新字段为 `undefined`（**向后兼容**——升级时磁盘上还是旧格式）
- `deferred_spans` 为空数组与为 `undefined` 都能往返

最后一条别省：空数组与缺省在 JSON 里是两种表示，混淆会让「有没有待发 span」的判断出错。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/traces-state-store.test.js
```

- [ ] **Step 3: 实现**

只加类型与字段，不动任何读写逻辑（`loadState` / `saveState` 是透明的 JSON 往返，无需改动）。

- [ ] **Step 4: 跑测试 + 全量回归**

- [ ] **Step 5: 变异验证**

把 `deferred_spans` 从 `CollectorState` 里删掉，确认往返测试**编译失败或转红**。若类型层面删掉只是编译错误而非测试红，如实说明——这是类型定义任务的正常情况。

- [ ] **Step 6: 提交**

```bash
git add src/scripts/lib/traces-state-store.ts src/tests/traces-state-store.test.ts
git commit -m "feat(collector): extend state for deferred spans and session trace"
```

---

### Task 2: ConversationSource 平台分发

**Files:**
- Create: `src/scripts/lib/conversation/factory.ts`
- Test: `src/tests/conversation-factory.test.ts`

**Interfaces:**
- Produces: `createSourceForPlatform(platform, input): ConversationSource | null`

```typescript
export interface SourceInput {
  /** Replay platforms: path to the session file. */
  transcriptPath?: string | null;
  /** Hermes: the post_llm_call envelope. */
  payload?: unknown;
  /** OpenClaw: accumulated events. */
  events?: unknown[];
}
```

分发规则：

| platform | 用哪个 source | 需要的输入 |
|---|---|---|
| `claude-code` | `createClaudeCodeSource` | `transcriptPath` |
| `codex` | `createCodexSource` | `transcriptPath` |
| `hermes` | `createHermesSource` | `payload` |
| `openclaw` | `createOpenClawSource` | `events` |

**输入缺失时返回 `null`**，不抛。调用方据此跳过 chat span 生成、退回到「只有 turn 与 tool 两层」的旧行为——这是本 plan 的降级路径，必须走得通。

- [ ] **Step 1–6: 写测试、实现、变异验证、提交**

测试至少覆盖：四个平台各自返回正确的 source（用 `source.name` 断言）、输入缺失返回 `null`、未知平台返回 `null`。

变异：把 hermes 分支错接到 codex source，确认对应断言转红。

```bash
git commit -m "feat(conversation): dispatch platform to its ConversationSource"
```

---

### Task 3: 延迟发送 + chat span + tool 归属（核心）

**Files:**
- Modify: `src/scripts/lib/traces-collector.ts`
- Create: `src/scripts/lib/chat-span.ts`
- Modify: `src/scripts/lib/collector-core.ts`
- Test: `src/tests/chat-span.test.ts`

这是本 plan 最大的一个任务，也是唯一会改变现有 span 输出形态的一个。

**三步改动：**

**(a) `recordPostToolUse` 不再发送 span。**

当前签名：

```typescript
export async function recordPostToolUse(
  provider: NodeTracerProvider, state: CollectorState, spanKey: string,
  cwd: string | null, postAttributes?: Record<string, unknown>, error?: string | null,
): Promise<PostSpanResult>
```

改为不接收 `provider`、不发送、返回把 span 塞进 `deferred_spans` 后的新 state：

```typescript
export function deferPostToolUse(
  state: CollectorState, spanKey: string, cwd: string | null,
  postAttributes?: Record<string, unknown>, error?: string | null,
): PostSpanResult
```

保留 `PostSpanResult { state, durationMs }` 的形状——调用方还要用 `durationMs` 记 metrics。

**保留 `recordPostToolUse` 作为薄封装**（内部调 `deferPostToolUse` 再立即 flush 单个 span），供 guard 的 deny 路径使用——那条路径必须立即可见，不能等到 turn 结束（详见下方「deny 路径」）。

**(b) 新模块 `chat-span.ts` 负责把 `ChatCall[]` 与 `DeferredSpan[]` 组装成一棵树。**

```typescript
export interface SpanTree {
  chats: Array<{
    span_id: string;
    call: ChatCall;
    tools: DeferredSpan[];
  }>;
  /** Tool spans that could not be attributed to any chat call. */
  orphans: DeferredSpan[];
}

export function buildSpanTree(calls: ChatCall[], deferred: DeferredSpan[]): SpanTree;
```

**归属规则，按优先级：**

1. **`tool_use_id` 精确匹配** —— `DeferredSpan.tool_use_id` 等于某个 `ChatCall` 的 `tool_use` 块里的 `toolUse.id`。Claude Code / Codex / Hermes 都提供得了，这是主路径。
2. **时间落点** —— tool 的 `start_ms` 落在 `[call.startMs, nextCall.startMs)` 区间内。**仅当该 call 的 `timing !== 'synthetic'` 时才启用**——合成的时间戳做区间判断毫无意义，会把工具随机挂到某次调用下。
3. **归为 orphan** —— 上面都不成立时不猜，挂到 turn 之下（保持旧行为）。

第 2 条的 `timing` 前提是硬要求。数据层已经在 `ChatCall.timing` 上标好了可信度，这里必须尊重它。

**(c) `endTurn` 改为发送整棵树。**

新签名接收 `calls`：

```typescript
export async function endTurn(
  provider: NodeTracerProvider, state: CollectorState, cwd: string | null,
  transcriptPath?: string | null, calls?: ChatCall[],
): Promise<CollectorState | null>
```

发送顺序：先 chat span（parent = turn 的合成 span id），再 tool span（parent = 所属 chat 的 span id；orphan 的 parent = turn），最后 turn root span。全部 `span.end()` 之后一次 `forceFlush()`。

**`calls` 为空或未提供时**：退回旧行为——所有 deferred span 直接挂 turn 下。这是降级路径，必须有测试。

**chat span 的属性**（spec 已定）：

```
gen_ai.operation.name          'chat'
gen_ai.request.model           call.model
gen_ai.response.id             call.callId
gen_ai.usage.input_tokens      call.usage.input
gen_ai.usage.output_tokens     call.usage.output
gen_ai.usage.cache_read.input_tokens      call.usage.cacheRead
gen_ai.usage.cache_creation.input_tokens  call.usage.cacheWrite
gen_ai.response.finish_reasons  call.stopReason
nio.content.thinking_chars     thinking 块字符总数
nio.content.text_chars         text 块字符总数
nio.content.blocks             blocks.length
nio.chat.is_sidechain          call.isSidechain
nio.chat.timing                call.timing        ← 让消费者知道 duration 可不可信
```

`nio.chat.timing` 别省——它是数据层辛苦标出来的，不透传等于白标。

- [ ] **Step 1: 写 `buildSpanTree` 的单元测试**

这是纯函数，先把它测扎实。覆盖：

- `tool_use_id` 精确匹配：两个 chat、各带一个 tool，断言各归各位
- 时间落点：`timing: 'exact'` 的 call，tool 按 `start_ms` 落入正确区间
- **`timing: 'synthetic'` 时不启用时间落点**：构造一个只能靠时间匹配的场景，断言 tool 变成 orphan 而不是被猜着挂上去
- 无 `calls` 时全部为 orphan
- 无 deferred span 时 chats 各自 tools 为空
- 同一个 `tool_use_id` 出现在多个 call（异常数据）时不重复挂

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 `chat-span.ts`**

- [ ] **Step 4: 改 `traces-collector.ts` 与 `collector-core.ts`**

`collector-core.ts` 的 PostToolUse 分支改用 `deferPostToolUse`，并把返回的 state 存回。Stop/SubagentStop/SessionEnd 分支在调 `endTurn` 前，用 Task 2 的 factory 取 `calls`。

**deny 路径必须保持即时**：`guard-hook.ts` 里拦截时发的一次性 span 继续走 `recordPostToolUse`（立即 flush）。安全事件不能等到 turn 结束才可见——这条在 spec 里有明确论证，别改成延迟。

- [ ] **Step 5: 写端到端测试**

用 `InMemorySpanExporter` 跑一个完整 turn：PreToolUse → PostToolUse → PostToolUse → Stop（带两个 ChatCall），断言：

- 发出的 span 数 = 2 chat + 2 tool + 1 turn = 5
- 每个 tool span 的 `parentSpanId` 等于其所属 chat 的 span id
- chat span 的 `parentSpanId` 等于 turn 的 span id
- turn span 无 parent（是 root）
- 属性齐全，特别是 `nio.chat.timing`

再跑一个降级场景：不提供 `calls`，断言 2 tool + 1 turn = 3 个 span，tool 直接挂 turn。

- [ ] **Step 6: 全量回归**

**这一步最关键。** 确认前述六个既有测试文件全绿，尤其 `smoke.test.js` 与 `monitor-e2e.test.js`（guard 正交性）。

- [ ] **Step 7: 变异验证**

- 把 `buildSpanTree` 的 `tool_use_id` 匹配删掉 → 归属测试转红
- 把 `timing: 'synthetic'` 的守卫删掉 → 「synthetic 不猜」那条转红
- 把 chat span 的 parent 设成 turn 而非各自的 chat → 端到端的父子断言转红

- [ ] **Step 8: 提交**

```bash
git commit -m "feat(collector): nest tool spans under the chat call that issued them"
```

---

### Task 4: session 独立 trace 与 span link

**Files:**
- Modify: `src/scripts/lib/traces-collector.ts`
- Modify: `src/scripts/lib/collector-core.ts`
- Test: `src/tests/session-trace.test.ts`

`SessionStart` 时生成 session trace id 与 span id 存入 state；`SessionEnd` 时发出 session span；每条 turn trace 的 root span 带一个 span link 指向 `(session_trace_id, session_span_id)`。

**为什么 session 不做成包住所有 turn 的父 span**：一条会话可能持续数小时、包含上千个 span，做成一棵树会让后端查询与 UI 都吃不消，而且 root 要等会话结束才能发。OTel GenAI 约定里 session 也是属性而非 span。span link 是折中——保留可跳转的关联，不牺牲 trace 体积。

**session span 同样面临「崩溃就发不出」的问题**，由 Task 5 的补发机制一并覆盖。

- [ ] **Step 1–6: 写测试、实现、变异验证、提交**

测试覆盖：SessionStart 后 state 有三个 session 字段、turn root span 带指向正确 trace/span 的 link、SessionEnd 发出 session span、没有 session 字段时 turn 照常发出（无 link，降级）。

变异：删掉 span link 的添加，确认对应断言转红。

```bash
git commit -m "feat(collector): give sessions their own trace and link turns to it"
```

---

### Task 5: 崩溃补发整棵树

**Files:**
- Modify: `src/scripts/lib/collector-core.ts`
- Test: `src/tests/deferred-recovery.test.ts`

延迟发送把崩溃的代价放大了：以前进程被杀只丢一个 root span，子 span 已经发出去了；现在**整棵树都还在 state 里**，一起丢。

好在 state 是落盘的，数据还在。补发分两处：

**(a) 惰性补发** —— 任一事件进入时，若 state 里有 `deferred_spans` 但当前 turn 已经不是那一轮（`session_id` 变了，或 `turn_trace_id` 为空），就把遗留的树补发出去，root span 标 `nio.turn.incomplete = true`。

**(b) SessionStart 扫描** —— 会话开始时检查 state 里有没有上次崩溃遗留的树，有就补发。这是「用户再也不发第三个事件」情况下的兜底。

补发用的 trace id 取 state 里遗留的 `turn_trace_id`，不要新生成——否则补出来的树和先前已发出的内容日志对不上。

- [ ] **Step 1–6: 写测试、实现、变异验证、提交**

测试覆盖：构造一个带 `deferred_spans` 且 `turn_trace_id` 已清空的 state，触发一个事件，断言遗留 span 被发出且 root 带 `incomplete` 标记；补发后 `deferred_spans` 被清空（不重复发）；SessionStart 路径同样生效。

变异：删掉补发逻辑，确认对应断言转红。

```bash
git commit -m "feat(collector): recover the whole deferred tree after a crash"
```

---

### Task 6: 内容日志接线与四平台接入

**Files:**
- Modify: `src/scripts/lib/collector-core.ts`
- Modify: `src/scripts/lib/logs-collector.ts`
- Modify: `src/scripts/collector-hook.ts` / `guard-hook.ts` / `hook-cli.ts` / `src/adapters/openclaw-plugin.ts`
- Test: `src/tests/content-wiring.test.ts`

把 `buildContentRecords`（内容管线）接到真实的 logger provider 上，并把 `ConversationSource` 注入四个平台的入口。

**内容日志的发送时机**：chat span 生成时（`endTurn` 内），因为那时才有真实的 span id。虽然 spec 原本设想「内容实时发、结构延迟发」，但内容记录必须带 span id 才能关联，而 span id 要等 chat span 分配——所以内容也随树一起发。

**这意味着 spec 里「内容实时发」那句需要修正**：本任务完成后同步更新 spec 与 `docs/COLLECTOR-SIGNALS.md`，如实描述实际时序。

**`emitAuditLog` 当前不传 context**，导致 log record 的 trace_id / span_id 为空。本任务要把 span context 显式传进去——这是内容与 trace 关联的前提。

- [ ] **Step 1–7: 写测试、实现、更新文档、变异验证、提交**

测试覆盖：一个 turn 的内容记录带正确的 trace_id / span_id（内建 + 冗余属性各一份）、内容经过脱敏与截断、四个平台的入口都能取到 source。

变异：把传给 `buildContentRecords` 的 span id 换成空串，确认关联断言转红。

```bash
git commit -m "feat(collector): emit conversation content alongside the span tree"
```

---

## 验收标准

- [ ] 一条 turn trace 读得出 `prompt → 思考 → 调工具 → 再思考 → 结果`
- [ ] 工具 span 嵌套在发起它的 chat span 之下；无法归属时挂 turn 而不是乱猜
- [ ] `timing: 'synthetic'` 的调用不参与时间落点归属
- [ ] session 自成一条 trace，turn 通过 span link 指向它
- [ ] 崩溃后整棵树能被补发，标记 `incomplete`，不重复发
- [ ] 内容记录带 trace/span 关联，经过脱敏与截断
- [ ] 无 `ConversationSource` 时降级为旧的两层结构，不报错
- [ ] guard 的 deny 路径仍然即时可见，不等 turn 结束
- [ ] `pnpm test` 全绿，`pnpm run typecheck` 无错
- [ ] `smoke.test.js` 与 `monitor-e2e.test.js` 全绿（guard 正交性未被波及）
- [ ] 每个任务的变异验证结果已写入报告
