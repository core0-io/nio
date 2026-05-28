# Task: OpenClaw trace pipeline e2e

Minimal must-pass e2e for the Nio→OpenClaw trace pipeline. Three
benign shell commands, all allowed. After the run there should be
exactly:

- 1 `invoke_agent UserPromptSubmit` turn span (root)
- 3 `execute_tool exec` tool spans (children of the root, sharing
  its `traceId`)
- All spans carry `service.name = nio-openclaw`,
  `nio.platform = openclaw`, `gen_ai.agent.name = nio-trace-e2e`

**This e2e never touches `~/.nio/`, `~/.openclaw/`, or the
launchctl-managed daemon.** OpenClaw is a long-lived daemon — env
changes mid-flight have no effect — so this harness spins up a
**parallel sandbox daemon** on its own profile (`~/.openclaw-trace-e2e/`)
with its own `NIO_HOME` (`mktemp -d`). Your real gateway keeps
running undisturbed.

## Pre-flight

```bash
# 1. Sandbox NIO_HOME
export NIO_HOME=$(mktemp -d -t nio-trace-e2e-XXXXXX)
echo "NIO sandbox: $NIO_HOME"

# 2. Minimal config — adjust collector.endpoint to point at YOUR OTLP backend
cat > "$NIO_HOME/config.yaml" <<'EOF'
agent_name: nio-trace-e2e
guard:
  protection_level: balanced
  confirm_action: allow
collector:
  endpoint: http://localhost:4317
  protocol: grpc
  metrics: { enabled: true }
  traces: { enabled: true }
  logs: { enabled: true, local: true }
EOF

# 3. Install nio into the sandbox OpenClaw profile (~/.openclaw-trace-e2e/)
bash /Users/ab/Work/nio/plugins/openclaw/setup.sh \
  --openclaw-home "$HOME/.openclaw-trace-e2e"
```

## Start the sandbox daemon

```bash
# 4. Start a parallel openclaw gateway:
#    --profile trace-e2e  → state under ~/.openclaw-trace-e2e/
#    NIO_HOME             → nio reads/writes only under $NIO_HOME
NIO_HOME="$NIO_HOME" openclaw --profile trace-e2e gateway \
  > /tmp/nio-trace-e2e-gw.log 2>&1 &
GATEWAY_PID=$!
echo "sandbox gateway pid: $GATEWAY_PID, log: /tmp/nio-trace-e2e-gw.log"
sleep 3

# Confirm the plugin loaded inside the sandbox daemon
tail -10 /tmp/nio-trace-e2e-gw.log | grep -iE "nio|plugin"
```

If you don't see a "plugin nio registered" line (or similar), check
`~/.openclaw-trace-e2e/openclaw.json` for a `plugins.nio` entry — the
setup.sh in step 3 above writes it.

## The task

Send a one-turn agent invocation to the sandbox gateway. Exact form
depends on your delivery channel (CLI / direct API). The prompt:

```text
Run exactly these three commands using your shell-exec tool, in order.
Do NOT use any other tool. Do NOT read or write files. Do NOT make
network requests. Reply with a one-line confirmation after all three
return.

1. date -u
2. uname -sm
3. echo 'nio trace e2e ok'
```

## Verification

### 1. Audit log (sandbox-local)

```bash
AUDIT="$NIO_HOME/audit.jsonl"
python3 - <<PY
import json
events = [json.loads(l) for l in open("$AUDIT") if l.strip()]
pre  = sum(1 for e in events if e.get("event") == "PreToolUse")
post = sum(1 for e in events if e.get("event") == "PostToolUse")
ups  = sum(1 for e in events if e.get("event") == "UserPromptSubmit")
stop = sum(1 for e in events if e.get("event") == "Stop")
print(f"PreToolUse:       {pre}   (expect 3)")
print(f"PostToolUse:      {post}  (expect 3)")
print(f"UserPromptSubmit: {ups}  (expect 1)")
print(f"Stop:             {stop} (expect 1)")
PY
```

OpenClaw's in-memory `pendingGuardAttrs` map holds guard decision
attrs across pre/post within one daemon process — there's no on-disk
state-file race like Hermes has, and pre + post both carry the LLM's
`tool_call_id`.

### 2. OTLP traces

In your backend, filter:

```text
service.name = "nio-openclaw"
  AND gen_ai.agent.name = "nio-trace-e2e"
```

Last 5 min. Expect **4 spans** total in one trace — 1 root
`invoke_agent UserPromptSubmit` + 3 `execute_tool exec` children.

### 3. Span attribute sanity

Any `execute_tool exec` span:

- `gen_ai.tool.name = "exec"` (or whatever OpenClaw's native shell
  tool resolves to — see `guard.native_tool_mapping.openclaw` in your
  config; `exec` is the default)
- `gen_ai.tool.call.id` — present (OpenClaw provides it on both
  `before_tool_call` and `after_tool_call`)
- `nio.guard.decision = "allow"`
- `nio.guard.risk_score < 0.5`
- `nio.guard.eval_ms > 0`
- `nio.tool.duration_ms > 0` — **OpenClaw-only**; this is the
  real wall-clock tool execution time, captured by the openclaw-plugin
  daemon since it has the duration available in-process
  ([docs/COLLECTOR-SIGNALS.md](../docs/COLLECTOR-SIGNALS.md))
- `nio.tool.run_id` — OpenClaw-only run identifier
- `status.code = OK`

## Cleanup

```bash
# Stop sandbox gateway
kill $GATEWAY_PID 2>/dev/null
wait $GATEWAY_PID 2>/dev/null

# Wipe sandbox dirs — ~/.openclaw/ and ~/.nio/ stay untouched
rm -rf "$NIO_HOME"
rm -rf ~/.openclaw-trace-e2e
rm -f /tmp/nio-trace-e2e-gw.log
unset NIO_HOME

# Confirm your real (launchctl-managed) daemon is still running
launchctl list ai.openclaw.gateway 2>&1 | grep PID
```

## What this catches (regression coverage)

- OpenClaw plugin.js loads as ESM inside the daemon (bundled
  `plugins/openclaw/plugin/plugin.js` + sibling `package.json` with
  `"type": "module"` from the plugin manifest)
- `provider.getTracer()` (not the global no-op) emits spans through
  the daemon's NodeTracerProvider
- Resource attrs (`service.name=nio-openclaw`, `nio.platform=openclaw`,
  `gen_ai.agent.name`) reach the OTLP backend top-level
- Non-deterministic `turn_trace_id` — distinct ids per turn within
  the same long-lived session, no cross-day MD5 collisions
- `pendingGuardAttrs` in-memory bridge merges guard decision attrs
  onto the tool span at `after_tool_call`
- Turn-span parent context propagates from `subagent_spawning` /
  `before_tool_call` / `after_tool_call` / `llm_output` into the
  `invoke_agent` root at session end
- `nio.tool.duration_ms` + `nio.tool.run_id` (OpenClaw-only attrs)
  reach the span

If any of these regress, the verification will show either missing
tool spans, missing duration attr, or service.name not matching
`nio-openclaw`.
