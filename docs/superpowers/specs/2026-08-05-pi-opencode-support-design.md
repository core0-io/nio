# Pi + opencode Platform Support — Design

**Status:** approved (design phase)
**Date:** 2026-08-05
**Scope:** Bring the full Nio feature set — guard Phase 0–6, OTEL collector (traces / metrics / logs), audit log, `/nio` skill surface, installer, release pipeline — to two new agent platforms: **Pi** (`earendil-works/pi`, `@mariozechner/pi-coding-agent`) and **opencode** (`sst/opencode`).

---

## 1. Background

Nio currently supports four platforms via two structurally different integration styles:

| Style | Platforms | Mechanism |
|---|---|---|
| Out-of-process hook scripts | Claude Code, Codex | Platform spawns `guard-hook.js` / `collector-hook.js` per event; state bridged through disk |
| In-process plugin | OpenClaw, Hermes | Plugin/daemon loads a bundled JS module; state lives in memory |

Pi and opencode are both **in-process plugin** platforms, structurally identical to OpenClaw. That makes `src/adapters/openclaw-plugin.ts` (576 lines) the natural template — and also the problem: roughly 70% of that file is platform-agnostic (config load, three OTEL providers, per-session turn/span state machine, guard-decision → span-attribute translation, orphan-span compensation on the block path, `flushSessionTurn`, audit-log writes). Copying it twice more would produce ~1700 lines of triplicated, drift-prone logic.

### 1.1 Research provenance

Every platform claim in this document was verified against primary sources, not documentation summaries:

- **Pi**: `earendil-works/pi` → `packages/coding-agent/docs/{extensions,packages,skills,settings,security}.md`; built-in tool names read from `packages/coding-agent/src/core/tools/*.ts` (`name:` field).
- **opencode**: `sst/opencode` → `packages/plugin/src/index.ts` (the `Hooks` interface), `packages/plugin/src/tool.ts`, `packages/sdk/js/src/gen/types.gen.ts` (`Event` union, `Session`, `AssistantMessage`, `Permission`), `packages/opencode/src/session/tools.ts` (hook trigger sites), `packages/opencode/src/plugin/{index,loader}.ts`, `packages/opencode/src/config/plugin.ts`, `packages/opencode/src/mcp/catalog.ts`; docs under `packages/web/src/content/docs/`.

---

## 2. Goals / Non-Goals

### Goals

- Full functional parity with existing platforms: guard Phase 0–6 blocking, OTEL traces + metrics + logs, local audit log, `/nio` command, unified `nio` skill plus the six focused skills, idempotent `setup.sh` with `--uninstall` / `--config` / `--reset-to-defaults`, per-platform release zip.
- Extract the platform-agnostic in-process plugin logic into a single shared runtime so all three in-process platforms share one telemetry implementation.
- Zero behaviour change for the existing OpenClaw integration.

### Non-Goals

- No changes to the decision core (`src/core/`, `src/scanner/`, `src/policy/`). Phase 0–6 logic is untouched.
- No MCP support for Pi (the platform has none — see §4.3).
- No native subagent/Task spans for Pi (the platform has no subagent concept — see §4.2).

---

## 3. Architecture

### 3.1 Layering

```
┌─────────────────────────────────────────────────────────────┐
│ Decision core — src/core, src/scanner, src/policy           │  UNCHANGED
│ Phase 0–6, 15 static + 7 behavioural rules, score aggregation│
└─────────────────────────────────────────────────────────────┘
             ▲ evaluateHook(adapter, rawEvent, opts)
┌─────────────────────────────────────────────────────────────┐
│ Guard adapter layer — implements existing HookAdapter        │
│ claude-code.ts  codex.ts  hermes.ts  openclaw.ts             │
│ + pi.ts (NEW)   + opencode.ts (NEW)                          │
└─────────────────────────────────────────────────────────────┘
             ▲
┌─────────────────────────────────────────────────────────────┐
│ In-process plugin runtime — plugin-runtime.ts (NEW)          │
│ config · 3 OTEL providers · sessionState · pendingGuardAttrs │
│ guard→attrs translation · orphan-span compensation · flush   │
│ Knows NO platform event names.                               │
└─────────────────────────────────────────────────────────────┘
             ▲ semantic calls
┌─────────────────────────────────────────────────────────────┐
│ Platform binding layer — thin event translators (~150 loc ea)│
│ openclaw-plugin.ts (SLIMMED)  pi-plugin.ts (NEW)             │
│ opencode-plugin.ts (NEW)                                     │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 `InProcessPluginRuntime` interface

Constructed with `{ platform, config, adapter }`. Exposes semantic methods only:

```ts
onPreTool(sessionId, spanKey, toolName, params, rawEvent):
  Promise<{ block: boolean; reason?: string;
            decision: 'allow' | 'deny' | 'confirm_allowed' | 'confirm_denied' | 'ask' }>
onPostTool(sessionId, spanKey, toolName, { result, error, durationMs }): Promise<void>
onUserPrompt(sessionId, text): void
onAssistantReply(sessionId, text): void
onLlmUsage(sessionId, { input, output, cacheRead, cacheWrite, cost? }): void
onSubagentStart(sessionId, taskId): Promise<void>
onSubagentEnd(sessionId, taskId): Promise<void>
onSessionStart(sessionId): void
onSessionEnd(sessionId): Promise<void>
onTurnEnd(sessionId): Promise<void>
onUserBash(sessionId, command, cwd): void        // audit-only
dispatchCommand(rawArgs): Promise<string>
```

**Key design decision:** `onPreTool` *returns* a decision rather than deciding how to block. Pi needs `{ block: true, reason }`, opencode needs a thrown error, OpenClaw needs `{ block: true, blockReason }`. The `ask` decision is also returned verbatim so Pi can choose to open an interactive confirm dialog. All shape differences stay in the binding layer.

---

## 4. Platform event mapping (verified)

### 4.1 Pi

Source: `packages/coding-agent/docs/extensions.md`.

| Runtime method | Pi event / API | Notes |
|---|---|---|
| `onPreTool` (blocking) | `tool_call` → `{ block: true, reason }` | Documented as **Can block**; `event.input` is mutable in place |
| `onPostTool` | `tool_result` (+ `tool_execution_end`) | Fires even on tool error (`event.isError`) |
| `onUserPrompt` | `input` (`event.text`, `event.source`) | Fires after extension commands, before skill/template expansion |
| `onSessionStart` / `onSessionEnd` | `session_start` / `session_shutdown` | |
| `onTurnEnd` | `turn_end`, `agent_end`, `agent_settled` | `agent_settled` = no retry/compaction/follow-up left |
| `onAssistantReply` / `onLlmUsage` | `message_end` (`event.message.usage`, incl. cost) | HTTP-level also available via `before_provider_request` / `after_provider_response` |
| interactive confirm | `ctx.ui.confirm(title, msg, { timeout })` → `boolean`; guard with `ctx.hasUI` | `timeout` prevents indefinite agent stall |
| `/nio` | `pi.registerCommand("nio", { description, handler })` | Bypasses the LLM entirely |
| `onUserBash` | `user_bash` (`command`, `excludeFromContext`, `cwd`) | Audit-only, never blocks |
| session id | `ctx.sessionManager.getSessionId()` | |
| skill discovery | `resources_discover` → `{ skillPaths }` | Lets the extension contribute skill paths without editing user `settings.json` |

Built-in tools (from `src/core/tools/*.ts`): `bash`, `read`, `write`, `edit`, `ls`, `find`, `grep`. **No network tool** — network access happens through `bash` and is covered by the Phase 1–6 command analysis.

### 4.2 Pi — absent capabilities

- **No subagent concept in Pi core.** No corresponding event exists. Third-party `pi-subagents` is an ordinary custom tool and therefore flows through `tool_call` / `tool_result` like any other tool. Nio emits **no** native Task spans on Pi; subagent tools are recognised by tool name only (configurable), and nothing is emitted when absent.
- **No MCP.** `grep -ic mcp` across all eight Pi documentation files returns 0. Phase 0's MCP gate is permanently empty on Pi. `mcp-registry.ts` gains **no** Pi source; `/nio doctor` prints an explicit "platform does not support MCP" line rather than silently reporting an empty registry.

### 4.3 opencode

Sources: `packages/plugin/src/index.ts`, `packages/sdk/js/src/gen/types.gen.ts`, `packages/opencode/src/session/tools.ts`, `packages/opencode/src/mcp/catalog.ts`.

| Runtime method | opencode hook | Verified at |
|---|---|---|
| `onPreTool` (blocking) | `tool.execute.before(input {tool, sessionID, callID}, output {args})`, **throw to block** | `session/tools.ts:106-111` — hook fires before `item.execute`; a throw means `item.execute` never runs. Also fires for MCP tools (`tools.ts:400-405`) |
| `onPostTool` | `tool.execute.after(…, output {title, output, metadata})` | `session/tools.ts:121-125` |
| `onUserPrompt` | `chat.message(input, output {message, parts})` | `Hooks` interface |
| `onLlmUsage` | `event` → `message.updated`; `AssistantMessage` carries `cost: number` and `tokens {input, output, reasoning, cache{read,write}}` | `types.gen.ts:112-150` |
| pre-LLM | `chat.params`, `chat.headers` | `Hooks` interface |
| `onSessionStart` | `event` → `session.created` (`properties.info: Session`) | `types.gen.ts:562` |
| `onTurnEnd` | `event` → `session.idle` | `types.gen.ts:475` |
| `onSessionEnd` | plugin `dispose?: () => Promise<void>` | `Hooks` interface. **`session.deleted` is deletion, not session end** |
| subagent | `Session.parentID?: string` on `session.created` | `types.gen.ts:533-537` |
| supplementary permission gate | `permission.ask(input: Permission, output {status: "ask"\|"deny"\|"allow"})`; `Permission` carries `callID` | `Hooks` interface, `types.gen.ts:423-437` |
| `/nio` | `commands/nio.md` (`$ARGUMENTS`) + plugin-registered `tool: { nio_command }` | `tool()` is an identity function (`plugin/src/tool.ts`), so a plain object works |

Built-in tools (from the permission-key table in `docs/agents.mdx` and `tool/registry.ts` imports): `read`, `write`, `edit`, `apply_patch`, `glob`, `grep`, `list`, `bash`, `task`, `todowrite`, `todoread`, `webfetch`, `websearch`, `lsp`, `skill`, `question`.

MCP tool naming: `<sanitized-server>_<sanitized-tool>` where `sanitize = value.replace(/[^a-zA-Z0-9_-]/g, "_")` (`mcp/catalog.ts:117-119`). **This is not Claude Code's `mcp__server__tool` form** — there is no fixed delimiter, so identification requires prefix-matching against known server names from the registry.

### 4.4 Known uncertainty

`plugin.trigger` wraps every hook in `Effect.promise(async () => fn(input, output))` (`plugin/index.ts:292`). `Effect.promise` treats a rejection as a *defect*, not a typed error. Consequences:

1. Our thrown block **does** reliably prevent execution (confirmed by control flow in `tools.ts`).
2. How the denial reason surfaces to the model / user **cannot be determined from static reading**. The official `.env protection` example in the plugin docs throws exactly this way, so it is the sanctioned mechanism, but the presentation must be measured empirically — see §8.
3. **Any** exception escaping our handlers becomes an opencode defect. The opencode binding layer therefore requires 100% catch coverage with no bare `await`. This is a hard code-review gate.

---

## 5. Capability asymmetries and how they are resolved

| Concern | Pi | opencode |
|---|---|---|
| `confirm` (Nio decides "needs confirmation") | Real interactive `ctx.ui.confirm(…, { timeout })`. When `ctx.hasUI === false` (`-p` / json mode) or on timeout, fall back to `guard.confirm_action` two-state semantics (timeout ⇒ `confirm_denied`) | Two-state only. `permission.ask` is additionally hooked so Nio's verdict can rewrite `status` whenever opencode itself asks for permission; otherwise folded into `guard.confirm_action` |
| MCP | Not supported by the platform | New `opencode` source in `mcp-registry.ts`; prefix-match tool identification |
| `/nio` dispatch | `pi.registerCommand` → direct, bypasses the LLM (like OpenClaw) | `commands/nio.md` template → model calls `nio_command` tool (like Claude Code / Codex). One LLM hop is unavoidable: opencode has no plugin API for registering slash commands |
| Focused skills (`nio-scan`, …) | Synced — Pi implements the Agent Skills standard | Synced — opencode discovers `.opencode/skills/`, `~/.claude/skills/`, `~/.agents/skills/` |
| User-typed shell (`!cmd`) | `user_bash` subscribed, **audit-only, never blocked** (Nio guards agent actions, not human keystrokes) | No equivalent event |

---

## 6. Components and file inventory

### 6.1 New files under `src/`

| File | Responsibility | Approx. size |
|---|---|---|
| `src/adapters/plugin-runtime.ts` | Platform-agnostic in-process runtime (§3.2) | ~320 |
| `src/adapters/pi.ts` | `PiAdapter implements HookAdapter`, `name = 'pi'` | ~120 |
| `src/adapters/opencode.ts` | `OpenCodeAdapter implements HookAdapter`, `name = 'opencode'` | ~120 |
| `src/adapters/pi-plugin.ts` | Pi binding: `export default function (pi: ExtensionAPI)` | ~150 |
| `src/adapters/opencode-plugin.ts` | opencode binding: `export const NioPlugin: Plugin` | ~150 |

Both binding layers use `import type` only. Pi's runtime helpers (`isToolCallEventType`, `createLocalBashOperations`) are deliberately avoided in favour of plain string comparison, and opencode's `tool()` helper is replaced by a plain object literal, so **both bundles are self-contained with zero external runtime dependencies** (zod is already a Nio dependency and is bundled).

### 6.2 Modified files under `src/`

| File | Change |
|---|---|
| `src/adapters/openclaw-plugin.ts` | Slimmed to ~150 lines; delegates to the runtime. **Behaviour must not change** |
| `src/adapters/index.ts` | Export `PiAdapter`, `OpenCodeAdapter`, both plugin entries, `InProcessPluginRuntime` |
| `src/adapters/mcp-registry.ts` | `MCPSource` gains `'opencode'`; read `~/.config/opencode/opencode.json` and project `opencode.json` `mcp` key (`type: local` → `command[]`, `type: remote` → `url`). **No Pi source** |
| `src/adapters/hook-engine.ts` → `parseMcpToolName()` | New `opencode` branch (§7.4) |
| `src/core/shared/detection-data.ts` | Add sensitive paths `.pi/`, `.pi/settings.json`, `~/.pi/agent/`, `.opencode/`, `~/.config/opencode/` — prevents an agent from rewriting its own guard configuration |
| `src/adapters/diagnostics.ts`, `src/scripts/doctor-cli.ts` | Install probes for both platforms; explicit "Pi does not support MCP" line |
| `src/adapters/config-schema.ts` | **No change** — `native_tool_mapping` / `permitted_tools` / `blocked_tools` are already platform-keyed records |

### 6.3 New plugin directories

```
plugins/pi/                              plugins/opencode/
  package.json    ← pi package manifest    plugins/nio.js   ← bundle
    (pi.extensions, pi.skills,             commands/nio.md
     keywords: ["pi-package"])             skills/nio/ + nio-*/
  extensions/nio/index.js  ← bundle        setup.sh
  skills/nio/ + nio-*/                     config.default.yaml
  setup.sh                                 config.schema.json
  config.default.yaml                      README.md
  config.schema.json
  README.md
```

### 6.4 Pipeline and documentation

`scripts/build.js` (two new bundle targets + skill-script mirroring), `scripts/sync-shared.js` (both platforms into `SKILL_PLUGIN_DIRS` and `FOCUSED_SKILL_PLUGIN_DIRS`), `scripts/release.js` (`pi` / `opencode` targets), `scripts/sync-versions.js` (two new manifests), `package.json` (`release:pi`, `release:opencode`), root `setup.sh` and `install.sh` platform detection; `CLAUDE.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/COLLECTOR-SIGNALS.md`, `plugins/shared/config.default.yaml`, `plugins/shared/config.schema.json`, `plugins/shared/skills/nio/SKILL.md`.

---

## 7. Configuration and data flow

### 7.1 New configuration keys (pure data — schema unchanged)

```yaml
guard:
  native_tool_mapping:
    pi:
      bash: exec_command
      write: write_file
      edit: write_file
      read: read_file
    opencode:
      bash: exec_command
      write: write_file
      edit: write_file
      apply_patch: write_file
      read: read_file
      webfetch: network_request
      websearch: network_request
  permitted_tools: { pi: [], opencode: [] }
  blocked_tools:   { pi: [], opencode: [] }
```

Platform tags are `pi` and `opencode`, yielding `service.name = nio-pi` / `nio-opencode` and `nio.platform = pi` / `opencode`. This honours the contract established at `traces-collector.ts:282`: **platform and agent identity live only on the OTEL Resource and are never duplicated onto spans, log records, or metric labels.** The audit-log `platform` field carries the same value.

### 7.2 Tool-call flow — Pi

```
tool_call(toolName, input, toolCallId)
  sessionId = ctx.sessionManager.getSessionId();  spanKey = event.toolCallId
  runtime.onPreTool → evaluateHook → Phase 0–6 → decision
    ├─ allow  → return undefined; guardAttrs held in pendingGuardAttrs
    ├─ deny   → runtime emits orphan span; return { block: true, reason }
    └─ ask    → ctx.hasUI ? await ctx.ui.confirm(reason, detail, { timeout })
                  ├─ true  → allow,  decisionTag = confirm_allowed
                  └─ false → block,  decisionTag = confirm_denied  (timeout ⇒ false)
                !ctx.hasUI → fall back to guard.confirm_action
tool_result(toolCallId, content, isError)
  runtime.onPostTool → drain pendingGuardAttrs, merge output attrs, close span
```

### 7.3 Tool-call flow — opencode

```
tool.execute.before({ tool, sessionID, callID }, { args })
  sessionId = input.sessionID;  spanKey = input.callID
  runtime.onPreTool → decision
    ├─ allow                  → return
    └─ deny / confirm_denied  → runtime emits orphan span, then throw NioBlockedError(reason)
tool.execute.after({ tool, sessionID, callID, args }, { title, output, metadata })
  runtime.onPostTool → close span
```

Both platforms supply a stable call id (`toolCallId` / `callID`), making pre/post correlation more reliable than OpenClaw's fallback to tool name.

### 7.4 MCP tool-name parsing for opencode

`parseMcpToolName(toolName, platform)` in `src/adapters/hook-engine.ts` already handles three conventions: `mcp__<server>__<tool>` (Claude Code, Codex), `<server>__<tool>` (OpenClaw, Hermes), and an ambiguous Hermes fallback `mcp_<server>_<tool>` where a reliable split is impossible — that branch keeps the **full tool name as `local` and leaves `server` unset**, so users can list the name verbatim in `permitted_tools.mcp` / `blocked_tools.mcp`.

opencode's `<sanitized-server>_<sanitized-tool>` is the same class of ambiguity, so it gets a two-tier `opencode` branch that reuses the existing precedent:

1. **Attribution tier** — longest-prefix match of `<server>_` against server names known to the loaded MCP registry (themselves sanitized the same way). On a hit, return `{ isMcp: true, server, local }`.
2. **Fallback tier** — no registry entry matches: return `{ isMcp: true, local: <full name> }` with `server` unset, exactly like the Hermes branch. Users can then allow/deny by verbatim tool name.

Both tiers are only reachable when the registry is non-empty; with no MCP servers configured, the branch returns `{ isMcp: false }` and native tools are unaffected. Test cases must include server names that themselves contain underscores (the sanitizer produces these routinely, e.g. `my-server.io` → `my-server_io`).

### 7.5 Two span-leak scenarios that must be handled

1. **Post never fires when a call is blocked** — true on both platforms. The runtime proactively emits a guard-error span on the block path (the existing OpenClaw approach).
2. **opencode skips `tool.execute.after` when the tool itself throws** — the `Effect.gen` in `session/tools.ts` short-circuits. Pi does not have this problem (`tool_result` still fires with `isError`). opencode therefore relies on `flushSessionTurn` force-closing all `pending_spans` on `session.idle`. This is an explicit e2e assertion, not an assumption.

---

## 8. Error handling and degradation

The existing **fail-open** principle holds: a Nio failure must never break the host agent. Every handler in both binding layers is wrapped in `try/catch` that silently allows on error — matching current `openclaw-plugin.ts` behaviour.

**One exception:** opencode's `tool.execute.before` must let our own `NioBlockedError` propagate while swallowing everything else. The catch must discriminate by error type.

| Failure | Behaviour |
|---|---|
| `~/.nio/config.yaml` missing / corrupt | Built-in defaults (`balanced`); guard still blocks; doctor warns |
| `collector.endpoint` unset | All three providers `null`; guard unaffected; no telemetry (existing behaviour) |
| OTLP endpoint unreachable | OTEL SDK retries/drops internally; never blocks a tool call (existing behaviour) |
| Phase 5 LLM / Phase 6 external scoring timeout | That phase scores 0; remaining phases aggregate normally (existing behaviour) |
| Pi `ctx.hasUI === false` | `ask` falls back to `guard.confirm_action` |
| Pi confirm dialog timeout | Returns `false` ⇒ treated as `confirm_denied`; the agent never hangs indefinitely |
| opencode tool throws, `after` skipped | `flushSessionTurn` on `session.idle` force-closes pending spans |
| Unexpected event field shapes | All field extraction uses optional chaining with defaults; missing values degrade to `'unknown'`, never throw |

---

## 9. Testing and acceptance

### 9.1 Unit tests

- `src/tests/fixtures/pi/*.json`, `src/tests/fixtures/opencode/*.json` — real event payloads, following the `fixtures/codex/` pattern (Pi: `tool_call`, `tool_result`, `input`, `session_start`; opencode: `tool.execute.before`, `tool.execute.after`, `chat.message`, `event`).
- `src/tests/adapter.test.ts` — two new describe blocks (`PiAdapter`, `OpenCodeAdapter`) covering name, tool mapping incl. prefix match, envelope construction, `null` for unmapped tools.
- `src/tests/plugin-runtime.test.ts` (**new, highest value**) — with fake providers: allow/deny/ask `decisionTag` paths, orphan-span emission on block, `pendingGuardAttrs` set/drain/cleanup, `flushSessionTurn` idempotency and forced closure of pending spans.
- `src/tests/mcp-registry.test.ts` — opencode `mcp` key parsing (local `command[]`, remote `url`).
- Phase 0 opencode MCP prefix-matching cases, including ambiguous ones (server names that themselves contain underscores).

### 9.2 Regression guard (mandatory)

The `openclaw-plugin.ts` refactor must be **behaviour-neutral**. Procedure: capture a baseline from the existing OpenClaw tests before refactoring, compare item-by-item afterwards, and run `e2e-test/openclaw-trace-e2e-task.md` manually to confirm span shape is unchanged. This is the principal risk of the shared-runtime approach; the work does not merge without this step.

### 9.3 E2E task documents (new)

- `e2e-test/pi-trace-e2e-task.md`
- `e2e-test/opencode-trace-e2e-task.md`

Each covers: install → trigger one allow and one deny → inspect `audit.jsonl` → inspect the OTLP span tree shape → verify `/nio scan` and `/nio report`. The opencode document additionally **must** measure two things empirically: the actual presentation of the denial message to the model (§4.4), and that a tool that throws has its span reclaimed by `session.idle`.

All e2e work runs inside `NIO_HOME=$(mktemp -d)`; the real `~/.nio/config.yaml` is never touched (repo rule).

### 9.4 Acceptance criteria

- `pnpm run build` succeeds.
- `pnpm test` fully green.
- `pnpm typecheck` clean.
- Both new `setup.sh` scripts install idempotently and `--uninstall` removes cleanly.
- `/nio doctor` correctly reports install state on both platforms, including the "Pi has no MCP" note.

---

## 10. Installation and distribution

Both installers follow the Claude Code / Codex pattern: idempotent, prefer the platform's native registration mechanism, fall back to direct file writes when the CLI is unavailable, and support `--uninstall` / `--config` / `--reset-to-defaults`.

**Pi.** The release zip is itself a valid pi package (`package.json` with the `pi` manifest key and the `pi-package` keyword). `setup.sh` prefers `pi install "$SCRIPT_DIR"`, which registers the package in `~/.pi/agent/settings.json`. Without the `pi` CLI it copies the bundle to `~/.pi/agent/extensions/nio/` and appends the absolute path to the `extensions` array in `settings.json` — the documented settings form accepts an explicit file or directory path, which avoids depending on `index.js` auto-discovery (the documented auto-discovery table only names `*.ts` and `*/index.ts`).

**opencode.** opencode has no plugin-install CLI, so the installer uses the Codex-style nuke + copy: write `~/.config/opencode/plugins/nio.js`, `~/.config/opencode/skills/`, and `~/.config/opencode/commands/nio.md`. Plugin loading is confirmed by `config/plugin.ts`, which globs `{plugin,plugins}/*.{ts,js}` — both directory spellings work. An absolute path in the `plugin` array of `opencode.json` remains as a fallback.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| OpenClaw refactor regresses telemetry | Baseline capture + item-by-item comparison + manual e2e (§9.2). Non-negotiable gate |
| opencode denial message presents poorly | Measured in e2e before release; `permission.ask` available as a secondary path if the presentation is unusable |
| Any escaping exception becomes an opencode defect | 100% catch coverage in the opencode binding layer as a review gate (§4.4) |
| Pi confirm dialog stalls the agent | `timeout` option on every `ctx.ui.confirm` call |
| opencode MCP prefix matching is ambiguous | Two-tier parse (§7.4): longest-prefix match against registry server names, falling back to the existing Hermes convention of "full name as `local`, `server` unset"; explicit test cases for underscore-containing server names |
| Pi upstream API churn (young project) | Binding layer is type-only and thin; no runtime imports from Pi packages, so a bundle keeps working across minor Pi releases |
