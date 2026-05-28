---
"@core0-io/nio": patch
---

**Deny-path trace span emission + allow-path guard-attrs parity across platforms.**

Before this change, when the guard blocked a tool call (`risk_score=1`, any deny threshold crossed, or tool-gate hit), the audit log and `nio.decision.count` metric captured the verdict — but **no `execute_tool` span ever reached OTLP traces**. Reason: spans were opened in `PreToolUse` and closed in `PostToolUse`; on deny, `PostToolUse` never fires, so the span sat orphaned in the state file. Trace UIs were silently missing exactly the events most worth investigating.

OpenClaw already handled this correctly via its in-memory `pendingGuardAttrs` bridge; this change brings claude-code, codex, and hermes to parity, and adds three new attributes everywhere.

**What changes on a deny / confirm-denied call:**

```text
Trace span: execute_tool Bash       ← same name as allow; discrimination via attrs + status
  status:       ERROR                 (reason in span.exception message)
  start / end:  real evalStartMs → end-of-guard       (not a ~0ms synthesized span)
  attributes:
    gen_ai.tool.name              = "Bash"
    gen_ai.tool.call.id           = "<tool_use_id>"
    gen_ai.tool.call.arguments    = redacted JSON
    nio.tool_summary              = "rm -rf /"
    nio.platform / nio.turn_number / nio.cwd
    nio.guard.decision            = "deny"
    nio.guard.risk_level          = "critical"
    nio.guard.risk_score          = 1
    nio.guard.risk_tags           = "BASH_RMRF"
    nio.guard.phase_stopped       = 2          ← new
    nio.guard.top_finding_rule    = "BASH_RMRF" ← new
    nio.guard.eval_ms             = 47          ← new
```

**Allow spans now carry the same `nio.guard.*` set** (decision = `allow` / `confirm_allowed`). Previously this was OpenClaw-only — claude-code, codex, and hermes recorded the guard decision in metrics + audit log but never on the tool span itself, so trace UIs couldn't filter "all high-risk allow calls." Now they can.

**Cross-process plumbing.** Claude Code and Codex run guard-hook (PreToolUse, sync) and collector-hook (PostToolUse, separate process); they can't share an in-memory map. A new `pending_guard_attrs` field on `CollectorState` bridges via the existing on-disk state file: guard-hook parks the attrs on every decision, collector-hook PostToolUse drains and merges them into the closing span. Hermes runs as a single dispatcher and openclaw as an in-process daemon, so they use simpler in-process paths.

**New API surface (internal):**

- `HookOutput`: optional `phaseStopped?: number` + `topFindingRule?: string`. Plumbed from `ActionDecision` through `runtimeDecisionToHookOutput` for runtime denies (`phase_stopped` = 1–6) and from the early tool-gate path with `phase_stopped: 0`.
- `nioGuardAttributes(decision, riskLevel, riskScore, riskTags?, phaseStopped?, topFindingRule?)`: two new optional params; backwards-compatible.
- `recordPreToolUse(state, key, name, summary, attrs?, startMs?)`: optional `startMs` override so deny-path emission stamps the real eval-start time onto the span.
- `setPendingGuardAttrs` / `takePendingGuardAttrs`: new helper pair on `traces-collector` for the disk-backed bridge between separate hook processes.
- `CollectorState.pending_guard_attrs?: Record<spanKey, Record<string, unknown>>`: new state-file field; reset by `ensureTurn` / `endTurn` alongside `pending_spans`.

**Span name decision.** `execute_tool <toolName>` for both allow and deny, matching gen_ai semantic conventions. Filtering allow vs deny is via `nio.guard.decision` + span status — not via name suffix — so the same span name aggregates across attempts of the same tool.

**Genuinely missing from a deny span** (acceptable — the tool didn't run):

- `gen_ai.tool.call.result` (no output)
- `nio.tool.duration_ms` (no tool execution wall-clock — replaced by `nio.guard.eval_ms` which measures the guard evaluation window instead)

**Tests added (14, full suite 1093/1093 green):**

- `nioGuardAttributes` extended cases (`phase_stopped` = 0/non-zero/undefined, `top_finding_rule`)
- `recordPreToolUse` honours caller-supplied `startMs` + falls back to `Date.now()` when omitted
- `setPendingGuardAttrs` / `takePendingGuardAttrs` lifecycle (set / take / preserve siblings / drain on absent key / no mutation of input state)
- `ensureTurn` resets `pending_guard_attrs` on new turn
- collector-core PostToolUse drains `pending_guard_attrs` and merges them into the closing span (end-to-end with `InMemorySpanExporter`)
- Deny-path one-shot span emit produces ERROR status + full deny attribute set + real wall-clock from `evalStartMs` (end-to-end)
- Smoke regression: guard-hook deny path doesn't crash when no collector is configured (tracerProvider/loggerProvider stay null)

**Docs updated:**

- `docs/COLLECTOR-SIGNALS.md`: `nio.guard.*` attribute rows flipped from "OpenClaw only" to "all"; new attribute rows added; deleted the "Claude Code adoption queued as follow-up" note; new paragraph documenting the deny / confirm-denied synchronous emission contract.
- `docs/ARCHITECTURE.md`: Claude Code box updated to show guard-hook's new TracerProvider responsibilities (synchronous deny-span emission + `pending_guard_attrs` bridge to collector-hook).

**Files touched:**

- `src/adapters/types.ts`, `src/adapters/hook-engine.ts` — HookOutput extension + plumbing
- `src/scripts/lib/traces-collector.ts` — `nioGuardAttributes` signature, `recordPreToolUse` `startMs` param, `setPendingGuardAttrs` / `takePendingGuardAttrs` helpers
- `src/scripts/lib/traces-state-store.ts` — `pending_guard_attrs` field + ensureTurn / endTurn reset
- `src/scripts/lib/collector-core.ts` — PostToolUse handler drains the bridge
- `src/scripts/guard-hook.ts` — tracerProvider setup + deny-emit + per-decision bridge write
- `src/scripts/hook-cli.ts` — hermes pre_tool_call: time eval, set bridge, deny-emit
- `src/adapters/openclaw-plugin.ts` — time eval, pass new fields, add `nio.guard.eval_ms`
