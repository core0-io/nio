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
  toolUse  { id, name, input }?   仅 type='tool_use'
}
```

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

| 平台 | prompt | response | thinking | LLM 级 span | 状态 |
|---|---|---|---|---|---|
| Claude Code | 是 | 是 | 是 | 是 | 已实机验证 |
| Codex | 是 | 是（`last_assistant_message`） | 待验证 | 待验证 | 部分验证 |
| Hermes | 是 | 待验证 | 待验证 | 是（事件对） | 未验证 |
| OpenClaw | 是 | 是（`assistantTexts`） | 待验证 | 是（`llm_output`） | 部分验证 |

### 待验证项与验证方法

| 项 | 验证方法 | 降级策略 |
|---|---|---|
| Codex rollout JSONL 格式 | 实机跑一次 Codex 会话，采集 rollout 文件样本 | 若无 thinking，仅从 hook payload 取 response，thinking 标注为平台不支持 |
| Hermes `post_llm_call` payload | 实机触发一次，dump 完整 envelope | 若无内容字段，Hermes 仅支持 prompt + tool IO |
| OpenClaw `llm_output` reasoning 字段 | 查阅上游事件定义 + 实机 dump | 若无，OpenClaw thinking 标注为不支持 |
| 各平台 session id 环境变量 | 实机 `env` 检查 | 回落 pending-arm 机制 |

**降级原则**：平台确实不提供的数据，在 `docs/COLLECTOR-SIGNALS.md` 中如实标注覆盖边界，不做虚假承诺。

## 五、分阶段实施

```
Phase 1  采集总闸
         /nio-monitor skill + config + monitored-sessions.json + provider 判定点
         必须最先完成 —— 否则后续开发调试期间测试数据持续外发

Phase 2  平台能力实机验证
         三项待验证 + session id 环境变量，产出真实 payload / 会话文件样本
         结论决定 Phase 3/4 的平台覆盖范围

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

需要脱敏后的真实会话文件样本。当前 `src/tests/fixtures/codex/` 仅有 hook payload，无会话文件。Phase 2 验证时一并采集。

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
