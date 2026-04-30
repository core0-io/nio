# Nio Agent Teams Task-Hook Coverage Test

**IMPORTANT: Complete ALL steps below from start to finish in a single run. Do NOT stop to ask for confirmation between steps. Do NOT present "next steps" — just execute everything sequentially. At the end, summarise findings against the table in Step 6.**

## Goal

Verify that Nio's collector-hook captures `TaskCreated` and `TaskCompleted` hook events into `audit.jsonl` when Claude Code's experimental **Agent Teams** feature creates and completes shared task-list items.

**Background** — Per [Claude Code's Agent Teams docs](https://code.claude.com/docs/en/agent-teams), `TaskCreated` and `TaskCompleted` hooks fire only inside Agent Teams (one team lead + multiple teammates coordinating through a shared task list). They do **not** fire from regular Task tool subagent dispatch — that is the scope of [`hook-subagent-e2e-task.md`](./hook-subagent-e2e-task.md). Nio registers handlers for both events in [hooks.json](../plugins/claude-code/hooks/hooks.json) but historical audit data shows zero fires on systems where Agent Teams hasn't been enabled — this test is the only way to actually exercise the path.

This test is **read-only / observational**. Nio writes to `audit.jsonl` as part of normal operation; we just snapshot before / after and diff.

## Prerequisites

1. **Claude Code v2.1.32 or later.** Verify with `claude --version`. If older, abort — Agent Teams isn't available.
2. **Agent Teams feature flag enabled.** Either of:
   - Environment: `export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` set in the shell that started this CC session
   - Settings: `~/.claude/settings.json` contains `{ "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }`

   If the flag isn't set, **abort and instruct the user to**:
   ```
   export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
   claude --teammate-mode in-process    # or omit for auto / default
   ```
   then re-run this task in the new session.
3. **Nio plugin installed and active in this session.** Verify with `cat ~/.claude/plugins/installed_plugins.json | grep -i nio` — should show an entry. Plugin install must have happened **before** this session started; CC snapshots hooks at session start.
4. **`audit.jsonl` exists.** Run `ls -la "${NIO_HOME:-$HOME/.nio}/audit.jsonl"`. If missing, run any tool first (e.g. `Bash: ls`) so Nio creates it.

If any prerequisite fails, abort with `"Agent Teams test prerequisites not met — see Prerequisites section"` and do nothing else.

---

## Step 1 — Verify Agent Teams flag is observed by THIS process

Don't assume the env var is set just because the user said it is — confirm in the actual CC process that's running this task.

```bash
echo "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-<unset>}"
```

**Expected:** prints `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. If it prints `<unset>` or `0`, abort per Prerequisites #2.

**Actual:** *paste output*

---

## Step 2 — Baseline snapshot

```bash
AUDIT="${NIO_HOME:-$HOME/.nio}/audit.jsonl"
BEFORE_LINES=$(wc -l < "$AUDIT" 2>/dev/null | tr -d ' ')
SNAP_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p /tmp/nio-agent-teams-test
echo "$BEFORE_LINES" > /tmp/nio-agent-teams-test/baseline-lines.txt
echo "$SNAP_TS"      > /tmp/nio-agent-teams-test/baseline-ts.txt
echo "audit:    $AUDIT"
echo "baseline: $BEFORE_LINES lines as of $SNAP_TS"
```

**Expected:** prints a line count (≥ 0) and an ISO timestamp.

**Actual:** *paste output*

---

## Step 3 — Spawn an Agent Team with a shared task list

Ask Claude (this session = the team lead) to create a small agent team and have it produce a few tasks. The exact natural-language prompt below is what *the user* would tell the agent — but we're already running inside the agent, so what we're really doing is having this agent *act on its own behalf* as the lead. Run this prompt mentally and then execute the team-creation steps:

> Create an agent team with **2 teammates** to investigate two trivial questions in parallel:
>
> - Teammate A: "What is `1 + 1`?"
> - Teammate B: "What is the capital of France?"
>
> Create one task per teammate in the shared task list, assign each task, let teammates self-claim and complete, then clean up the team.

Concretely, as the team lead you should:

1. Spawn 2 teammates (in-process mode is fine — no tmux required for this test). Name them `arith` and `geo`.
2. Create exactly **2 tasks** in the shared task list — one per teammate. Use trivial subjects so each task can complete in a single turn:
   - Subject: `Compute 1 + 1`, assigned to `arith`
   - Subject: `Name the capital of France`, assigned to `geo`
3. Wait for both teammates to complete their tasks. Each task should mark itself completed once its trivial answer is produced.
4. Clean up the team via `Clean up the team`.

**Why so trivial:** we want fast, deterministic completion so the test wraps in seconds. The point is to **fire the hooks**, not to do real research.

**Expected:** Both teammates spawn, both tasks get created, both get marked complete, team cleans up. The lead's terminal shows task-list state transitions.

**Actual:** *briefly describe what the lead did and what each teammate replied*

---

## Step 4 — Diff audit.jsonl

```bash
AUDIT="${NIO_HOME:-$HOME/.nio}/audit.jsonl"
BEFORE=$(cat /tmp/nio-agent-teams-test/baseline-lines.txt)
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
        if ev == 'guard':
            ev = f'guard:{r.get(\"tool_name\", \"?\")}:{r.get(\"event_type\", \"?\")}'
        c.update([ev])
    except:
        pass
for ev, n in sorted(c.items()):
    print(f'  {ev:55s} {n}')
"
echo ""
echo "=== TaskCreated / TaskCompleted entries verbatim ==="
tail -n +$((BEFORE + 1)) "$AUDIT" | python3 -c "
import sys, json
for l in sys.stdin:
    if not l.strip(): continue
    try:
        r = json.loads(l)
        if r.get('event') in ('TaskCreated', 'TaskCompleted'):
            print(json.dumps(r, ensure_ascii=False))
    except:
        pass
"
echo ""
echo "=== TeammateIdle entries verbatim (related Agent Teams hook) ==="
tail -n +$((BEFORE + 1)) "$AUDIT" | python3 -c "
import sys, json
for l in sys.stdin:
    if not l.strip(): continue
    try:
        r = json.loads(l)
        if r.get('event') == 'TeammateIdle':
            print(json.dumps(r, ensure_ascii=False))
    except:
        pass
"
```

**Expected:** the second block prints **at least 2 `TaskCreated` and 2 `TaskCompleted` entries** (one per task). The third block may print 1+ `TeammateIdle` entries (CC fires this when a teammate stops); Nio doesn't currently register `TeammateIdle` in hooks.json, so they may be absent — note for completeness.

**Actual:** *paste output*

---

## Step 5 — Inspect entry shape

For one observed `TaskCreated` and one `TaskCompleted`, verify the AuditHookEntry has the expected fields. Per Nio's [`AuditHookEntry`](../src/adapters/audit-types.ts) schema, the entry should include:

- `event: "TaskCreated"` (or `"TaskCompleted"`)
- `timestamp` (ISO-8601)
- `platform: "claude-code"`
- `session_id`
- `task_id`
- `task_summary` (for `TaskCreated`; the task's subject)

If a hand-pasted entry from Step 4 lacks one of these, that's an extraction bug worth filing.

**Actual:** *paste one TaskCreated and one TaskCompleted row from Step 4 and tick the fields present*

---

## Step 6 — Findings

| Hook event | Fired? | Captured by Nio? | Entry well-formed? |
|------------|--------|------------------|--------------------|
| `TaskCreated` (≥ 2 expected) | ___ | ___ | ___ |
| `TaskCompleted` (≥ 2 expected) | ___ | ___ | ___ |
| `TeammateIdle` (host fires, Nio doesn't register) | ___ (host fires?) | 0 (not registered — expected) | n/a |

---

## Verdict

- [ ] **PASS — Agent Teams hook capture confirmed.** ≥ 2 `TaskCreated` and ≥ 2 `TaskCompleted` entries in audit.jsonl, all with the expected fields. The dead-code question on Nio's TaskCreated/Completed handlers is finally settled — the path is live and works when Agent Teams is enabled.
- [ ] **PARTIAL — events fire but entries are malformed.** `TaskCreated`/`TaskCompleted` appear but missing `task_id` / `task_summary` / similar. File an issue against [`AuditHookEntry`](../src/adapters/audit-types.ts) — the event's stdin payload may have additional fields Nio's collector-core isn't extracting yet (e.g. `task_subject`, `task_description`, `teammate_name` per CC's binary). Capture the raw entries for diagnostic purposes.
- [ ] **FAIL — events don't fire.** Despite Agent Teams enabled and tasks created, no `TaskCreated` / `TaskCompleted` entries appeared. Possible causes: (a) the team-creation in Step 3 didn't actually use the Agent Teams machinery (lead handled tasks itself rather than spawning teammates), (b) CC's hook firing is broken under Agent Teams, (c) Nio's collector-hook isn't being invoked for these events. Check the lead's session output for evidence that teammates were really spawned and tasks were really claimed/completed.
- [ ] **NIO COLLECTOR FAULT.** Events fired (visible in CC's session output) but Nio's audit.jsonl shows nothing. Hook installation problem: re-verify `cat ~/.claude/plugins/installed_plugins.json` and that the session was started after install.

---

## Notes

- **Why this is gated on an env var:** Agent Teams is experimental in CC. Per docs: "Agent teams are experimental and **disabled by default**". Nio just listens for the hook events; it has no influence over whether CC fires them.
- **Where teams and tasks are stored on disk** (per CC docs):
  - Team config: `~/.claude/teams/{team-name}/config.json`
  - Task list: `~/.claude/tasks/{team-name}/`

  These are CC's, not Nio's — useful for forensic inspection if the test fails. Don't edit by hand.
- **`TeammateIdle` is also an Agent Teams hook event** but Nio's hooks.json doesn't register it today. If a future PR adds Phase-0 / observability for teammate idleness, register it alongside `TaskCreated`/`TaskCompleted` in [`plugins/claude-code/hooks/hooks.json`](../plugins/claude-code/hooks/hooks.json) and wire a corresponding `AuditHookEntry` variant.
- **The `task:execute` trace span** ([traces-collector.ts](../src/scripts/lib/traces-collector.ts) `recordPostTaskToolUse`) is the trace counterpart of this audit-log capture. After this test passes, look in your OTLP backend for spans named `task:execute` with `nio.task_id` matching one of the entries — that's the end-to-end coverage check across audit + trace signals.
- **Read-only test.** Snapshots `audit.jsonl` line count, exercises CC's Agent Teams feature, diffs new entries. Doesn't write to user-sensitive paths beyond `/tmp/nio-agent-teams-test/`. CC itself will write to `~/.claude/teams/` and `~/.claude/tasks/` — that's expected and how the feature works.
- **Sister test for the regular Task tool flow:** [`hook-subagent-e2e-task.md`](./hook-subagent-e2e-task.md). The two together fully cover Nio's hook event capture for both subagent-related code paths Claude Code exposes.
- For the broader Nio e2e suite, see [`skill-e2e-task.md`](./skill-e2e-task.md), [`guard-e2e-task.md`](./guard-e2e-task.md), and [`mcp-detection-e2e-task.md`](./mcp-detection-e2e-task.md).
