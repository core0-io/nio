# Task: opencode guard + trace pipeline e2e

Must-pass e2e for the Nio→opencode integration: install, the allow and
deny guard paths, the `/nio` command, `/nio doctor`, teardown — **plus
two mandatory empirical measurements** that cannot be determined by
reading the source.

> ## ⚠ STATUS: NOT YET PASSED — two measurements are unfilled
>
> Sections **§7 Denial presentation** and **§8 Span reclamation on tool
> error** each end in a `> **RESULT …: _not yet measured_**` placeholder.
> They are written as procedures, not as observations. **This document is
> not considered passed until a human has run those two sections against
> a live opencode and replaced both placeholders with what was actually
> observed.** Do not fill them in from reasoning about the code — the
> whole reason they exist is that the code does not answer them:
> opencode invokes plugin hooks through
> `Effect.promise(async () => fn(input, output))`
> (`packages/opencode/src/plugin/index.ts`), which converts a rejection
> into an Effect *defect*, and how a defect is surfaced to the model and
> to the user is a runtime property of opencode's session loop.

> **This e2e never touches `~/.nio/` or your real opencode config dir.**
> Every step runs against `NIO_HOME=$(mktemp -d)` and
> `--opencode-home <sandbox>`.

## Pre-flight

```bash
# 0. Repo root (adjust to your checkout)
cd /path/to/nio

# 1. Sandbox everything.
#    plugins/opencode/setup.sh resolves its target as:
#      --opencode-home  >  $XDG_CONFIG_HOME/opencode  >  $HOME/.config/opencode
#    We pass --opencode-home explicitly AND set XDG_CONFIG_HOME to the same
#    parent, so the opencode binary we start later reads the same tree.
export NIO_HOME="$(mktemp -d -t nio-oc-e2e-XXXXXX)"
export XDG_CONFIG_HOME="$(mktemp -d -t oc-xdg-e2e-XXXXXX)"
export OC_HOME="$XDG_CONFIG_HOME/opencode"
export SANDBOX="$(mktemp -d -t nio-oc-scratch-XXXXXX)"
echo "NIO_HOME=$NIO_HOME"
echo "OC_HOME=$OC_HOME"
echo "SANDBOX=$SANDBOX"
```

> **Sandbox gate — do not skip.** After §3 you must confirm opencode
> actually loaded the plugin from `$OC_HOME`. If your opencode build
> ignores `XDG_CONFIG_HOME`, **stop**. Do **not** fall back to installing
> into your real `~/.config/opencode`. Use a throwaway `HOME` instead
> (`export HOME="$(mktemp -d)"`, re-export the vars above, and supply
> your provider key through the environment), or run the whole document
> in a container.

## 1. Install

```bash
bash plugins/opencode/setup.sh --opencode-home "$OC_HOME"
find "$OC_HOME" -maxdepth 2 | sort
```

Expect exactly:

```text
$OC_HOME/commands/nio.md
$OC_HOME/plugins/.nio-esm-sentinel
$OC_HOME/plugins/nio.js
$OC_HOME/plugins/package.json
$OC_HOME/skills/nio
$OC_HOME/skills/nio-action
$OC_HOME/skills/nio-config
$OC_HOME/skills/nio-doctor
$OC_HOME/skills/nio-external-score
$OC_HOME/skills/nio-report
$OC_HOME/skills/nio-scan
```

### The ESM sentinel is scoped and owned

`$OC_HOME/plugins/` is opencode's **shared** plugin directory, not Nio's.
Writing `{"type": "module"}` there would flip any sibling CJS plugin that
has no `package.json` of its own, and the breakage would outlive
uninstalling Nio. So `setup.sh` writes the sentinel **only** when both
hold:

- the directory contains no sibling plugin (`*.js` / `*.ts` other than
  `nio.js`), and
- no `package.json` already exists there.

When it writes one it also drops `.nio-esm-sentinel` as an ownership
marker; `--uninstall` removes `package.json` **only** when that marker is
present, so a `package.json` Nio did not write is never touched.

Verify both branches:

```bash
# Branch A — clean dir: sentinel written + marker present (checked above)
cat "$OC_HOME/plugins/package.json"        # → {"type": "module"}
ls -a "$OC_HOME/plugins"                   # → .nio-esm-sentinel present

# Branch B — sibling plugin present: sentinel SKIPPED with a warning
OC_HOME_B="$(mktemp -d)/opencode"
mkdir -p "$OC_HOME_B/plugins"
: > "$OC_HOME_B/plugins/some-other-plugin.js"
bash plugins/opencode/setup.sh --opencode-home "$OC_HOME_B" | grep -A3 "WARN"
ls "$OC_HOME_B/plugins"                    # → no package.json, no .nio-esm-sentinel
```

Branch B must print the warning telling the user to declare ESM
themselves, and must leave the directory's module format alone.

**Idempotency check:**

```bash
find "$OC_HOME" | sort > "$SANDBOX/oc.before.txt"
bash plugins/opencode/setup.sh --opencode-home "$OC_HOME" >/dev/null
find "$OC_HOME" | sort > "$SANDBOX/oc.after.txt"
diff "$SANDBOX/oc.before.txt" "$SANDBOX/oc.after.txt" && echo "IDEMPOTENT OK"
```

## 2. Collector config

```bash
cat > "$NIO_HOME/config.yaml" <<'EOF'
agent_name: nio-opencode-e2e
guard:
  protection_level: balanced
  confirm_action: allow
collector:
  endpoint: http://localhost:4317
  protocol: grpc
  metrics: { enabled: true }
  traces:  { enabled: true }
  logs:    { enabled: true, local: true }
EOF
```

Nio builds the guard once when the plugin factory runs and never reloads
in-process — **restart opencode after every config edit.**

## 3. Start opencode against the sandbox

```bash
cd "$SANDBOX"
XDG_CONFIG_HOME="$XDG_CONFIG_HOME" NIO_HOME="$NIO_HOME" opencode
```

**Sandbox gate.** Confirm the plugin loaded from `$OC_HOME` before going
any further — `/nio` must be offered as a command and `nio_command` must
be a registered tool. If it is not, re-read the pre-flight warning; do
not install into your real config dir.

## 4. Allow path

```text
Run `date -u` using your bash tool. Do not use any other tool.
```

```bash
python3 - <<PY
import json
rows = [json.loads(l) for l in open("$NIO_HOME/audit.jsonl") if l.strip()]
g = [r for r in rows if r.get("event") == "guard" and r.get("tool_name") == "bash"]
print("guard rows for bash:", len(g))
for r in g[-3:]:
    print(" decision=", r["decision"], "platform=", r["platform"],
          "action_type=", r.get("action_type"))
PY
```

Expect `decision: "allow"`, `platform: "opencode"`,
`action_type: "exec_command"`.

In the backend, filter:

```text
service.name = "nio-opencode" AND gen_ai.agent.name = "nio-opencode-e2e"
```

Expect a root `invoke_agent UserPromptSubmit` span (emitted when
`session.idle` fires) with an `execute_tool bash` child sharing its
`traceId` and carrying:

- `gen_ai.tool.name = "bash"`
- `gen_ai.tool.call.id` — opencode's `callID`, present on both
  `tool.execute.before` and `tool.execute.after`
- `nio.guard.decision = "allow"`
- `nio.guard.eval_ms > 0`
- `nio.platform = "opencode"`
- `status.code = OK`

## 5. Deny path

```text
Run `rm -rf /` using your bash tool.
```

(Verified statically: `rm -rf /` fires `DANGEROUS_COMMAND` at severity
`critical`, final score 1.0, `phase_stopped: 2` → `deny`.)

```bash
python3 - <<PY
import json
rows = [json.loads(l) for l in open("$NIO_HOME/audit.jsonl") if l.strip()]
d = [r for r in rows if r.get("event") == "guard" and r.get("decision") == "deny"]
print("deny rows:", len(d))
if d:
    r = d[-1]
    print(" platform=", r["platform"], "tool=", r["tool_name"],
          "risk_tags=", r.get("risk_tags"))
PY
```

Expect `decision: "deny"`, `platform: "opencode"`, `risk_tags`
containing `DANGEROUS_COMMAND`.

The block works by **throwing `NioBlockedError` from
`tool.execute.before`** — opencode's `session/tools.ts` fires that hook
ahead of `item.execute`, so the throw prevents execution entirely.
`tool.execute.after` therefore never fires for this call, and the span is
closed synchronously on the block path (`safeCloseSpan`) with
`nio.guard.decision = "deny"` and `status.code = ERROR`.

Then measure §7 below on this same denial.

## 6. `/nio` command and `/nio doctor`

```text
/nio scan src
```

```text
/nio report
```

```text
/nio doctor
```

opencode has **no plugin API for slash commands**, so `/nio` is a
`commands/nio.md` template that instructs the model to call the
plugin-registered `nio_command` tool with the raw argument string. Unlike
Pi, this route **does** go through the model — that is expected here.

Verify:

- the model calls `nio_command` (not a `bash` invocation of
  `action-cli.js`);
- the tool output is shown as-is, not summarised — `commands/nio.md`
  explicitly instructs that;
- `/nio report` shows the rows written in §4–§5;
- `/nio doctor` prints, under **### Platform Integrations**:

```text
- ✓ opencode: plugin + /nio command installed
```

A `- ~ opencode: partial install (plugin: …, command: …)` line means one
of the two files is missing; `- ·` means neither is.

> The doctor derives its opencode path from `$XDG_CONFIG_HOME` (falling
> back to `$HOME/.config`), so with the sandbox `XDG_CONFIG_HOME`
> exported it reports the **sandbox** install state.

---

## 7. MANDATORY MEASUREMENT — denial presentation

**Why this must be measured, not reasoned about.** `NioBlockedError` is
thrown from an async hook that opencode wraps in
`Effect.promise(async () => fn(input, output))`. Effect converts a
rejected promise into a *defect* rather than a typed error, and what a
defect looks like by the time it reaches the model's tool-result channel
and the user's terminal is a property of opencode's session loop, not of
Nio's code. Reading `opencode-plugin.ts` cannot answer it.

### Procedure

1. Start opencode as in §3 with a **fresh** session.
2. Trigger the deny from §5 (`rm -rf /` via `bash`).
3. Capture, verbatim, all three of:
   - **What the user sees in the terminal.** Copy the exact rendered
     text, including any prefix/label opencode puts on it.
   - **What the model receives as the tool result.** Read it from
     opencode's session storage rather than inferring it from the
     model's next message. The session records live under the opencode
     data dir; locate the newest session and dump the tool part:
     ```bash
     # Find the newest session file written during this run and print the
     # tool result part for the blocked call.
     find "${XDG_DATA_HOME:-$HOME/.local/share}/opencode" -name '*.json' \
       -newermt '-10 minutes' 2>/dev/null | sort | tail -20
     ```
     If your build stores sessions elsewhere, use whatever
     `opencode` exposes to export the transcript. Failing that, ask the
     model in the same turn to repeat the tool error text verbatim.
   - **Whether the session continues normally** — i.e. the model can
     send another message and call another tool afterwards, and opencode
     does not terminate the session or enter an error state.
4. Answer these four questions explicitly:
   - **Q1.** Does the Nio reason text (`"Dangerous command pattern
     detected: rm -rf"` / whatever `r.reason` carried) survive to the
     model verbatim, in part, or not at all?
   - **Q2.** Is it labelled as a *tool error* (vs. an unhandled crash, a
     generic "plugin error", or a silent empty result)?
   - **Q3.** Is the `NioBlockedError` name preserved anywhere in the
     surfaced text?
   - **Q4.** Does the session continue normally afterwards?

### Result

Paste the verbatim terminal output and the verbatim tool-result text
here, then answer Q1–Q4.

> **RESULT (to be filled in by the human running this document): _not yet measured_**

**If the presentation is unusable** — reason text lost, or surfaced as an
opaque crash, or the session dies — record that here as an explicit
follow-up rather than softening it. An unusable denial message is a real
product defect on this platform and must be filed, not papered over.

---

## 8. MANDATORY MEASUREMENT — span reclamation when a tool throws

**Why this must be measured.** opencode skips `tool.execute.after` when
the tool itself throws. The pending span for that call would then leak.
`opencode-plugin.ts` relies on the `session.idle` event as the safety
net: its handler calls `rt.onTurnEnd(sessionId)`, and
`flushSessionTurn` force-closes any leftover pending tool spans before
emitting the turn root. Whether opencode really fires `session.idle`
after a thrown tool — and whether it does so before the process can be
torn down — is a runtime property.

### Procedure

1. Fresh opencode session (§3), fresh audit log position:
   ```bash
   wc -l "$NIO_HOME/audit.jsonl"   # note the line count
   ```
2. Make a tool fail **on its own**, not via the Nio guard. The command
   must be one Nio allows (so `tool.execute.before` returns cleanly) and
   that opencode surfaces as a *thrown* tool error rather than a normal
   non-zero exit captured as output. Try, in order, until one produces a
   thrown tool error:
   ```text
   Run `<SANDBOX>/definitely-not-an-executable` using your bash tool.
   ```
   ```text
   Read the file `<SANDBOX>/no-such-file-at-all.txt` using your read tool.
   ```
   (Substitute the real `$SANDBOX` value. Both targets are inside the
   sandbox and do not exist.)

   Record which one actually threw — that matters for reproducing this.
3. Confirm `tool.execute.after` did **not** fire. The clean signal is
   telemetry, not logs: an `execute_tool` span that was closed by
   `onPostTool` carries `gen_ai.tool.call.result` (from
   `genAiToolCallOutputAttributes`); one reclaimed at `session.idle` by
   `flushSessionTurn` does not. Check the span in your backend for the
   presence/absence of `gen_ai.tool.call.result`.

   If you want a direct signal, temporarily add a `console.error` at the
   top of the `tool.execute.after` handler in
   `$OC_HOME/plugins/nio.js` (the sandbox copy — never the repo source)
   and watch stderr.
4. Let the turn finish so `session.idle` fires (the model replies and
   stops).
5. Confirm the pending span **was** closed:
   - the `execute_tool <name>` span exists in the backend,
   - it is a child of the `invoke_agent UserPromptSubmit` root and shares
     its `traceId`,
   - it is not left open / dropped.

### Result

Record: which command threw; whether `tool.execute.after` fired; whether
the span was present and closed after `session.idle`; and the span's
`gen_ai.tool.call.result` presence (the discriminator between a normal
close and a reclaimed one).

> **RESULT (to be filled in by the human running this document): _not yet measured_**

---

## 9. Teardown

`--uninstall` deletes `$NIO_DIR` (i.e. `$NIO_HOME`) along with the
opencode files, so copy anything you still want out first.

```bash
cp "$NIO_HOME/audit.jsonl" "$SANDBOX/audit.jsonl" 2>/dev/null || true

bash plugins/opencode/setup.sh --opencode-home "$OC_HOME" --uninstall

# Nothing of ours left
find "$OC_HOME" | sort
```

Expect only the (now empty) `commands/`, `plugins/`, `skills/`
directories — no `nio.js`, no `nio.md`, no `nio*` skill dirs, and **no
`package.json` / `.nio-esm-sentinel`** (removed because the marker was
present).

Re-run teardown against the **branch B** dir from §1 and confirm the
opposite: the sibling plugin's directory keeps whatever module format it
had, because Nio never wrote a `package.json` there and the marker is
absent.

```bash
bash plugins/opencode/setup.sh --opencode-home "$OC_HOME_B" --uninstall
ls "$OC_HOME_B/plugins"    # → some-other-plugin.js still there
```

```bash
rm -rf "$NIO_HOME" "$XDG_CONFIG_HOME" "$SANDBOX"
unset NIO_HOME XDG_CONFIG_HOME OC_HOME SANDBOX
```

## What this catches (regression coverage)

- `plugins/nio.js` loads as ESM inside opencode, and the sentinel that
  makes that possible stays scoped to a directory Nio owns
- `tool.execute.before` throwing `NioBlockedError` actually stops the
  call, and only `NioBlockedError` escapes (every other error is
  swallowed so a Nio bug cannot break the host)
- Orphan-span compensation on the block path
- `session.idle` reclaims spans for tools that threw (§8)
- The `nio_command` tool is registered and `/nio` routes to it
- `/nio doctor` reports opencode install state correctly
- Denial presentation stays usable (§7)
