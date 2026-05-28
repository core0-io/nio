# Task: Hermes trace pipeline e2e

Minimal must-pass e2e for the Nio→Hermes trace pipeline. Three benign
shell commands, all allowed. After the run there should be exactly:

- 1 `invoke_agent UserPromptSubmit` turn span (root)
- 3 `execute_tool terminal` tool spans (children of the root, sharing
  its `traceId`)
- All spans carry `service.name = nio-hermes`,
  `nio.platform = hermes`, `gen_ai.agent.name = nio-trace-e2e`

**This e2e never touches `~/.nio/` or the installed Hermes plugin.**
nio reads its config + state from `process.env.NIO_HOME ?? ~/.nio`,
so pointing `NIO_HOME` at a tmpdir is enough to isolate every per-
hook `hook-cli.js` subprocess that Hermes spawns.

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
```

No daemon to restart. Hermes spawns hook-cli.js per event and each
subprocess inherits the shell's `NIO_HOME`.

## The task

Paste verbatim into Hermes (Telegram / CLI / wherever you talk to it):

```text
Run exactly these three commands using the `terminal` tool, in order.
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

### 2. OTLP traces

In your backend, filter:

```text
service.name = "nio-hermes"
  AND gen_ai.agent.name = "nio-trace-e2e"
```

Last 5 min. Expect **4 spans** total in one trace — 1 root
`invoke_agent UserPromptSubmit` + 3 `execute_tool terminal` children.

### 3. Span attribute sanity

Any `execute_tool terminal` span:

- `gen_ai.tool.name = "terminal"`
- `gen_ai.tool.call.id` — Hermes drops `tool_call_id` on `pre_tool_call`
  but includes it on `post_tool_call`. nio's composite-key fallback
  ([src/scripts/lib/collector-core.ts](../src/scripts/lib/collector-core.ts)
  `resolveSpanKey`) pairs them — the span ends up carrying the
  post-side id.
- `nio.guard.decision = "allow"`
- `nio.guard.risk_score < 0.5`
- `nio.guard.eval_ms > 0`
- `status.code = OK`
- `duration < 1s`

`nio.tool.duration_ms` is intentionally absent on Hermes — that's
OpenClaw-only ([docs/COLLECTOR-SIGNALS.md](../docs/COLLECTOR-SIGNALS.md)).

## Cleanup

```bash
rm -rf "$NIO_HOME"
unset NIO_HOME
```

Your `~/.nio/` and `~/.hermes/` are untouched throughout.

## What this catches (regression coverage)

- ESM sentinel beside bundled `hook-cli.js` — runs without
  `SyntaxError: Cannot use import statement outside a module`
- `provider.getTracer()` (not the global no-op) actually exports spans
- Resource attrs (`service.name=nio-hermes`, `nio.platform=hermes`,
  `gen_ai.agent.name`) reach the OTLP backend top-level
- Non-deterministic `turn_trace_id` — distinct trace ids per turn,
  no MD5-collision span ids appearing in unrelated traces
- Session-id sentinel passthrough — Hermes's `pre_tool_call session_id=""`
  doesn't reset turn state mid-session
- Composite spanKey fallback — pre's `${tool_name}:${tool_summary}`
  key pairs with post's `tool_call_id` lookup

If any of these regress, the audit log will show 3 Pre/3 Post but
the OTLP trace will be missing tool spans (or have them in separate
traces). The verification step pins it down precisely.
