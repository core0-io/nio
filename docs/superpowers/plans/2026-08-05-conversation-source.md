# ConversationSource 数据层实施计划（Phase 4 上半）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把四个平台各不相同的会话数据归一成同一个 `ChatCall[]` 中间表示，供后续的 chat span 与内容日志消费。

**Architecture:** 一个接口 + 两种实现。`TranscriptReplaySource` 读会话文件（Claude Code / Codex），`StreamingSource` 从实时事件累积（Hermes / OpenClaw）。上层只认 `ChatCall[]`，不感知来源。

**Tech Stack:** TypeScript / Node 18+ / node:test

**对应 spec:** `docs/superpowers/specs/2026-08-04-traces-full-capture-design.md` 的「三、内容管线」

**为什么先做这个:** spec 原本把它归在 Phase 4、说与 Phase 3 无依赖。实际相反——Phase 3 的 chat span 需要知道「一个 turn 里有几次 LLM 调用、边界在哪」，这个信息只有本层能给。没有它，chat span 无从生成，tool 也无处嵌套。

## Global Constraints

- 新文件以 `// Copyright 2026 core0-io` + `// SPDX-License-Identifier: Apache-2.0` 开头，紧跟 `export {};`
- 测试用 `node:test` + `node:assert/strict`，不引入新依赖
- 测试临时目录一律 `mkdtempSync`，**严禁**读写真实 `~/.nio/`、`~/.hermes/`、`~/.codex/`、`~/.claude/`
- **本层不做任何 IO 之外的副作用**：不写文件、不发网络、不碰 OTEL provider。它只把字节变成结构
- 解析永不抛异常：任何畸形输入退化为「该项不可得」，返回空或省略字段，不中断整体解析
- 跑测试前 `pnpm run build`；`--import ./dist/tests/helpers/isolate-nio-home.js` 不能省
- 每个任务完成后跑全量 `pnpm test`，**当前基线 1294**
- git commit 不带 `Co-Authored-By` 之类 AI 署名 trailer
- 不新建分支（在 `traces-track` 上）
- 不要 `git add` `dist/`、`plugins/**/scripts/*.js`、`pnpm-lock.yaml`

## 测试质量要求

本仓库前两轮被评审抓出**七次**「测试通过但实际什么都没测」。因此每个任务都要求：

**做变异验证** —— 把该任务的核心逻辑改成退化实现（返回空数组 / 恒定值），确认对应测试转红；还原后转绿。两次结果写进报告。**做不到转红就如实报告，不要硬凑**。

## fixture 的隐私红线

真实采集的会话文件含开发者的完整对话与 system prompt，**一律不得入库**。所有 fixture 必须是按真实结构手工合成的：字段名、嵌套形态、条目顺序与真实文件一致，内容全部替换为无意义占位（`"user message 1"` / `"assistant reply 1"` 之类）。

Hermes / OpenClaw 的 fixture 另需在文件头注明数据来源与验证状态（见各任务）。

---

### Task 1: ChatCall 中间表示与 ConversationSource 接口

**Files:**
- Create: `src/scripts/lib/conversation/types.ts`
- Test: `src/tests/conversation-types.test.ts`

**Interfaces:**
- Produces:
  - `type ThinkingFidelity = 'full' | 'summary'`
  - `interface ContentBlock`
  - `interface ChatCall`
  - `interface ConversationSource`

本任务只定义类型与一个纯函数，不含任何解析逻辑。

- [ ] **Step 1: 写测试**

创建 `src/tests/conversation-types.test.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blockOrderIsSane, type ChatCall } from '../scripts/lib/conversation/types.js';

function call(overrides: Partial<ChatCall> = {}): ChatCall {
  return {
    callId: 'req_1',
    startMs: 1000,
    endMs: 2000,
    blocks: [],
    isSidechain: false,
    ...overrides,
  };
}

describe('blockOrderIsSane', () => {
  it('accepts contiguous zero-based indices', () => {
    const c = call({ blocks: [
      { type: 'thinking', index: 0, content: 'x', fidelity: 'full' },
      { type: 'text', index: 1, content: 'y' },
      { type: 'tool_use', index: 2, content: '{}', toolUse: { id: 't1', name: 'Bash', input: '{}' } },
    ] });
    assert.equal(blockOrderIsSane(c), true);
  });

  it('accepts an empty block list', () => {
    assert.equal(blockOrderIsSane(call()), true);
  });

  it('rejects a gap in the sequence', () => {
    const c = call({ blocks: [
      { type: 'text', index: 0, content: 'a' },
      { type: 'text', index: 2, content: 'b' },
    ] });
    assert.equal(blockOrderIsSane(c), false);
  });

  it('rejects duplicate indices', () => {
    const c = call({ blocks: [
      { type: 'text', index: 0, content: 'a' },
      { type: 'text', index: 0, content: 'b' },
    ] });
    assert.equal(blockOrderIsSane(c), false);
  });

  it('rejects blocks that are not sorted by index', () => {
    const c = call({ blocks: [
      { type: 'text', index: 1, content: 'b' },
      { type: 'text', index: 0, content: 'a' },
    ] });
    assert.equal(blockOrderIsSane(c), false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/conversation-types.test.js
```

- [ ] **Step 3: 实现**

创建 `src/scripts/lib/conversation/types.ts`：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * The normalised shape every platform's conversation data collapses to.
 *
 * Four host platforms expose their LLM turns in four different ways —
 * Claude Code and Codex write session files, Hermes and OpenClaw emit
 * live events. Rather than teach the span layer all four dialects, each
 * platform gets a `ConversationSource` implementation that produces this
 * one structure.
 */

/**
 * How faithful a thinking block is to the model's actual reasoning.
 *
 * This is NOT a platform property — it follows the model provider, and
 * the same platform yields different values depending on which model is
 * configured. Anthropic models return complete reasoning traces;
 * OpenAI's reasoning series does not expose raw chain-of-thought at the
 * API level and gives step-level summaries instead (measured at ~3% of
 * the underlying reasoning by volume).
 *
 * Consumers must not treat the two as interchangeable: a 40-character
 * step title and a thousand-word reasoning chain are different kinds of
 * evidence. Analyses that conflate them will read "the summary didn't
 * mention risk X" as "the model didn't consider risk X".
 */
export type ThinkingFidelity = 'full' | 'summary';

export interface ContentBlock {
  type: 'thinking' | 'text' | 'tool_use';
  /** Position within this call, zero-based and contiguous. Order carries meaning. */
  index: number;
  content: string;
  /** Only meaningful when `type === 'thinking'`. */
  fidelity?: ThinkingFidelity;
  /** Only present when `type === 'tool_use'`. */
  toolUse?: { id: string; name: string; input: string };
}

/** One LLM invocation. */
export interface ChatCall {
  /** Provider-side request id where available; otherwise a synthesised ordinal. */
  callId: string;
  model?: string;
  startMs: number;
  endMs: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    /** Reasoning tokens billed but not visible (OpenAI reasoning models). */
    reasoning?: number;
  };
  stopReason?: string;
  /** Time to first token, when the platform reports it. Codex does; Claude Code does not. */
  timeToFirstTokenMs?: number;
  blocks: ContentBlock[];
  /** True when this call belongs to a subagent rather than the main thread. */
  isSidechain: boolean;
}

/**
 * Produces the calls that happened within one turn.
 *
 * Implementations fall into two families. Replay sources read a session
 * file the host already wrote, so they see the whole turn at once.
 * Streaming sources accumulate live events and answer from what they
 * have gathered so far.
 */
export interface ConversationSource {
  /** Stable identifier for diagnostics, e.g. 'claude-code-transcript'. */
  readonly name: string;
  /**
   * Calls that started at or after `sinceMs`. Returns an empty array
   * when nothing is available — never throws, never partially fails.
   */
  callsSince(sinceMs: number): ChatCall[];
}

/**
 * Whether a call's blocks form a clean zero-based contiguous sequence.
 *
 * The span layer relies on block order to reconstruct "thought, then
 * spoke, then called a tool". A gap or a repeat means the source
 * mis-assembled the call, and the resulting trace would misrepresent
 * what the model actually did — better to detect it than to emit it.
 */
export function blockOrderIsSane(call: ChatCall): boolean {
  return call.blocks.every((b, i) => b.index === i);
}
```

- [ ] **Step 4: 跑测试 + 全量回归**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/conversation-types.test.js && pnpm test
```

- [ ] **Step 5: 变异验证**

把 `blockOrderIsSane` 改成 `return true;`，确认三条否定用例转红；还原后转绿。

- [ ] **Step 6: 提交**

```bash
git add src/scripts/lib/conversation/types.ts src/tests/conversation-types.test.ts
git commit -m "feat(conversation): define the ChatCall normalised representation"
```

---

### Task 2: Claude Code transcript 解析

**Files:**
- Create: `src/scripts/lib/conversation/claude-code-source.ts`
- Create: `src/tests/fixtures/conversation/claude-code-transcript.jsonl`
- Test: `src/tests/conversation-claude-code.test.ts`

**Interfaces:**
- Consumes: `ChatCall` / `ContentBlock` / `ConversationSource`（Task 1）
- Produces: `createClaudeCodeSource(transcriptPath: string): ConversationSource`

**已实机验证的真实结构**（本任务的依据）：

```
每行一个 JSON 对象。assistant 行的形状：
{
  "type": "assistant",
  "timestamp": "2026-08-04T...",
  "requestId": "req_...",          ← 一次 LLM 调用的 id
  "isSidechain": false,            ← subagent 标记
  "message": {
    "id": "msg_...",
    "model": "claude-opus-5",
    "role": "assistant",
    "stop_reason": "tool_use",
    "usage": { input_tokens, output_tokens,
               cache_creation_input_tokens, cache_read_input_tokens },
    "content": [                   ← 块序列，三种类型并存
      { "type": "thinking", "thinking": "..." },
      { "type": "text", "text": "..." },
      { "type": "tool_use", "id": "toolu_...", "name": "Bash", "input": {...} }
    ]
  }
}
```

**每条 assistant 行即一次 LLM 调用** —— 边界天然，不需要推断。

Claude 模型返回完整思考原文，故 `fidelity` 恒为 `'full'`。

- [ ] **Step 1: 造 fixture**

创建 `src/tests/fixtures/conversation/claude-code-transcript.jsonl`，**手工合成**，内容全部为占位文本。至少覆盖：

- 一条 `type: "user"` 行（会被跳过）
- 一条 assistant 行，`content` 依次含 `thinking` / `text` / `tool_use` 三种块
- 一条 assistant 行，只有 `text`（最终回复，`stop_reason: "end_turn"`）
- 一条 `isSidechain: true` 的 assistant 行
- 一条 assistant 行缺 `usage`（畸形容错）
- 一行非法 JSON（畸形容错）

文件头**不要**加注释（JSONL 不支持），改在测试文件顶部注明「fixture 按已实机验证的真实结构手工合成，不含任何真实数据」。

- [ ] **Step 2: 写测试**

创建 `src/tests/conversation-claude-code.test.ts`，覆盖：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

// The fixture is hand-synthesised from the real transcript shape
// (verified against a live Claude Code session); it contains no real
// conversation data.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCodeSource } from '../scripts/lib/conversation/claude-code-source.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'conversation', 'claude-code-transcript.jsonl');

describe('claude-code source', () => {
  it('yields one call per assistant entry', () => {
    const calls = createClaudeCodeSource(FIXTURE).callsSince(0);
    assert.ok(calls.length >= 3, `expected at least 3 calls, got ${calls.length}`);
  });

  it('preserves block order within a call', () => {
    const calls = createClaudeCodeSource(FIXTURE).callsSince(0);
    const withAll = calls.find(c => c.blocks.length >= 3);
    assert.ok(withAll, 'fixture must contain a call with thinking+text+tool_use');
    assert.deepEqual(withAll.blocks.map(b => b.type), ['thinking', 'text', 'tool_use']);
    assert.deepEqual(withAll.blocks.map(b => b.index), [0, 1, 2]);
  });

  it('marks thinking as full fidelity', () => {
    const calls = createClaudeCodeSource(FIXTURE).callsSince(0);
    const thinking = calls.flatMap(c => c.blocks).filter(b => b.type === 'thinking');
    assert.ok(thinking.length > 0, 'fixture must contain thinking');
    for (const b of thinking) assert.equal(b.fidelity, 'full');
  });

  it('carries tool_use id and name', () => {
    const calls = createClaudeCodeSource(FIXTURE).callsSince(0);
    const tu = calls.flatMap(c => c.blocks).find(b => b.type === 'tool_use');
    assert.ok(tu?.toolUse, 'tool_use block must carry toolUse detail');
    assert.ok(tu.toolUse.id.length > 0);
    assert.ok(tu.toolUse.name.length > 0);
  });

  it('flags sidechain calls', () => {
    const calls = createClaudeCodeSource(FIXTURE).callsSince(0);
    assert.ok(calls.some(c => c.isSidechain), 'fixture must contain a sidechain call');
    assert.ok(calls.some(c => !c.isSidechain));
  });

  it('filters by sinceMs', () => {
    const all = createClaudeCodeSource(FIXTURE).callsSince(0);
    assert.ok(all.length >= 2);
    const cutoff = all[all.length - 1].startMs;
    const late = createClaudeCodeSource(FIXTURE).callsSince(cutoff);
    assert.ok(late.length < all.length, 'sinceMs must actually filter');
    assert.ok(late.every(c => c.startMs >= cutoff));
  });

  it('survives a malformed line and a missing usage field', () => {
    // The fixture contains both; parsing must not throw and must not
    // drop the well-formed entries around them.
    const calls = createClaudeCodeSource(FIXTURE).callsSince(0);
    assert.ok(calls.length >= 3);
  });

  it('returns an empty array for a nonexistent file', () => {
    const src = createClaudeCodeSource('/nonexistent/nope.jsonl');
    assert.deepEqual(src.callsSince(0), []);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/conversation-claude-code.test.js
```

- [ ] **Step 4: 实现**

创建 `src/scripts/lib/conversation/claude-code-source.ts`。要点：

- 逐行读取，`JSON.parse` 失败的行跳过（不中断）
- 只处理 `entry.type === 'assistant'` 且有 `entry.message`
- `startMs` 取 `Date.parse(entry.timestamp)`；`endMs` 同值（transcript 不记录结束时刻，span 层会用下一次调用的开始时间或 turn 结束时间补正）
- `callId` 取 `entry.requestId`，缺失时回落 `msg_<message.id>`，再缺失则用 `cc-<行号>`
- `blocks` 从 `message.content[]` 按序映射：`thinking` → `{type:'thinking', content: b.thinking, fidelity:'full'}`、`text` → `{type:'text', content: b.text}`、`tool_use` → `{type:'tool_use', content: JSON.stringify(b.input), toolUse:{id,name,input}}`；未知块类型跳过但**不打乱 index**（先过滤再重新编号）
- `usage` 从 `message.usage` 映射四个字段，缺失时省略整个 `usage`
- `isSidechain` 取 `entry.isSidechain === true`
- **大文件保护**：读取前 `statSync` 检查大小，超过阈值（建议 64 MB，抽成具名常量）时只读文件尾部；注释说明为什么——长会话的 transcript 可达数十 MB，而 hook 是阻塞宿主的

不要用 `readFileSync` 一次性读进内存后再 split：现有的 `parseTranscriptUsage` 就是这么做的，属既有技术债，本模块不要复制它。用 `readFileSync` + 尾部切片，或按行流式读取。

- [ ] **Step 5: 跑测试 + 全量回归**

- [ ] **Step 6: 变异验证**

把 `callsSince` 改成 `return [];`，确认多条转红；还原后转绿。另外把 `fidelity: 'full'` 改成 `'summary'`，确认 fidelity 那条转红——这条尤其重要，它是区分两类 thinking 的唯一守卫。

- [ ] **Step 7: 提交**

```bash
git add src/scripts/lib/conversation/claude-code-source.ts src/tests/conversation-claude-code.test.ts src/tests/fixtures/conversation/claude-code-transcript.jsonl
git commit -m "feat(conversation): parse Claude Code transcripts into ChatCall"
```

---

### Task 3: Codex rollout 解析

**Files:**
- Create: `src/scripts/lib/conversation/codex-source.ts`
- Create: `src/tests/fixtures/conversation/codex-rollout.jsonl`
- Test: `src/tests/conversation-codex.test.ts`

**Interfaces:**
- Produces: `createCodexSource(rolloutPath: string): ConversationSource`

**已实机验证的真实结构**（本任务的依据）：

```
每行 { type, timestamp, payload }。相关的 type：

response_item + payload.type === 'reasoning'
  { id, summary: [{type:'summary_text', text:'**Planning …**'}], encrypted_content: 'gAAAAAB…' }

response_item + payload.type === 'message'
  { role: 'user'|'assistant'|'developer', content: [{type:'input_text'|'output_text', text}] }

response_item + payload.type === 'function_call'
  { id, name: 'exec_command', arguments: '{"cmd":"…"}', call_id: 'call_…' }

response_item + payload.type === 'function_call_output'
  { id, call_id: 'call_…', output: '…' }

event_msg + payload.type === 'token_count'
  { info: { last_token_usage, total_token_usage, model_context_window } }

event_msg + payload.type === 'task_complete'
  { turn_id, last_agent_message, started_at, completed_at, duration_ms, time_to_first_token_ms }

turn_context
  { turn_id, model, effort, summary }
```

**关键差异：per-call 边界要推断。** `turn_id` 是 turn 级不是 call 级，整个 turn 内所有条目共享一个值。实际边界由时序给出：

```
reasoning → function_call → reasoning → function_call → … → message(assistant)
```

**每个 `reasoning` 条目标志一次新调用的开始**；收尾那次以 `message(assistant)` 结束。

**thinking 只有摘要。** `summary[].text` 是步骤标题（30–50 字符），`encrypted_content` 是 Fernet 加密的原始推理（客户端无法解密），`content` 字段不存在。所以 `fidelity` 恒为 `'summary'`，且 `summary` 为空数组时**不产出 thinking 块**（`effort=medium` 及以下的常态）。

- [ ] **Step 1: 造 fixture**

创建 `src/tests/fixtures/conversation/codex-rollout.jsonl`，手工合成，至少覆盖：

- `turn_context`（含 model / effort / summary）
- `response_item/message` role=`developer`（会被跳过，不计入 call）
- `response_item/message` role=`user`
- `response_item/reasoning`，`summary` 有两条 `summary_text`
- `response_item/function_call` + 配对的 `function_call_output`
- 第二个 `response_item/reasoning`，`summary` 为**空数组**（验证不产出 thinking 块）
- `response_item/message` role=`assistant`（收尾）
- `event_msg/token_count`
- `event_msg/task_complete`（含 `time_to_first_token_ms`）
- 一行非法 JSON

- [ ] **Step 2: 写测试**

创建 `src/tests/conversation-codex.test.ts`，至少断言：

- 调用数等于 `reasoning` 条目数 +（若末尾有独立的 assistant message 则再 +1）
- 每个 thinking 块 `fidelity === 'summary'`
- `summary: []` 的 reasoning 条目**不**产出 thinking 块
- `function_call` 变成 `tool_use` 块，`toolUse.name === 'exec_command'`，`toolUse.id` 取 `call_id`
- `timeToFirstTokenMs` 被填入（来自 `task_complete`）
- `usage.reasoning` 被填入（来自 `token_count` 的 reasoning token 字段，若存在）
- `model` 来自 `turn_context`
- 畸形行不中断解析
- 文件不存在返回 `[]`

- [ ] **Step 3: 跑测试确认失败**

- [ ] **Step 4: 实现**

创建 `src/scripts/lib/conversation/codex-source.ts`。切分算法：

1. 顺序扫描所有行
2. 遇到 `reasoning` 条目 → 结束当前 call（若有）、开始新 call
3. 遇到 `function_call` → 作为 `tool_use` 块加入当前 call
4. 遇到 `message` role=`assistant` → 作为 `text` 块加入当前 call；若当前无 call 则开一个新的
5. `message` role=`user` / `developer` → 跳过（它们是输入不是输出）
6. `function_call_output` → 跳过（结果属于 tool span，不属于 chat 的内容块）
7. 扫描结束后收尾最后一个 call
8. `turn_context` 的 `model`、`task_complete` 的 `time_to_first_token_ms` / `duration_ms` 回填到相应 call

`startMs` 取该 call 首个条目的 `Date.parse(timestamp)`，`endMs` 取末个条目的。

同样要有大文件保护。

- [ ] **Step 5: 跑测试 + 全量回归**

- [ ] **Step 6: 变异验证**

- 把 `fidelity: 'summary'` 改成 `'full'` → 对应断言必须转红
- 把「`summary` 为空则不产出 thinking 块」的判断去掉 → 对应断言必须转红

这两条是 Codex 与 Claude Code 语义差异的唯一守卫。

- [ ] **Step 7: 提交**

```bash
git add src/scripts/lib/conversation/codex-source.ts src/tests/conversation-codex.test.ts src/tests/fixtures/conversation/codex-rollout.jsonl
git commit -m "feat(conversation): parse Codex rollouts into ChatCall"
```

---

### Task 4: Hermes streaming 源

**Files:**
- Create: `src/scripts/lib/conversation/hermes-source.ts`
- Create: `src/tests/fixtures/conversation/hermes-post-llm-call.json`
- Test: `src/tests/conversation-hermes.test.ts`

**Interfaces:**
- Produces: `createHermesSource(payload: unknown): ConversationSource`

**已实机验证的真实结构**（本任务的依据）：

`post_llm_call` 的 `extra` 字段实测含：

```
user_message          str
assistant_response    str          ← 当前代码从未读取
conversation_history  list         ← 当前代码从未读取
model                 "gpt-5.5"
platform              "cli"
```

`conversation_history[]` 里 assistant 消息实测出现的键：

```
role · content · finish_reason · tool_calls
reasoning              ← 摘要文本
reasoning_content      ← 与 reasoning 内容重复
codex_reasoning_items  ← 原始 API item，含 _issuer_kind / encrypted_content / summary[]
```

**fidelity 必须运行时判定**，不能按平台写死：

- 见到 `codex_reasoning_items`（或条目内 `_issuer_kind` 含 `codex`）→ `'summary'`
- 见到 Anthropic 形态的 thinking 块 → `'full'`

同一个 Hermes 部署换个模型，这个判定结果就变。实测该机器配 gpt-5.5 走 codex_backend，故拿到的是 `'summary'`。

**无 transcript 路径字段** —— 不要去找。

- [ ] **Step 1: 造 fixture**

创建 `src/tests/fixtures/conversation/hermes-post-llm-call.json`，手工合成，含：

- `extra.user_message` / `assistant_response` / `model` / `platform`
- `extra.conversation_history`：一条 user、若干 assistant（其中一条带 `codex_reasoning_items` + `reasoning`，一条不带任何 reasoning）、若干 tool 消息
- 至少一条 assistant 带 `tool_calls`

在测试文件顶部注明：**结构依据实机采集的 `post_llm_call` envelope，内容为合成占位**。

- [ ] **Step 2: 写测试**

至少断言：

- 从 `conversation_history` 的 assistant 消息产出对应数量的 `ChatCall`
- 带 `codex_reasoning_items` 的那条，thinking 块 `fidelity === 'summary'`
- 不带任何 reasoning 的那条，不产出 thinking 块
- `tool_calls` 变成 `tool_use` 块
- `assistant_response` 被用于最后一次调用的 `text` 块（若 history 末条与之一致则不重复）
- `model` 来自 `extra.model`
- `extra` 缺失、`conversation_history` 非数组、条目非对象等畸形输入返回 `[]` 而不抛

- [ ] **Step 3–5: 实现、测试、变异验证**

变异重点：把 fidelity 判定改成恒返回 `'full'`，确认对应断言转红。这是「fidelity 运行时判定」的唯一守卫。

- [ ] **Step 6: 提交**

```bash
git add src/scripts/lib/conversation/hermes-source.ts src/tests/conversation-hermes.test.ts src/tests/fixtures/conversation/hermes-post-llm-call.json
git commit -m "feat(conversation): build ChatCall from Hermes post_llm_call payloads"
```

---

### Task 5: OpenClaw streaming 源（按文档实现，未实机验证）

**Files:**
- Create: `src/scripts/lib/conversation/openclaw-source.ts`
- Create: `src/tests/fixtures/conversation/openclaw-events.json`
- Test: `src/tests/conversation-openclaw.test.ts`

**Interfaces:**
- Produces: `createOpenClawSource(events: unknown[]): ConversationSource`

**⚠️ 本任务无实机样本。** 采样时该机器的 OpenClaw 安装已损坏（`MODULE_NOT_FOUND`，gateway 无法启动）。以下依据官方文档：

- `llm_output` 的官方字段表**只有元数据**：`runId` / `callId` / `provider` / `model` / `outcome` / `durationMs` / `upstreamRequestIdHash` / `contextTokenBudget` 等。**没有内容字段。**
- 现有 `openclaw-plugin.ts` 读的 `assistantTexts` / `usage` **不在官方字段表内**，可能依赖未文档化行为
- reasoning 作为**独立消息**发送（带 `Thinking` 前缀），受 `/reasoning on|off|stream` 控制
- 因此 thinking 很可能要从消息流事件（`before_agent_reply` / `before_message_write` / `message_sending`）获取，而非 `llm_output`

**实现原则**：

1. 优先读官方文档化的字段（`llm_output` 的 `callId` / `model` / `durationMs`）
2. `assistantTexts` / `usage` 作为**可选补充**读取，缺失时不报错、不告警——它们可能随上游改版消失
3. thinking 从消息流事件里识别 `Thinking` 前缀或 `<think>…</think>` 标签
4. fidelity 判定同 Hermes：按数据形态而非平台

**fixture 文件头必须注明**：「基于官方文档构造，未经实机校验；`assistantTexts` 等字段的真实存在性待确认」。测试文件顶部同样注明。

- [ ] **Step 1–6: 造 fixture、写测试、实现、变异验证、提交**

测试至少覆盖：文档化字段被正确读取、未文档化字段缺失时优雅降级（返回的 call 仍有效，只是少了对应内容）、`Thinking` 前缀消息被识别为 thinking 块、畸形输入返回 `[]`。

```bash
git commit -m "feat(conversation): build ChatCall from OpenClaw events (doc-based, unverified)"
```

---

### Task 6: 跨源一致性对拍

**Files:**
- Test: `src/tests/conversation-cross-source.test.ts`

**这是双模抽象最大的风险点。** 两套实现（replay / streaming）如果对同一语义给出不同结构，上层就废了——而这种漂移不会被任何单源测试发现。

- [ ] **Step 1: 写对拍测试**

构造语义等价的输入：同样两次 LLM 调用、同样的块序列（thinking → text → tool_use）、同样的工具名与参数，分别用四个 source 解析，断言产出的 `ChatCall[]` 在**结构层面**一致：

- 调用数相同
- 每次调用的 `blocks` 类型序列相同
- `index` 都是零基连续（用 Task 1 的 `blockOrderIsSane` 校验每一个）
- `toolUse.name` 相同
- thinking 块的 `fidelity` **允许不同**（这正是平台差异所在），但必须都有值

不要求 `callId` / 时间戳一致——那些天然因源而异。

- [ ] **Step 2: 跑测试**

- [ ] **Step 3: 变异验证**

任选一个 source，把它的块顺序反转（或把 `index` 改成从 1 开始），确认对拍测试转红。

- [ ] **Step 4: 提交**

```bash
git add src/tests/conversation-cross-source.test.ts
git commit -m "test(conversation): pin structural agreement across all four sources"
```

---

## 验收标准

- [ ] 四个平台各有一个 `ConversationSource` 实现，均产出结构一致的 `ChatCall[]`
- [ ] thinking 的 `fidelity` 由**数据形态**判定，不按平台硬编码
- [ ] Codex 的 `summary: []`（`effort=medium` 常态）不产出 thinking 块
- [ ] Hermes 的 `assistant_response` 与 `conversation_history` 被真正读取
- [ ] 所有 fixture 为手工合成，不含任何真实对话；未验证平台的 fixture 已注明状态
- [ ] 解析层无任何副作用：不写文件、不发网络、不碰 OTEL
- [ ] 畸形输入（非法 JSON、缺字段、类型错、文件不存在）一律降级不抛
- [ ] 大文件有读取保护，不整个读进内存
- [ ] `pnpm test` 全绿（基线 1294），`pnpm run typecheck` 无错
- [ ] 每个任务的变异验证结果已写入报告
