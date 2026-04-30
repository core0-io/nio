# Nio Subagent Dispatch Hook Coverage Test

**IMPORTANT: Complete ALL steps below from start to finish in a single run. Do NOT stop to ask for confirmation between steps. Do NOT present "next steps" — just execute everything sequentially. At the end, summarise findings against the table in Step 4.**

## Goal

Verify which Claude Code hook events fire — and which Nio actually captures into `audit.jsonl` — when the main agent invokes the **Task tool** to dispatch a subagent. The events of interest here are `PreToolUse` / `PostToolUse` (with `tool_name="Agent"` — see naming-quirk note below) plus `SubagentStop`.

**Scope clarification** — this test does **not** cover `TaskCreated` / `TaskCompleted`. Per Claude Code's [Agent Teams docs](https://code.claude.com/docs/en/agent-teams), those two hook events fire only inside the experimental **Agent Teams** feature, when team members create or complete shared task-list items. They are unrelated to the regular Task tool subagent dispatch path that this file exercises. For an end-to-end test of `TaskCreated` / `TaskCompleted` capture, see [`hook-agent-team-e2e-task.md`](./hook-agent-team-e2e-task.md).

This is a **read-only / observational** test. Nio writes to `audit.jsonl` as part of normal operation; we just snapshot before / after and diff. No file is created or modified by the test itself outside `/tmp`.

## Prerequisites

1. **Nio plugin installed and active in this Claude Code session.** Verify with `cat ~/.claude/plugins/installed_plugins.json | grep -i nio` — should show an entry. If not present, abort with `"Nio prerequisites not met"`.
2. **The session was started AFTER the plugin was installed** — Claude Code snapshots hooks at session start. If you just installed Nio, you must restart this session before running the test.
3. **`audit.jsonl` exists.** Run `ls -la "${NIO_HOME:-$HOME/.nio}/audit.jsonl"` — should not error. If it doesn't exist, run any tool first (e.g. `Bash: ls`) to trigger Nio's collector and create the file, then continue.

If any prerequisite is missing, the agent must abort with the message `"Nio prerequisites not met — see Prerequisites section"` and do nothing else.

---

## Step 1 — Baseline snapshot

Capture the current end-of-file line count and timestamp so we can isolate entries the test produces.

```bash
AUDIT="${NIO_HOME:-$HOME/.nio}/audit.jsonl"
BEFORE_LINES=$(wc -l < "$AUDIT" 2>/dev/null | tr -d ' ')
SNAP_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p /tmp/nio-subagent-dispatch-test
echo "$BEFORE_LINES" > /tmp/nio-subagent-dispatch-test/baseline-lines.txt
echo "$SNAP_TS"      > /tmp/nio-subagent-dispatch-test/baseline-ts.txt
echo "audit:    $AUDIT"
echo "baseline: $BEFORE_LINES lines as of $SNAP_TS"
```

**Expected:** prints a line count (≥ 0) and an ISO timestamp. No errors.

**Actual:** *paste output*

---

## Step 2 — Invoke the Task tool

Dispatch a trivial subagent via the Task tool. Use these exact arguments so the run is deterministic and noise-free:

- **`subagent_type`**: `general-purpose`
- **`description`**: `subagent dispatch probe`
- **`prompt`**: `Reply with the single word "pong" and stop. Do nothing else. Do not call any tools.`

Wait for the subagent to return. The expected reply from the subagent is essentially `pong` (the wording may vary slightly).

**Expected:** Task tool returns successfully; subagent's text output is `pong` (or an obvious variant).

**Actual:** *paste subagent's reply*

---

## Step 3 — Diff audit.jsonl

Read all entries appended to `audit.jsonl` since the baseline and group them by `event` field.

```bash
AUDIT="${NIO_HOME:-$HOME/.nio}/audit.jsonl"
BEFORE=$(cat /tmp/nio-subagent-dispatch-test/baseline-lines.txt)
AFTER=$(wc -l < "$AUDIT" | tr -d ' ')
ADDED=$((AFTER - BEFORE))
echo "Lines added since baseline: $ADDED"
echo ""
echo "=== Event distribution (added entries only) ==="
tail -n +$((BEFORE + 1)) "$AUDIT" | python3 -c "
import sys, json, collections
c = collections.Counter()
for l in sys.stdin:
    if not l.strip(): continue
    try:
        r = json.loads(l)
        ev = r.get('event', '?')
        # 'guard' entries fire on every PreToolUse / PostToolUse — they
        # crowd out the hook-event signal we care about. Tag with the
        # tool_name to distinguish Task vs other tool calls.
        if ev == 'guard':
            ev = f'guard:{r.get(\"tool_name\", \"?\")}:{r.get(\"event_type\", \"?\")}'
        c.update([ev])
    except:
        pass
for ev, n in sorted(c.items()):
    print(f'  {ev:55s} {n}')
"
echo ""
echo "=== Task-related entries verbatim (Task/Agent tool name OR Task*/Subagent* events) ==="
# NOTE: Claude Code's hook payloads label the Task tool dispatch with
# tool_name='Agent' (an internal name), not 'Task' (the user-facing tool
# name). Both are matched here so the test catches either reporting.
tail -n +$((BEFORE + 1)) "$AUDIT" | python3 -c "
import sys, json
for l in sys.stdin:
    if not l.strip(): continue
    try:
        r = json.loads(l)
        ev = r.get('event', '')
        tn = r.get('tool_name', '') or ''
        if ev in ('TaskCreated', 'TaskCompleted', 'SubagentStop', 'SubagentStart') or tn in ('Task', 'Agent'):
            print(json.dumps(r, ensure_ascii=False))
    except:
        pass
"
```

**Expected:** at least one new entry per line of output above; the second block shows at minimum a PreToolUse + PostToolUse pair for `tool_name: "Agent"` (CC's internal name for the Task tool — see Notes) and a `SubagentStop` entry.

**Actual:** *paste output*

---

## Step 4 — Findings

Fill in the table from Step 3's output:

| Hook event | Documented? | Expected | Observed in this run |
|------------|-------------|----------|----------------------|
| `PreToolUse` for Task tool dispatch (`tool_name=Agent`) | Yes | ≥ 1 | ___ |
| `PostToolUse` for Task tool dispatch (`tool_name=Agent`) | Yes | ≥ 1 | ___ |
| `SubagentStop` | Yes | ≥ 1 | ___ |
| `SubagentStart` | Yes (CC docs) — but **not registered** in Nio's hooks.json today | 0 (not captured even if it fires) | ___ |
| `Stop` | Yes | 0–1 (only if main turn closed during the test) | ___ |

> **Naming quirk to be aware of:** Claude Code's user-facing tool name is `Task`, but in hook payloads `tool_name` is reported as `"Agent"`. The two `tool_name=Agent` rows above correspond to the single Task tool invocation from Step 2. If you see `tool_name="Task"` anywhere instead, that means CC has changed its hook payload naming — record the value verbatim so the test (and any downstream queries) can be updated.

> **Out of scope for this test:** `TaskCreated` and `TaskCompleted` are NOT expected from a regular Task tool dispatch. They fire only inside Agent Teams. If you do observe them here, that's a real CC behaviour change — record the entries verbatim and run [`hook-agent-team-e2e-task.md`](./hook-agent-team-e2e-task.md) to confirm the wiring works under that feature too.

---

## Verdict

- [ ] **PASS — Task tool subagent dispatch fully captured.** PreToolUse + PostToolUse for `tool_name=Agent` present, SubagentStop present. Nio's collector-hook is wired correctly for this scenario.
- [ ] **PARTIAL — only some expected hooks landed.** E.g. PreToolUse but no PostToolUse, or no SubagentStop. Report which ones are missing and which fired.
- [ ] **FAIL — zero new entries.** Nio's collector-hook is not receiving events at all. Check hook installation: `cat ~/.claude/plugins/installed_plugins.json | grep -i nio`, restart the session, re-run.
- [ ] **UNEXPECTED `TaskCreated` / `TaskCompleted` from regular Task tool dispatch.** Capture the entries verbatim — this contradicts the documented Agent-Teams-only scope of those events. File an issue against CC and update [`hook-agent-team-e2e-task.md`](./hook-agent-team-e2e-task.md) plus [COLLECTOR-SIGNALS.md](../docs/COLLECTOR-SIGNALS.md) accordingly.

---

## Notes

- **Naming quirk — `Task` vs `Agent`:** Claude Code's user-facing tool name is `Task`, but in hook payloads the `tool_name` field reports `"Agent"` (an internal name). Nio's metric label `tool_name=Agent` for `nio.tool_use.count{event=PreToolUse}` corresponds to a Task tool dispatch. See [docs/COLLECTOR-SIGNALS.md → Metrics](../docs/COLLECTOR-SIGNALS.md#metrics) for the full `tool_name` label semantics.
- **Why we use `general-purpose` subagent_type:** That's the universal-fallback subagent type. If the host doesn't have it, switch to whatever generic subagent your CC build offers (`Explore`, `Plan`, etc. — any will exercise the Task tool dispatch path).
- **This test is read-only.** It snapshots the current `audit.jsonl` line count, runs a Task tool call, and diffs new lines. It does not write to `~/.nio/`, `~/.zshrc`, or any sensitive path. Sandbox setup not required.
- **Sister test for the Agent Teams flow:** [`hook-agent-team-e2e-task.md`](./hook-agent-team-e2e-task.md) covers `TaskCreated` / `TaskCompleted` capture under CC's experimental Agent Teams feature, which is the **only** documented trigger for those two hook events.
- For the broader Nio e2e suite, see [`skill-e2e-task.md`](./skill-e2e-task.md) (skill subcommand smoke test), [`guard-e2e-task.md`](./guard-e2e-task.md) (runtime guard interception), and [`mcp-detection-e2e-task.md`](./mcp-detection-e2e-task.md) (Phase 0 MCP capture coverage).
