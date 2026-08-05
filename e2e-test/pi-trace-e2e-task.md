# Task: Pi guard + trace pipeline e2e

Must-pass e2e for the Nio→Pi integration: install, the three guard
verdicts (allow / deny / confirm), the audit-only `user_bash` path, the
`/nio` slash command, `/nio doctor`'s Pi MCP block, and teardown.

Pi is the **only** platform with a real interactive channel, so it is the
only place where a `confirm` verdict opens an actual dialog instead of
folding to `guard.confirm_action`. It is also the only in-process
platform with **no subagent concept**, so no `task:execute` spans are
expected — that absence is a pass, not a gap.

> **This e2e never touches `~/.nio/` or `~/.pi/`.** Every step runs
> against `NIO_HOME=$(mktemp -d)` and `--pi-home $(mktemp -d)`.
> `plugins/pi/setup.sh` exports `PI_CODING_AGENT_DIR="$PI_HOME"` before
> shelling out to the `pi` CLI precisely so `pi install` cannot write
> into your real agent dir — but **you** must export it too for every
> `pi` invocation below, otherwise the agent you start reads your real
> `~/.pi/agent/settings.json`. This is not hypothetical: a real
> `~/.pi/agent/settings.json` was written by a test run during
> development.

## Pre-flight

```bash
# 0. Repo root (adjust to your checkout)
cd /path/to/nio

# 1. Sandbox everything
export NIO_HOME="$(mktemp -d -t nio-pi-e2e-XXXXXX)"
export PI_HOME="$(mktemp -d -t pi-home-e2e-XXXXXX)"
export SANDBOX="$(mktemp -d -t nio-pi-scratch-XXXXXX)"
echo "NIO_HOME=$NIO_HOME"
echo "PI_HOME=$PI_HOME"
echo "SANDBOX=$SANDBOX"
```

## 1. Install

```bash
bash plugins/pi/setup.sh --pi-home "$PI_HOME"
cat "$PI_HOME/settings.json"
```

`setup.sh` has **two** registration paths and which one you get depends
only on whether the `pi` CLI is on PATH. Check the one that applies:

**A — `pi` on PATH (preferred path).** The release/plugin dir is itself a
valid pi package (`package.json` carries the `pi` manifest key and the
`pi-package` keyword), so `setup.sh` runs `pi install "$SCRIPT_DIR"` and
Pi records it under `packages`:

```json
{
  "packages": [
    "<relative-path-to>/plugins/pi"
  ]
}
```

Extensions and skills both come from the package manifest
(`pi.extensions` / `pi.skills`), so there is **no** `extensions` or
`skills` array in this shape. Expect **exactly one** nio entry.

**B — no `pi` CLI (fallback path).** `setup.sh` copies the bundle into
`$PI_HOME/extensions/nio/` and writes explicit absolute paths:

```json
{
  "extensions": ["<PI_HOME>/extensions/nio/index.js"],
  "skills": ["<PI_HOME>/skills"]
}
```

Expect **exactly one** `extensions` entry and **exactly one** `skills`
entry.

**Idempotency check (both shapes).** Re-run the same command and diff:

```bash
cp "$PI_HOME/settings.json" "$SANDBOX/settings.before.json"
bash plugins/pi/setup.sh --pi-home "$PI_HOME" >/dev/null
diff "$SANDBOX/settings.before.json" "$PI_HOME/settings.json" && echo "IDEMPOTENT OK"
```

No duplicate entries may appear. `settings_edit` strips our entries by
exact value before re-adding them, so a second run is a no-op.

## 2. Collector config

Point the sandbox config at the same local OTLP collector the other e2e
documents use. This also sets the two knobs the later steps need.

```bash
cat > "$NIO_HOME/config.yaml" <<'EOF'
agent_name: nio-pi-e2e
guard:
  protection_level: balanced
  confirm_action: allow
  action_guard_rules:
    # Deterministic, sandbox-local confirm trigger for step 5. Entries in
    # sensitive_commands produce a Phase 2 SENSITIVE_DATA_ACCESS finding
    # at severity `high`, which lands on `confirm` at protection_level
    # balanced (verified: final score 0.675). Using this instead of a real
    # sensitive path (~/.ssh/id_rsa) keeps the whole run inside the sandbox.
    sensitive_commands: ["nio-e2e-confirm-probe"]
collector:
  endpoint: http://localhost:4317
  protocol: grpc
  metrics: { enabled: true }
  traces:  { enabled: true }
  logs:    { enabled: true, local: true }
EOF
```

Nio builds the guard once at extension registration and never reloads
in-process — **every config edit below requires restarting `pi`.**

## 3. Start pi against the sandbox

```bash
PI_CODING_AGENT_DIR="$PI_HOME" NIO_HOME="$NIO_HOME" pi
```

Keep both env vars on **every** `pi` invocation in this document. Verify
the extension loaded before going further — `/nio` must be offered as a
command (it is registered via `pi.registerCommand`, not via the LLM).

## 4. Allow path

In the pi session, ask for a benign shell command:

```text
Run `date -u` using your bash tool. Do not use any other tool.
```

Verify the audit row:

```bash
python3 - <<PY
import json
rows = [json.loads(l) for l in open("$NIO_HOME/audit.jsonl") if l.strip()]
g = [r for r in rows if r.get("event") == "guard" and r.get("tool_name") == "bash"]
print("guard rows for bash:", len(g))
for r in g[-3:]:
    print(" decision=", r["decision"], "platform=", r["platform"],
          "action_type=", r.get("action_type"), "risk=", r.get("risk_level"))
PY
```

Expect at least one row with `decision: "allow"`, `platform: "pi"`,
`action_type: "exec_command"` (Pi's `bash` tool maps to `exec_command`
in the default `native_tool_mapping.pi`).

In your OTLP backend, filter:

```text
service.name = "nio-pi" AND gen_ai.agent.name = "nio-pi-e2e"
```

Expect one trace containing:

- 1 root span `invoke_agent UserPromptSubmit` (emitted at `agent_end`)
- 1 child span `execute_tool bash`, same `traceId` as the root, carrying:
  - `gen_ai.tool.name = "bash"`
  - `gen_ai.tool.call.id` — present (Pi supplies `toolCallId` on both
    `tool_call` and `tool_result`)
  - `nio.guard.decision = "allow"`
  - `nio.guard.eval_ms > 0`
  - `nio.platform = "pi"`
  - `status.code = OK`
- **No `task:execute` span.** Pi has no subagent concept; this is
  expected.

## 5. Deny path

Still inside the pi session:

```text
Run `rm -rf /` using your bash tool.
```

(Verified statically: `rm -rf /` fires `DANGEROUS_COMMAND` at severity
`critical`, final score 1.0, `phase_stopped: 2` → `deny`. It never runs —
the `tool_call` handler returns `{ block: true, reason }` before Pi
executes anything.)

Confirm three things:

1. **Pi reports the block.** The tool result surfaces the Nio reason
   text; the session continues and the model can respond normally.
2. **Audit row.**

```bash
python3 - <<PY
import json
rows = [json.loads(l) for l in open("$NIO_HOME/audit.jsonl") if l.strip()]
d = [r for r in rows if r.get("event") == "guard" and r.get("decision") == "deny"]
print("deny rows:", len(d))
if d:
    r = d[-1]
    print(" platform=", r["platform"], "tool=", r["tool_name"],
          "risk_tags=", r.get("risk_tags"), "phase_stopped=", r.get("phase_stopped"))
PY
```

Expect `decision: "deny"`, `platform: "pi"`, `risk_tags` containing
`DANGEROUS_COMMAND`.

3. **Orphan span.** `tool_result` never fires for a blocked call, so the
   span cannot be closed by the post-side. `InProcessPluginRuntime`
   compensates: the block path calls `safeCloseSpan` synchronously with
   the guard attrs. In the backend, expect an `execute_tool bash` span
   with:
   - `nio.guard.decision = "deny"`
   - `status.code = ERROR` and a recorded exception carrying the reason
   - `nio.guard.eval_ms` set (there is no `nio.tool.duration_ms` — the
     tool never ran)

## 6. Confirm path

### 6a. Interactive — answer "no"

Switch the confirm policy to `ask` and restart pi:

```bash
python3 - <<'PY'
import os, re
p = os.path.join(os.environ["NIO_HOME"], "config.yaml")
s = open(p).read().replace("confirm_action: allow", "confirm_action: ask", 1)
open(p, "w").write(s)
PY
grep -n "confirm_action" "$NIO_HOME/config.yaml"

PI_CODING_AGENT_DIR="$PI_HOME" NIO_HOME="$NIO_HOME" pi
```

Then, in the session:

```text
Run `echo nio-e2e-confirm-probe` using your bash tool.
```

Expect a **real dialog** — `ctx.ui.confirm("Nio: confirm this action?", …)`
with a 60 s timeout (`CONFIRM_TIMEOUT_MS` in `src/adapters/pi-plugin.ts`).
Pi's `confirm()` returns `false` on timeout, so an unanswered dialog reads
as a refusal rather than hanging the agent.

**Answer no.** Verify:

- the command does not run;
- the tool span carries `nio.guard.decision = "confirm_denied"` with
  `status.code = ERROR` (`resolveConfirm` overwrites the provisional
  attrs and closes the span itself);
- the guard audit row for this call records the pre-side decision `ask`.

### 6b. Print mode — no UI, no hang

```bash
cd "$SANDBOX"
PI_CODING_AGENT_DIR="$PI_HOME" NIO_HOME="$NIO_HOME" \
  pi -p "Run \`echo nio-e2e-confirm-probe\` using your bash tool."
```

`pi -p` is non-interactive, so `ctx.hasUI === false`. The binding must
**not** open a dialog and must **not** block: it calls
`resolveConfirm(..., true)` and lets the call through, exactly like the
two-state fold every other platform uses.

Expect: the command runs, the process exits without prompting, and the
span carries `nio.guard.decision = "confirm_allowed"`.

Restore `confirm_action: allow` before continuing:

```bash
python3 - <<'PY'
import os
p = os.path.join(os.environ["NIO_HOME"], "config.yaml")
s = open(p).read().replace("confirm_action: ask", "confirm_action: allow", 1)
open(p, "w").write(s)
PY
```

## 7. `user_bash` — audit only, never blocked

Nio guards *agent* actions, not human keystrokes. Pi's `user_bash` event
fires when the user types a `!`-prefixed command; the handler returns
`undefined`, which leaves Pi's own bash backend in charge.

Start an interactive pi session and type (substitute the **real**
`$SANDBOX` value printed in pre-flight — do not type a path outside the
sandbox):

```text
!rm -rf <SANDBOX>/nio-e2e-nonexistent
```

Verify:

```bash
python3 - <<PY
import json
rows = [json.loads(l) for l in open("$NIO_HOME/audit.jsonl") if l.strip()]
ub = [r for r in rows
      if r.get("event") == "lifecycle" and r.get("lifecycle_type") == "user_bash"]
print("user_bash rows:", len(ub))
if ub:
    r = ub[-1]
    print(" platform=", r["platform"], "details=", r.get("details"))
PY
```

Expect exactly one new row:

- `event: "lifecycle"`
- `lifecycle_type: "user_bash"`
- `platform: "pi"`
- `details.actor: "user"` (`actor` lives inside `details`, alongside
  `command` and `cwd`)

**And critically: the command was NOT blocked.** There must be no
`event: "guard"` row for it — `user_bash` never runs Phase 0–6. If a
guard row appears, or pi refuses the command, that is a failure.

## 8. `/nio` slash command (bypasses the LLM)

In the pi session:

```text
/nio scan src
```

```text
/nio report
```

Verify:

- output renders (routed through `ctx.ui.notify`, falling back to
  `console.log`);
- **no assistant message is generated for the command itself.** `/nio` is
  registered through `pi.registerCommand`, so the dispatch never reaches
  the model. If you see the model narrating what it is about to do, or a
  `bash` tool call running `node .../action-cli.js`, the command route
  regressed to the skill/LLM fallback.
- `/nio report` reads `$NIO_HOME/audit.jsonl` and shows the rows from
  steps 4–7.

## 9. `/nio doctor` and MCP

```text
/nio doctor
```

Under **### Platform Integrations**, the Pi block prints the install line
plus an MCP note whose shape depends on whether an MCP adapter is present
(`src/adapters/openclaw-dispatch.ts` — the shared doctor implementation,
despite its name).

**No MCP adapter registered** — a neutral three-line note, and nothing
that reads as a recommendation to install one:

```text
- ✓ pi: extension registered
    note: Pi core has no MCP, and Nio does not need one. If you add a third-party MCP
          adapter, Nio detects it and gates those calls via permitted_tools.mcp /
          blocked_tools.mcp — re-run /nio doctor then for the naming details.
```

**`pi-mcp-adapter` registered in the sandbox's `settings.json`** — the
four detail lines appear, because only now are they actionable:

```text
- ✓ pi: extension registered
    note: pi-mcp-adapter detected — MCP calls are gated via permitted_tools.mcp / blocked_tools.mcp.
    MCP names: proxy tool `mcp`, or direct tools `<server>_<tool>` / `mcp__<server>_<tool>`.
    Servers are read from $PI_CODING_AGENT_DIR/mcp.json (else ~/.pi/agent/mcp.json).
    Caveat: pi-mcp-adapter `toolPrefix: "none"` emits bare tool names Nio cannot identify as MCP.
```

Verify the branch that matches your machine. Nio never installs, requires,
or checks for an MCP adapter as a prerequisite — if the no-adapter branch
names a package to install, that is a defect.

> Note the doctor probes the **real** `~/.pi/agent` (it derives paths
> from `$HOME`), so the install line reflects your real install state,
> not the sandbox. Read the MCP block, not the ✓/·, as the thing under
> test here.

### 9b. MCP allow/deny leg — only if `pi-mcp-adapter` is installed

Skip this leg if the sandbox has no `pi-mcp-adapter`. Otherwise:

```bash
# Add an MCP denylist entry for the target tool, by its LOCAL name.
python3 - <<'PY'
import os
p = os.path.join(os.environ["NIO_HOME"], "config.yaml")
s = open(p).read().replace(
    "  action_guard_rules:",
    "  blocked_tools:\n    mcp: [\"<target-tool-name>\"]\n  action_guard_rules:", 1)
open(p, "w").write(s)
PY
```

Restart pi, then drive the adapter's proxy tool so it calls
`<target-tool-name>`. The proxy tool is literally named `mcp` and carries
its target in the `tool` parameter (and optionally the server in
`server`), so `parseMcpToolName`'s `pi` branch reads `toolInput` to
resolve it.

Expect the audit row to show:

- `decision: "deny"`
- `tool_name: "mcp"` with the **MCP** tool identity resolved — the row
  must **not** carry a `UNCATEGORIZED_TOOL:` risk tag. An
  `UNCATEGORIZED_TOOL:mcp` pass-through means the `pi` branch failed to
  resolve the target and the call sailed through un-analysed.

If the adapter is configured with `directTools: true`, the same check
applies to the flattened name (`<server>_<tool>` or
`mcp__<server>_<tool>`), matched against servers read from
`$PI_CODING_AGENT_DIR/mcp.json`.

**Known, by-design gap:** with `toolPrefix: "none"` the adapter emits
bare tool names that are byte-identical to native tool calls. Nio does
not guess, so those calls stay uncategorised. Do not file that as a bug.

## 10. Teardown

`--uninstall` deletes `$NIO_DIR` (i.e. `$NIO_HOME`) as well as the Pi
entries, so copy anything you still want out first.

```bash
cp "$NIO_HOME/audit.jsonl" "$SANDBOX/audit.jsonl" 2>/dev/null || true

bash plugins/pi/setup.sh --pi-home "$PI_HOME" --uninstall

# settings.json must have no nio entries left.
cat "$PI_HOME/settings.json"
```

Expect `{}` (fallback path — both arrays were emptied and then deleted)
or `{"packages": []}` (pi-CLI path). Either way: **no nio entry**.

```bash
# Nothing of ours left on disk
ls -a "$PI_HOME/extensions" 2>/dev/null
ls -a "$PI_HOME/skills" 2>/dev/null

# Wipe the sandboxes
rm -rf "$NIO_HOME" "$PI_HOME" "$SANDBOX"
unset NIO_HOME PI_HOME SANDBOX

# Your real Pi install is untouched — confirm it still lists what it did before
cat ~/.pi/agent/settings.json
```

## What this catches (regression coverage)

- The pi bundle loads as an ESM extension inside pi (`plugins/pi/` has a
  real `package.json` declaring `"type": "module"` — the pi package
  manifest — so no ESM sentinel is written)
- Both install shapes register exactly once and uninstall cleanly
- `tool_call` blocking actually stops execution (`{ block: true }`)
- Orphan-span compensation on the block path (no `tool_result` fires)
- Interactive confirm reaches `ctx.ui.confirm` and its refusal survives —
  `denial` is captured outside the try in `pi-plugin.ts` on purpose, so a
  telemetry throw cannot turn a refusal into a green light
- Print mode (`hasUI === false`) folds to two-state without hanging
- `user_bash` is audit-only and never gated
- `/nio` bypasses the LLM via `pi.registerCommand`
- The Pi MCP doctor block stays accurate (Task 11b)
- Turn-span parenting from `tool_call` / `tool_result` / `input` /
  `message_end` into the `invoke_agent` root at `agent_end`
