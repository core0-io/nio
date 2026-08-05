# Traces 全链路捕获 — 设计文档

日期：2026-08-04
状态：已评审，待实施
分支：`traces-track`

## 目标

让 nio 的 traces 能完整还原一次 agent 执行的全过程：

```
user prompt → tool call → thinking → tool call → thinking → … → result
```

同时补齐五个已知缺口，并引入一个 session 级采集总闸，使采集从"默认全量"变为"默认静默、显式开启"。

## 现状与缺口

### 已覆盖

- tool call 参数（`gen_ai.tool.call.arguments`）与结果（`gen_ai.tool.call.result`），全平台，2048 字节截断
- 用户 prompt（`nio.turn.user_prompt`），全平台，仅用户可见输入层
- turn 级聚合 token 与 cache 命中率
- guard 决策属性（`nio.guard.*`），含拦截路径的一次性完整 span

### 未覆盖

| 缺口 | 现状 |
|---|---|
| LLM response | 仅 OpenClaw 有 `nio.turn.assistant_reply`；CC/Codex/Hermes 为空 |
| thinking | 全平台零覆盖，代码库无任何相关字段 |
| LLM 调用级 span | 不存在，只有 turn 级聚合 |
| MCP 维度 | MCP 调用与普通工具混在同一 `execute_tool` span |
| session span | `SessionStart` 仅写 audit，不构成 trace |
| 崩溃丢根 | root span 在 `Stop` 时补发，进程被杀则子 span 全部成为孤儿 |
| 并发 key 冲突 | Hermes 无 `tool_use_id` 时用 `name:summary` 作 key，并发同名同参互相覆盖 |

### 数据可得性调研结论

**Claude Code**（已实机验证）：transcript JSONL 每条 assistant entry 即一次 LLM 调用，含 `requestId`、`model`、per-call `usage`、`stop_reason`、`timestamp`，`content` 数组内 `text` / `thinking` / `tool_use` 三种块并存，另有 `isSidechain`（subagent 标记）与 `attributionSkill`（skill 归因）。`parseTranscriptUsage` 已在读此文件，仅取 usage 数字后丢弃 content。

**Codex**（部分验证）：`Stop` hook payload 直接携带 `last_assistant_message` 与 `model`（见 `src/tests/fixtures/codex/stop.json`），当前代码未读取。rollout JSONL 格式未验证。

**Hermes**（未验证）：`post_llm_call` payload 形状无样本。`hermesToCollectorInput` 仅提取 6 个字段，`Stop` 分支无内容提取逻辑。

**OpenClaw**（部分验证）：`llm_output` 事件提供 `assistantTexts` 与 `usage`，已采集。是否含 reasoning 字段未验证。

### 附带发现的实现缺陷

`hermesToCollectorInput` 从未提取 `transcript_path`，导致 Hermes 上 `input.transcript_path` 恒为 `undefined`。而 `docs/COLLECTOR-SIGNALS.md:159` 与 `docs/ARCHITECTURE.md:721` 均描述"当 `post_llm_call` 提供 transcript path 时走与 Claude Code 相同的代码路径"——该条件在当前实现下永不成立。**Hermes 的 token usage 实际恒为空**，而非文档所述的"取决于 payload"。Phase 6 修正。

## 设计决策汇总

| 编号 | 决策 | 结论 |
|---|---|---|
| D1 | 拆分方式 | 单一 spec 定义完整目标架构，实施拆 Phase |
| D2 | 内容载体 | traces 存元数据，logs 存内容，`span_id` 关联 |
| D3 | 发送粒度 | 只发增量，不发全量 messages 数组 |
| D4 | session 层级 | session 独立 trace，turn trace 用 span link 指向 |
| D5 | tool span 归属 | 嵌套在发起它的 chat span 下 |
| D6 | 发送时机 | span 结构延迟至 turn 结束统一发；内容实时发 |
| D7 | 采集总闸 | 默认静默，`/nio-monitor` 显式开启 |
| D8 | 回溯 | 不提供。采集严格从 `/nio-monitor` 执行后开始 |
| D9 | 本地 audit | 继续写（仅元数据），总闸只管外发 |
| D10 | guard 拦截 | 与采集开关正交，始终工作 |
| D11 | 采集架构 | 双模抽象 `ConversationSource` → `ChatCall[]` |
| D12 | 脱敏 | key 名扫描 + 正文模式扫描 |

## 一、采集总闸

### 配置

```yaml
collector:
  monitor_all_sessions: false   # 默认 —— 所有 session 静默
                                # true 恢复全采（CI / 团队机器）
```

### 状态存储

新文件 `~/.nio/monitored-sessions.json`，独立于 `traces-state-store.json`。分离理由：trace state 是 turn 级易失状态（每轮清空），monitor 状态是 session 级持久状态，生命周期不同。

```jsonc
{
  "sessions": {
    "<session-id>": {
      "armed_at": 1754300000,
      "cwd": "/path/to/project"
    }
  },
  "pending_arm": {
    "at": 1754300000,
    "cwd": "/path/to/project"
  }
}
```

### session 绑定策略

两级，优先用可靠路径：

1. **环境变量直绑**。Claude Code 提供 `CLAUDE_CODE_SESSION_ID`（已验证）。脚本直接读取并写入 `sessions`，当场生效。其他平台的等价变量在 Phase 2 验证。
2. **pending-arm 兜底**。环境变量不可用时写 `pending_arm`，下一个 hook 事件到来时以 `cwd` 匹配 + 60 秒超时绑定当前 session id，绑定后立即清除 `pending_arm`。

超时与 cwd 匹配用于防止多个并发 session 争抢绑定。

### 判定点

每个 hook 进程启动时读取一次状态文件，决定**是否创建 OTEL provider**。不创建而非创建后过滤——三个信号从源头静默，同时省去 OTLP 初始化开销。`guard-hook.ts` 中的 provider 创建同样受控。

代价为每个 hook 事件增加一次小文件读取；当前已读取 config 与 state 两个文件，增量可接受。

### 不受总闸影响

- guard 的 Phase 0–6 拦截逻辑（纯本地计算，安全能力不可被采集开关禁用）
- 本地 `~/.nio/audit.jsonl` 写入（不出网，为 `/nio report` 与事后查证的数据源）

**内容（prompt / response / thinking / tool IO）在任何情况下不写入本地 audit**，仅在监控开启时直接发往后端，避免 audit.jsonl 沉淀为隐私文件。

### 技能形态

新增 focused skill `nio-monitor`（源于 `plugins/shared/skills/nio-monitor/`），同时在 umbrella skill 挂载 `/nio monitor <on|off|status>`。脚本沿用 sibling-reference 模式引用 `../nio/scripts/`，不重复打包。

CLI 契约：

```
/nio-monitor              开启当前 session 的采集
/nio-monitor off          关闭
/nio-monitor status       显示当前 session 与全局状态
```

### 生效时机

状态文件在每个 hook 进程启动时读取，因此 `/nio-monitor` 的开启/关闭**从下一个 hook 事件开始生效**。已在执行中的当前工具调用不受影响。这是 per-hook 进程模型的固有行为，非缺陷。

### 不提供回溯

采集严格从 `/nio-monitor` 执行后开始，开启前发生的调用不予补采。

原因是平台能力不一致：Claude Code 与 Codex 有会话文件可回放，Hermes 与 OpenClaw 走实时事件通路、进程内不留历史，物理上无法回溯。与其提供一个"部分平台可用、部分平台静默降级"的选项，不如统一为不提供——行为一致，用户心智无歧义。

**注意**：不回溯 ≠ 不读会话文件。Claude Code 无 LLM 调用级 hook，thinking 与 chat span 仍只能从 transcript 解析获得。区别在于每个 turn 结束时只解析该 turn 新增的条目（以 `turn_start_ms` 为界），而非回放整个 session。

### GC

`SessionEnd` / `session_end` 时删除对应记录；另按 `armed_at` 做 7 天过期兜底，防止异常退出遗留孤儿条目导致文件无限增长。

## 二、Trace 模型 v2

### 目标结构

```
trace A = session（独立，单 span）
  session

trace B = turn N                    ⟵ span link → trace A
  turn (root)
  ├─ chat #1                        LLM 调用：thinking → 决定调 Bash
  │   └─ execute_tool Bash
  ├─ chat #2                        LLM 调用：读结果 → thinking → 决定调 Read
  │   └─ execute_tool Read
  └─ chat #3                        LLM 调用：最终回复
```

### chat span（新增层）

一次 LLM 调用对应一个 chat span。span 名 `chat`，遵循 OTel GenAI `gen_ai.operation.name = "chat"`。

属性（均为元数据，正文在 logs）：

| 属性 | 说明 |
|---|---|
| `gen_ai.request.model` | 模型名 |
| `gen_ai.response.id` | 请求 id（CC 用 `requestId`，用于识别重试） |
| `gen_ai.usage.input_tokens` / `output_tokens` | 本次调用 token |
| `gen_ai.usage.cache_read.input_tokens` / `cache_creation.input_tokens` | 本次调用缓存 token |
| `gen_ai.response.finish_reasons` | 停止原因 |
| `nio.content.thinking_chars` | thinking 总字符数 |
| `nio.content.text_chars` | 文本回复总字符数 |
| `nio.content.blocks` | 内容块数量 |
| `nio.chat.is_sidechain` | 是否 subagent 产生 |

### session trace 与 span link

`SessionStart` 时生成 session trace id 与 span id 并存入状态；`SessionEnd` 时发出 session span。每条 turn trace 的 root span 携带一个 span link 指向 `(session_trace_id, session_span_id)`。

session span id 在 `SessionStart` 时预生成并持久化，使 turn 侧无需等待 session 结束即可构造 link。

**存储位置**：session trace id / span id / 起始时间存入 `traces-state-store.json`（trace 相关状态），不放入 `monitored-sessions.json`（后者仅承载采集开关语义）。两个文件职责不混。

### 发送时机

由 D5（tool 嵌套 chat）推导：chat 的归属关系需等 transcript 写入后方可确定，故**整个 turn 的 span 树在 `Stop` 时一次性发送**。

内容日志不受此约束，实时发送。两者靠预生成的 `span_id` 关联——现有代码已在 `PreToolUse` 时预生成 span_id 存入 state，机制可直接复用。

**后端将先收到内容日志，数十秒后才收到对应 span**，崩溃补发场景下间隔可能更长。由于 `span_id` 在两侧一致，关联不受顺序影响。但后端若有"日志引用了不存在的 span"类告警，需要相应放宽。

### 崩溃兜底

延迟发送使崩溃损失从"丢失 root span"升级为"丢失整棵树"，因此兜底机制同步升级：

1. **惰性补发**：任一事件进入时检查上一 turn 是否仍处于开启状态。若开启但 session 已变更或已超时，以最后一个子 span 的结束时间作为 turn 结束时间，补发整棵树并标记 `nio.turn.incomplete = true`。
2. **启动扫描**：`SessionStart` 时扫描状态文件中是否存在上次崩溃遗留的未发送 span 树，存在则补发。

session span 使用同一套逻辑兜底。

### state 体积控制

state 仅保存 span 元数据（span_id、时间戳、token 数、层级关系），内容已实时发出，不驻留。避免 turn 内工具调用累积导致状态文件膨胀、每事件读写退化。

### guard 拦截的实时性

拦截事件**通过 logs 信号立即发送**（guard 当前已写 OTLP logs），trace 中的 span 随 turn 一并延迟。实时告警与完整层级两者兼得。

### 两个小修

**MCP 维度**：识别 `mcp__<server>__<tool>` 命名，产出 `gen_ai.tool.type = "mcp"` 与 `nio.mcp.server = "<server>"`，使 MCP 调用可独立统计。

**并发 key 冲突**：`spanKey` 的 composite fallback 追加自增序号，同 key 二次出现变为 `name:summary#2`，消除并发同名同参互相覆盖。

## 三、内容管线

### 统一中间表示

```
ChatCall {
  callId       string     本次 LLM 调用 id（CC 用 requestId）
  model        string?
  startMs      number
  endMs        number
  usage        { input, output, cacheRead, cacheWrite }?
  stopReason   string?
  blocks       ContentBlock[]
  isSidechain  boolean
}

ContentBlock {
  type     'thinking' | 'text' | 'tool_use'
  index    number      在本次调用内的序号，保序
  content  string
  fidelity 'full' | 'summary'     仅 type='thinking'，见下
  toolUse  { id, name, input }?   仅 type='tool_use'
}
```

**`fidelity` 是必需的，不是可选装饰。** thinking 块存在两种性质截然不同的数据：

- `full` —— 模型的完整推理原文
- `summary` —— 模型对自身推理的步骤级摘要（实测约占实际推理的 3%，只述"做了哪几步"，不含"为什么"）

缺了这个标记，后端里一行 40 字符的步骤标题与一段千字的完整推理链会呈现为同类数据。任何基于 thinking 的分析（行为审计、异常检测、推理质量评估）都会因此得出错误结论——把"摘要里没提到风险"误读成"模型没考虑风险"。

**必须运行时判定，不得按平台硬编码。** 同一平台换个模型 fidelity 就变（见平台矩阵一节）。判定依据是数据形态本身：

| 观察到的形态 | fidelity | 出处 |
|---|---|---|
| Anthropic `thinking` 内容块 | `full` | Claude Code transcript；Hermes/OpenClaw 配 Anthropic 模型时 |
| `summary[].text` 型条目（伴随 `encrypted_content`） | `summary` | Codex rollout 的 `reasoning` 条目；Hermes 的 `codex_reasoning_items[]` |
| 仅有 `encrypted_content`、`summary` 为空 | 不产出 thinking 块 | Codex `effort=medium` 及以下 |

判定应在各 `ConversationSource` 实现内完成——它是唯一能看到原始形态的一层。上层 `chat-span-emitter` 只消费已标记好的 `ChatCall`。

对应地，内容日志的 `nio.content.type` 保持 `thinking` 不变，另以属性 `nio.content.fidelity` 承载该标记，便于后端在查询层直接过滤。

`blocks[]` 的顺序性是还原"想 → 说 → 想 → 调工具"流程的前提，不可合并或重排。

**增量原则**（D3）：每个 `ChatCall` 仅包含本次 LLM 调用**新产生**的内容，不含历史上下文。完整对话由后端按 trace 聚合重建。若每次调用都发送完整 messages 数组，长会话的传输量将呈 O(n²) 增长。

### ConversationSource 抽象

```
ConversationSource (接口)
├─ TranscriptReplaySource   Claude Code / Codex —— turn 结束时读会话文件，一次遍历产出全部 ChatCall
└─ StreamingSource          Hermes / OpenClaw —— 实时事件累积为同一结构
```

上层 `chat-span-emitter` 只消费 `ChatCall[]`，不感知数据来源。新平台接入仅需实现接口。

### 内容日志结构

每个 ContentBlock 对应一条 LogRecord：

```
LogRecord
  trace_id   = <turn trace id>          OTel 内建字段
  span_id    = <所属 chat span id>       OTel 内建字段
  attributes = {
    nio.content.type:  thinking | text | tool_input | tool_output | user_prompt
    nio.content.index: <块序号>
    nio.trace_id:      <冗余，字符串>
    nio.span_id:       <冗余，字符串>
    gen_ai.tool.call.id: <仅 tool 相关块>
  }
  body       = <正文>
```

**`trace_id` / `span_id` 冗余为普通 attribute 的理由**：OTLP 中二者为 LogRecord 内建二进制字段，各后端映射后的字段名不一致（`span_id` / `SpanId` / structured metadata）。冗余一份普通字符串字段保证任意后端均可 join。

**实现要点**：当前 `logs-collector.ts` 的 `emitAuditLog` 未传 context，而 nio 使用 `ROOT_CONTEXT` 手工构造 span，无活跃 context，导致现有 log record 的 trace_id / span_id 为空。需在 emit 时显式传入 span context。

### 截断上限

按类型分别配置，超限截断并标记 `nio.content.truncated = true` 与原始长度 `nio.content.original_bytes`。

**截断的目的是拦截异常输出，而非限制正常内容。** 内容改走 logs 信号后，trace 后端的 attribute 长度限制不再适用，阈值得以从 2 KB 量级放大至 64 KB 量级。正常的 thinking（2–10 KB）与 LLM 回复不会触及上限；触及上限的通常是失控的工具输出（`cat` 大文件、`find /` 全盘遍历等）。

保留上限的三个硬约束：

1. **OTLP 请求大小**：gRPC 默认单 message 上限 4 MB，超限为整条发送失败而非截断
2. **hook 阻塞**：hook 同步阻塞宿主 agent，读取并脱敏扫描超大内容会直接拖慢用户
3. **后端单条日志限制**：Loki 等对单行长度有限制，超限该条被拒收

| 内容类型 | `nio.content.type` | 默认上限 |
|---|---|---|
| thinking | `thinking` | 64 KB |
| LLM 文本回复 | `text` | 64 KB |
| 用户 prompt | `user_prompt` | 32 KB |
| 工具参数 | `tool_input` | 16 KB |
| 工具结果 | `tool_output` | 32 KB |

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

**逃生阀**：任一项设为 `0` 表示不限制该类型。默认值保留上限——触发失控输出的通常不是用户的主动操作，而是 agent 自行执行了预期外的命令，此时上限是保护而非阻碍。

span 上保留短摘要（沿用现有 `nio.tool_summary`，前 200 字符），便于在 trace 列表中扫视而无需下钻。

### 脱敏

在现有 key 名扫描（`SECRET_KEY_RE`）之上增加**正文模式扫描**，覆盖：

- Anthropic key（`sk-ant-*`）
- AWS access key（`AKIA*`）
- GitHub token（`ghp_*` / `gho_*` / `ghs_*`）
- JWT（三段 base64 点分结构）
- PEM 私钥块（`-----BEGIN * PRIVATE KEY-----`）
- HTTP `Authorization: Bearer *` 头
- 高熵长随机串（需配合白名单避免误伤）

支持配置追加自定义模式。

**误伤防护**：git commit hash、UUID、文件路径中的长串不得被判定为密钥。此项须有专门的负向测试。

## 四、平台覆盖矩阵

| 平台 | prompt | response | thinking | LLM 级 span | 依据 |
|---|---|---|---|---|---|
| Claude Code | 是 | 是 | 取决于模型（Claude → 完整原文） | 是 | 已实机验证 |
| Codex | 是 | 是 | 取决于模型（GPT-5 → 步骤摘要，需 `effort=high`） | 是 | 已实机验证 |
| Hermes | 是 | 是（`assistant_response`） | 取决于模型（实测 gpt-5.5 → 步骤摘要） | 是（事件对） | 已实机验证 |
| OpenClaw | 是 | 是 | 取决于模型 | 是 | 官方文档，**未实机验证** |

### thinking 的形态由模型提供商决定，不是平台属性

这是本矩阵最关键的一条，也是最容易搞错抽象层级的地方。**四个平台没有一个"不支持 thinking"——能拿到什么完全取决于底层配了哪家模型。**

- **Anthropic 模型** → 返回完整 thinking 块，原文可得
- **OpenAI reasoning 系列**（o 系列 / GPT-5）→ API 层面不暴露 raw chain-of-thought，最多给步骤级摘要，这是产品策略非技术限制

Hermes / OpenClaw 这类多 provider 平台本质是**转发层**：底层给什么就存什么。实测佐证——Hermes 配 gpt-5.5 时，assistant 消息里出现的字段名是 `codex_reasoning_items`，条目内 `_issuer_kind: "codex_backend"`，即 Hermes 按 provider 分别存放原始 item 并以 provider 名作前缀。同一个 Hermes 部署换成 Anthropic 模型，拿到的就会是完整 thinking 块。

**因此 `fidelity` 必须运行时判定，不能按平台硬编码**（判定规则见下文 ContentBlock 一节）。按平台写死是错误的抽象层级——这个错误在本 spec 前两版中犯过两次，先后把 Codex 和 Hermes 的模型限制误记为平台限制。

**Codex 实测数据**（gpt-5.5，同一 prompt 两次会话对照）：

| `model_reasoning_effort` | reasoning 条目 | summary |
|---|---|---|
| `medium` | 17 个 | **全部为空** |
| `high` | 2 个 | 全部有内容 |

`model_reasoning_summary` 保持默认 `auto` 未变——唯一变量是 effort。`auto` 的语义是"模型自行决定是否生成"，medium 下它判定不必生成。

拿到的内容形态：

```json
"summary": [
  {"type": "summary_text", "text": "**Planning to create toy project in /tmp**"},
  {"type": "summary_text", "text": "**Assessing apply_patch file creation constraints**"}
]
```

每条 30–50 字符的加粗短语，描述"这一步在做什么"，**不含推理内容**——为什么选这个方案、排除了什么、如何权衡，全都不在里面。

量化：`summary` 文本共 217 字符，同批 `encrypted_content` 共 7000 字符，**比值 3.1%**。其余 97% 的实际推理锁在 Fernet 加密串里（`gAAAAAB` 前缀），密钥在服务端，设计上只用于回传 API 保持多轮上下文，客户端无法解密。`content` 字段（原始轨迹）在响应中根本不存在。

**对实现的约束**：`ChatCall` 的 thinking 块必须携带来源标记，区分"完整原文"与"步骤摘要"。否则同一后端里 Codex 的一行标题与 Claude Code 的完整推理链呈现为同类数据，消费者会误判其分析价值。

**对采集的约束**：nio 无法控制用户的 effort 配置，因此 Codex 侧 thinking 是尽力而为——medium 及以下为空属正常，不是采集故障，不应触发诊断告警。

### Codex 已实机确认的其余结构

除 thinking 外，Codex 的 rollout JSONL 提供的信息比 Claude Code 更丰富：

| 数据 | 位置 |
|---|---|
| user prompt | `response_item/message` role=`user` |
| **developer/system prompt** | role=`developer` — Claude Code 无此项 |
| assistant 回复 | role=`assistant`；亦见 `event_msg/agent_message` 与 `task_complete.last_agent_message` |
| token usage | `event_msg/token_count.info`：`last_token_usage` / `total_token_usage` / `model_context_window` |
| **首 token 延迟** | `task_complete.time_to_first_token_ms` — Claude Code 无此项 |
| turn 耗时 | `task_complete`：`duration_ms` / `started_at` / `completed_at` |
| 工具调用 | `function_call`（`name` / `arguments` / `call_id`）↔ `function_call_output`（`call_id` / `output`）靠 `call_id` 配对 |

**per-call 边界的切分规则与 Claude Code 不同**。Claude Code 每条 assistant entry 即一次调用；Codex 是扁平的 `response_item` 流，`turn_id` 是 turn 级而非 call 级，需以 `reasoning` 条目（或收尾的 `message(assistant)`）作为新调用的起点标记：

```
reasoning → function_call → reasoning → function_call → … → message(assistant)
```

这正好印证 `ConversationSource` 双模抽象的必要性——两个平台的解析逻辑无法共用。

### Hermes 已实机确认的结构

用 `NIO_DUMP_PAYLOAD` 采样 `post_llm_call`（模型 gpt-5.5，走 codex_backend）：

```
extra.user_message          str
extra.assistant_response    str（3615 字符）
extra.conversation_history  list（30 条：user 1 / assistant 13 / tool 16）
extra.model                 "gpt-5.5"
extra.platform              "cli"
```

**`assistant_response` 与 `conversation_history` 均确实存在。** 而当前 `hermesToCollectorInput` 只提取 6 个字段，`Stop` 分支无任何内容提取逻辑——这两个字段一直在 payload 里未被取用，属既有缺陷（Phase 4 修复）。

assistant 消息出现的全部键：

```
role · content · finish_reason · tool_calls
reasoning              13 条 —— 摘要文本
reasoning_content       7 条 —— 与 reasoning 内容重复
codex_reasoning_items   8 条 —— 原始 API item
```

三者是同一份数据的三种形态：`codex_reasoning_items[]` 是原始响应（含 `encrypted_content` 1060–2296 字符 + `summary[]`），`reasoning` / `reasoning_content` 是从其 `summary[].text` 拼接而来的摘要文本，两者内容一致。

**无 transcript 路径字段**——因此 `docs/COLLECTOR-SIGNALS.md` 与 `docs/ARCHITECTURE.md` 中"当 `post_llm_call` 提供 transcript path 时走 Claude Code 同款路径"的描述应删除而非修正：该字段不存在，条件永不成立（Phase 6）。

### 未实机验证项

**OpenClaw** 未能实机验证——采样时发现该机器上 OpenClaw 安装已损坏（`MODULE_NOT_FOUND`，pnpm 全局目录下 `openclaw/dist/index.js` 缺失，gateway 无法启动）。此为环境问题，与本设计无关。

按官方文档实现，风险记录：

| 项 | 文档依据 | 风险 |
|---|---|---|
| `llm_output` 内容字段 | 官方字段表仅 `runId`/`callId`/`provider`/`model`/`outcome`/`durationMs`/`upstreamRequestIdHash`/`contextTokenBudget` 等**元数据** | 现有代码读的 `assistantTexts` / `usage` **不在文档列表内**，可能依赖未文档化行为，上游改版有静默断裂风险 |
| thinking 通道 | reasoning 作为独立消息发送（带 `Thinking` 前缀），受 `/reasoning on\|off\|stream` 控制 | 很可能需从消息流事件（`before_agent_reply` / `before_message_write` / `message_sending`）获取而非 `llm_output`；且用户关闭 reasoning 显示时无数据 |

实现时按文档编码，解析层对缺失字段 fail-safe 降级（字段不存在即视为不提供该项，不抛异常、不告警）。`NIO_DUMP_PAYLOAD` 已就位，环境修复后可随时低成本补验。

**注意**：OpenClaw 的 thinking「支不支持」不需要单独验证——它与 Hermes 同为转发层，走完全相同的运行时 fidelity 判定逻辑。真正未覆盖的是「Anthropic 模型 → 完整 thinking」这条路径在 Hermes/OpenClaw 上的表现，但该路径的数据形态已由 Claude Code 的实机验证覆盖。

**降级原则**：平台确实不提供的数据，在 `docs/COLLECTOR-SIGNALS.md` 中如实标注覆盖边界，不做虚假承诺。

## 五、分阶段实施

```
Phase 1  采集总闸
         /nio-monitor skill + config + monitored-sessions.json + provider 判定点
         必须最先完成 —— 否则后续开发调试期间测试数据持续外发

Phase 2  平台能力验证 —— 已收敛，不再阻塞后续
         Claude Code / Codex / Hermes 已实机验证（结论见"平台覆盖矩阵"）
         OpenClaw 因该机器安装损坏未能验证，按官方文档实现，风险已登记
         NIO_DUMP_PAYLOAD 调试开关已就位，环境修复后可随时低成本补验

Phase 3  trace 骨架 v2
         chat span + tool 嵌套 + 延迟发送 + 崩溃补发 + session trace/link

Phase 4  内容管线
         ConversationSource + ChatCall + 内容日志 + 脱敏 + 截断
         ConversationSource 的解析实现（会话文件 → ChatCall[]）与 Phase 3
         无依赖，可并行开发；内容日志的发送需 Phase 3 的 span_id 生成
         逻辑就位后方可接线

Phase 5  小修
         MCP 维度 + 并发 key 冲突

Phase 6  文档修正
         COLLECTOR-SIGNALS.md / ARCHITECTURE.md 中 Hermes transcript 的错误描述
```

## 六、测试策略

### 双 source 对拍

`TranscriptReplaySource` 与 `StreamingSource` 输入等价数据须产出一致的 `ChatCall[]`。这是双模抽象的最大风险点——两套实现语义漂移将使上层失效。

### Fixture

需要脱敏后的真实会话文件样本。当前 `src/tests/fixtures/codex/` 仅有 hook payload，无会话文件。

Codex 侧的真实结构已在 Phase 2 摸清（含 `reasoning` / `function_call` / `function_call_output` / `token_count` / `task_complete`），但采到的样本含完整 developer prompt 与真实对话，**不可直接入库**。应按真实结构生成合成 fixture：条目类型、字段名、嵌套形态与真实文件一致，内容全部替换为无意义占位。

Hermes 已有实机样本（`post_llm_call` 完整 envelope，含 30 条 `conversation_history`），同样含真实对话，须合成后入库。

OpenClaw 无实机样本，其解析器测试以按文档构造的合成 fixture 驱动，并在 fixture 文件头注明"基于官方文档构造，未经实机校验"。

### 沙箱约束

所有 e2e 使用 `$(mktemp -d)` 作为 `NIO_HOME`，不得读写真实 `~/.nio/config.yaml`、`~/.hermes/` 或任何真实用户路径。总闸相关测试尤须注意：不得将真实 session id 写入真实 `monitored-sessions.json`。

### 脱敏对抗测试

正向：各类密钥格式均被替换。
负向：git commit hash、UUID、普通长路径不被误伤。

### 总闸测试矩阵

- `monitor_all_sessions: false` + 未开启 → 三信号零外发，本地 audit 仍写
- `monitor_all_sessions: false` + `/nio-monitor` 开启 → 全量采集
- `monitor_all_sessions: true` → 无视 session 状态全采
- 开启后 `off` → 立即停止
- guard 拦截在所有组合下均正常工作

## 七、错误处理

沿用现有原则：**遥测永不破坏宿主**。所有新代码路径包裹 try/catch，失败经 `reportDiagnostic` 记录诊断，不向宿主抛出。

新增风险点：transcript 文件可能达数十 MB。当前 `parseTranscriptUsage` 将整个文件读入内存后 split，在内容捕获场景下须改为增量读取，并设置文件大小上限与解析超时，避免读文件阻塞 hook。

## 附：受影响的主要文件

| 文件 | 变更 |
|---|---|
| `src/scripts/lib/traces-collector.ts` | chat span、span link、延迟发送、崩溃补发 |
| `src/scripts/lib/traces-state-store.ts` | state 结构扩展（span 树、session trace） |
| `src/scripts/lib/logs-collector.ts` | 内容 LogRecord、trace context 传入 |
| `src/scripts/lib/collector-core.ts` | 事件路由调整、并发 key 修复、MCP 维度 |
| `src/scripts/lib/conversation-source/` | 新增：接口 + 两种实现 |
| `src/scripts/lib/monitor-gate.ts` | 新增：总闸判定 |
| `src/scripts/hook-cli.ts` | Hermes transcript_path 提取、内容提取分支 |
| `src/scripts/collector-hook.ts` | Codex `last_assistant_message` 读取 |
| `src/adapters/openclaw-plugin.ts` | StreamingSource 接入 |
| `plugins/shared/skills/nio-monitor/` | 新增 skill |
| `docs/COLLECTOR-SIGNALS.md` | 新信号文档 + Hermes 描述修正 |
