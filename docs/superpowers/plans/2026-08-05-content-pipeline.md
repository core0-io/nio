# 内容管线实施计划（Phase 4 下半）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `ChatCall[]` 里的内容安全地送到 logs 信号——脱敏、按类型截断、附上能与 span 关联的元数据。

**Architecture:** 三个纯模块，彼此独立，均不依赖 span 层。脱敏与截断是纯函数；发射器接收 `ChatCall` 与外部给定的 `span_id`，产出 LogRecord。span 层稍后接线时只需把真实的 span_id 传进来。

**Tech Stack:** TypeScript / Node 18+ / node:test / OpenTelemetry Logs SDK

**对应 spec:** `docs/superpowers/specs/2026-08-04-traces-full-capture-design.md` 的「三、内容管线」

**前置:** `docs/superpowers/plans/2026-08-05-conversation-source.md` 已交付的 `ChatCall` / `ContentBlock` / `ThinkingFidelity`。

## Global Constraints

- 新文件以 `// Copyright 2026 core0-io` + `// SPDX-License-Identifier: Apache-2.0` 开头，紧跟 `export {};`
- 测试用 `node:test` + `node:assert/strict`，不引入新依赖
- 测试临时目录一律 `mkdtempSync`，**严禁**读写真实 `~/.nio/` 等用户路径
- 脱敏与截断必须是**纯函数**：同样输入永远同样输出，无 IO、无全局状态
- 跑测试前 `pnpm run build`；`--import ./dist/tests/helpers/isolate-nio-home.js` 不能省
- 每个任务完成后跑全量 `pnpm test`，**当前基线 1342**
- git commit 不带 `Co-Authored-By` 之类 AI 署名 trailer
- 不新建分支（在 `traces-track` 上）
- 不要 `git add` `dist/`、`plugins/**/scripts/*.js`、`pnpm-lock.yaml`

## 测试质量要求

本仓库前三轮被评审抓出**七次**「测试通过但实际什么都没测」。每个任务都要求**变异验证**：把核心逻辑改成退化实现，确认对应测试转红；还原后转绿。结果写进报告。做不到转红就如实报告，不要硬凑。

---

### Task 1: 正文密钥模式扫描

**Files:**
- Create: `src/scripts/lib/content/redact.ts`
- Test: `src/tests/content-redact.test.ts`

**Interfaces:**
- Produces: `redactSecrets(text: string, extraPatterns?: RegExp[]): { text: string; hits: number }`

**问题**：现有的 `redactAndTruncate`（`traces-collector.ts`）只扫 **JSON 的 key 名**——key 里带 `api_key` / `token` / `password` 就替换值。但内容捕获之后，密钥会大量出现在**自由文本**里：

```
thinking: "用户给的 key 是 sk-ant-api03-xxxxx，我用它调一下…"
tool_input: { "command": "export AWS_SECRET_ACCESS_KEY=AKIA…" }
```

这些现在一个都拦不住——它们不是 JSON 的 key，是正文。开始采集 thinking 与完整命令之后，这从理论风险变成必然会发生的事。

**要覆盖的模式**（spec 已列）：

| 类型 | 特征 |
|---|---|
| Anthropic key | `sk-ant-` 开头 |
| OpenAI key | `sk-proj-` / `sk-` 开头的长串 |
| AWS access key | `AKIA` + 16 位大写字母数字 |
| GitHub token | `ghp_` / `gho_` / `ghs_` / `ghu_` / `ghr_` 开头 |
| JWT | 三段 base64url 以 `.` 分隔，首段以 `eyJ` 开头 |
| PEM 私钥块 | `-----BEGIN … PRIVATE KEY-----` 到 `-----END … PRIVATE KEY-----` |
| HTTP Authorization | `Authorization: Bearer <token>` / `Authorization: Basic <b64>` |

**误伤防护是硬要求**。以下必须**不被**替换：

- git commit hash（40 位十六进制）与短 hash（7–12 位）
- UUID（`8-4-4-4-12` 十六进制）
- 文件路径中的长串（如 `/Users/x/.cache/abcdef123456/file`）
- base64 编码的普通数据（不带 JWT 结构特征）
- 普通英文长单词、连字符串

**不要用「高熵长随机串」作为通用规则** —— 那是误伤的主要来源。只匹配有明确前缀或结构特征的模式。

- [ ] **Step 1: 写测试**

创建 `src/tests/content-redact.test.ts`。正向用例（必须被替换）与负向用例（必须**不**被替换）各自成组：

```typescript
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../scripts/lib/content/redact.js';

const MUST_REDACT: Array<[string, string]> = [
  ['anthropic key', 'the key is sk-ant-api03-AbCdEf1234567890AbCdEf1234567890AbCdEf12 ok'],
  ['openai project key', 'use sk-proj-AbCdEf1234567890AbCdEf1234567890 now'],
  ['aws access key', 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'],
  ['github pat', 'token ghp_AbCdEf1234567890AbCdEf1234567890AbCd'],
  ['jwt', 'auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ['bearer header', 'Authorization: Bearer AbCdEf1234567890AbCdEf1234567890'],
  ['pem block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'],
];

const MUST_NOT_REDACT: Array<[string, string]> = [
  ['git full hash', 'commit 8f774cf1a2b3c4d5e6f708192a3b4c5d6e7f8091'],
  ['git short hash', 'see commit 8f774cf for details'],
  ['uuid', 'session 019fcfff-cdf4-7f02-b628-1a7cbfb6f5ed started'],
  ['path with hex dir', 'reading /Users/dev/.cache/a1b2c3d4e5f6/module.js'],
  ['plain base64 data', 'payload aGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYSBzZWNyZXQ='],
  ['ordinary prose', 'the quick brown fox jumps over the lazy dog repeatedly'],
  ['hyphenated words', 'a well-documented self-explanatory implementation'],
];

describe('redactSecrets — must redact', () => {
  for (const [label, input] of MUST_REDACT) {
    it(label, () => {
      const { text, hits } = redactSecrets(input);
      assert.ok(hits > 0, `${label}: expected at least one hit`);
      assert.ok(text.includes('[REDACTED]'), `${label}: expected a redaction marker`);
    });
  }
});

describe('redactSecrets — must not redact', () => {
  for (const [label, input] of MUST_NOT_REDACT) {
    it(label, () => {
      const { text, hits } = redactSecrets(input);
      assert.equal(hits, 0, `${label}: false positive, got ${text}`);
      assert.equal(text, input, `${label}: input must pass through untouched`);
    });
  }
});

describe('redactSecrets — behaviour', () => {
  it('is pure: same input yields same output', () => {
    const s = 'key sk-ant-api03-AbCdEf1234567890AbCdEf1234567890AbCdEf12';
    assert.deepEqual(redactSecrets(s), redactSecrets(s));
  });

  it('redacts every occurrence, not just the first', () => {
    const s = 'a ghp_AbCdEf1234567890AbCdEf1234567890AbCd b ghp_ZyXwVu9876543210ZyXwVu9876543210ZyXw';
    const { hits } = redactSecrets(s);
    assert.equal(hits, 2);
  });

  it('preserves surrounding text', () => {
    const { text } = redactSecrets('before ghp_AbCdEf1234567890AbCdEf1234567890AbCd after');
    assert.ok(text.startsWith('before '));
    assert.ok(text.endsWith(' after'));
  });

  it('accepts extra user-configured patterns', () => {
    const { hits } = redactSecrets('internal INTERNAL-TOKEN-42 here', [/INTERNAL-TOKEN-\d+/g]);
    assert.equal(hits, 1);
  });

  it('handles empty and whitespace input', () => {
    assert.deepEqual(redactSecrets(''), { text: '', hits: 0 });
    assert.deepEqual(redactSecrets('   '), { text: '   ', hits: 0 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/content-redact.test.js
```

- [ ] **Step 3: 实现**

创建 `src/scripts/lib/content/redact.ts`。要点：

- 每个模式一个具名 `RegExp`，带 `g` 标志，配注释说明它匹配什么
- 替换为 `[REDACTED]`（与既有 `SECRET_KEY_RE` 的替换文本一致）
- 返回替换次数，供调用方统计与诊断
- **模式的顺序有影响**：PEM 块要先于其它模式匹配（它跨行且含 base64，容易被别的模式切碎）
- 用户自定义模式追加在内置模式之后
- 纯函数：不缓存、不改全局

**在模块 doc 里写明设计取舍**：为什么不做通用的高熵检测（误伤 git hash / UUID / base64 数据，而这些在开发者对话里极其常见），以及这意味着自定义前缀的内部凭据需要用户通过配置补充模式。

- [ ] **Step 4: 跑测试 + 全量回归**

- [ ] **Step 5: 变异验证**

逐个删掉内置模式，确认对应的正向用例转红。**特别验证负向用例组**：把某个模式放宽（比如把 GitHub token 的模式改成匹配任意 40 位十六进制），确认 git hash 那条负向用例转红——这证明误伤防护是被真正测试的。

- [ ] **Step 6: 提交**

```bash
git add src/scripts/lib/content/redact.ts src/tests/content-redact.test.ts
git commit -m "feat(content): scan free text for secret patterns"
```

---

### Task 2: 按类型截断

**Files:**
- Create: `src/scripts/lib/content/truncate.ts`
- Modify: `src/scripts/lib/config-loader.ts`（新增 `loadContentLimits()`）
- Test: `src/tests/content-truncate.test.ts`

**Interfaces:**
- Produces:
  - `type ContentKind = 'thinking' | 'text' | 'user_prompt' | 'tool_input' | 'tool_output'`
  - `interface ContentLimits { thinking: number; text: number; user_prompt: number; tool_input: number; tool_output: number }`
  - `const DEFAULT_CONTENT_LIMITS: ContentLimits`
  - `truncateContent(text: string, limit: number): { text: string; truncated: boolean; originalBytes: number }`
  - `loadContentLimits(): ContentLimits`（config-loader）

**默认值**（spec 已定）：

| 类型 | 默认上限 |
|---|---|
| thinking | 64 KB |
| text | 64 KB |
| user_prompt | 32 KB |
| tool_input | 16 KB |
| tool_output | 32 KB |

配置形如：

```yaml
collector:
  content_limits:
    thinking: 65536
    text: 65536
    user_prompt: 32768
    tool_input: 16384
    tool_output: 32768
```

**逃生阀**：任一项设为 `0` 表示不限制该类型。

**截断的目的是拦异常输出，不是限制正常内容。** 正常的 thinking（2–10 KB）与回复不会触及上限；触及的通常是失控的工具输出（`cat` 大文件、`find /` 全盘遍历）。保留上限的硬理由：OTLP gRPC 单 message 默认 4 MB 上限（超限是整条发送失败而非截断）、hook 同步阻塞宿主、后端对单条日志有长度限制。

- [ ] **Step 1: 写测试**

覆盖：

- 短于上限的文本原样返回，`truncated === false`
- 超限文本被截断，`truncated === true`，`originalBytes` 是**原始字节数**（不是字符数——多字节字符要按 UTF-8 字节算）
- `limit === 0` 时不截断，无论多长
- 多字节字符不被从中间切开（截断后的字符串必须是合法 UTF-8，不产生半个字符）
- 空字符串
- `loadContentLimits()` 无配置时返回默认值
- 部分配置时，未配置项回落默认
- 非法值（负数、字符串、null）回落默认而不抛

多字节那条尤其重要，写成明确的用例：

```typescript
it('never splits a multi-byte character', () => {
  // 每个中文字 3 字节；把上限设在字符边界之间
  const s = '中'.repeat(10);            // 30 bytes
  const { text, truncated } = truncateContent(s, 20);
  assert.equal(truncated, true);
  // 截断结果必须能安全地往返一次 UTF-8 编解码
  assert.equal(Buffer.from(text, 'utf-8').toString('utf-8'), text);
  assert.ok(Buffer.byteLength(text, 'utf-8') <= 20);
});
```

- [ ] **Step 2–4: 跑测试确认失败、实现、再跑**

实现要点：按 **UTF-8 字节** 而非字符长度截断，且截断点回退到完整字符边界。截断后追加省略标记（与既有 `redactAndTruncate` 的 `…[truncated]` 保持一致），**标记本身也计入上限**——否则设了上限仍可能超出。

- [ ] **Step 5: 变异验证**

- 把「按字节」改成「按字符」，确认多字节用例转红
- 把 `limit === 0` 的分支删掉，确认逃生阀用例转红

- [ ] **Step 6: 提交**

```bash
git add src/scripts/lib/content/truncate.ts src/scripts/lib/config-loader.ts src/tests/content-truncate.test.ts
git commit -m "feat(content): truncate by UTF-8 bytes with per-kind limits"
```

---

### Task 3: 内容日志发射器

**Files:**
- Create: `src/scripts/lib/content/emit.ts`
- Test: `src/tests/content-emit.test.ts`

**Interfaces:**
- Consumes: `ChatCall` / `ContentBlock`（conversation 层）、`redactSecrets`（Task 1）、`truncateContent` / `ContentLimits`（Task 2）
- Produces: `buildContentRecords(call: ChatCall, spanId: string, traceId: string, limits: ContentLimits): ContentRecord[]`

**本任务只产出记录结构，不发送。** 发送要等 span 层接线时把真实的 provider 传进来。这样发射逻辑可以完全脱离 OTEL 测试。

每个 `ContentBlock` 对应一条记录：

```
ContentRecord {
  traceId    string        OTel 内建字段，指向所属 turn trace
  spanId     string        OTel 内建字段，指向所属 chat span
  body       string        正文（已脱敏、已截断）
  attributes {
    'nio.content.type'      'thinking' | 'text' | 'tool_input' | 'tool_output' | 'user_prompt'
    'nio.content.index'     number      块在本次调用内的序号，保序
    'nio.content.fidelity'  string?     仅 thinking 块
    'nio.content.truncated' boolean?    仅当发生截断
    'nio.content.original_bytes' number?  仅当发生截断
    'nio.content.redactions' number?    仅当发生脱敏
    'nio.trace_id'          string      冗余，见下
    'nio.span_id'           string      冗余，见下
    'gen_ai.tool.call.id'   string?     仅 tool_use 块
  }
}
```

**为什么冗余 `nio.trace_id` / `nio.span_id`**：OTLP 里 trace_id/span_id 是 LogRecord 的**内建二进制字段**，各后端映射后的字段名不一致（`span_id` / `SpanId` / structured metadata）。冗余一份普通字符串字段，保证任意后端都能 join。这个理由要写进模块注释。

**处理顺序必须是「先脱敏、后截断」** —— 反过来会把一个被切成两半的密钥留在正文里，而且截断标记会干扰模式匹配。这一点要有专门的测试用例。

- [ ] **Step 1: 写测试**

覆盖：

- 一个含三种块的 `ChatCall` 产出三条记录，`index` 保序
- thinking 块带 `nio.content.fidelity`，其它块不带
- tool_use 块带 `gen_ai.tool.call.id`
- 正文里的密钥被脱敏，`nio.content.redactions` 计数正确
- 超长正文被截断，带 `truncated` 与 `original_bytes`
- **先脱敏后截断**：构造一个正文，其密钥恰好跨越截断点——断言输出里不含密钥残片
- `traceId` / `spanId` 同时出现在内建字段位与冗余属性位，值相同
- 空 `blocks` 产出空数组
- 不同 `ContentKind` 用对应的 limit（thinking 块用 `limits.thinking`，tool_use 块用 `limits.tool_input`）

- [ ] **Step 2–4: 跑测试确认失败、实现、再跑**

- [ ] **Step 5: 变异验证**

- 把脱敏与截断的顺序对调，确认「密钥跨越截断点」那条转红
- 删掉冗余的 `nio.span_id` 属性，确认对应断言转红

- [ ] **Step 6: 提交**

```bash
git add src/scripts/lib/content/emit.ts src/tests/content-emit.test.ts
git commit -m "feat(content): build log records from ChatCall blocks"
```

---

## 验收标准

- [ ] 自由文本里的常见密钥格式被脱敏，且 git hash / UUID / 路径 / base64 数据不被误伤
- [ ] 截断按 UTF-8 字节进行，不切碎多字节字符，标记本身计入上限
- [ ] `content_limits` 可配置，`0` 表示不限制
- [ ] 内容记录携带 trace/span 关联（内建 + 冗余各一份）
- [ ] 脱敏先于截断，密钥不会因截断而留下残片
- [ ] 三个模块均为纯逻辑，不碰 OTEL provider、不做 IO
- [ ] `pnpm test` 全绿（基线 1342），`pnpm run typecheck` 无错
- [ ] 每个任务的变异验证结果已写入报告
