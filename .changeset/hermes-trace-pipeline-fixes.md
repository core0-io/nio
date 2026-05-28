---
"@core0-io/nio": patch
---

**Hermes trace pipeline — five bug fixes for end-to-end span delivery.**

Hermes was silently dropping every `execute_tool` span before this
release — only the `invoke_agent UserPromptSubmit` root reached
OTLP backends, child tool spans never showed up. Five distinct
bugs along the path; fixing only one in isolation wouldn't have
restored the pipeline.

**1. ESM sentinel beside bundled CLIs (commit `97fe3a5`).** Bun
emits the hook-cli / guard-hook / nio-cli bundles as ESM (`import` at
the top) but writes them with a `.js` extension. Node walks up from
the script file to the nearest `package.json` to decide ESM vs CJS,
and the install dirs (`~/.hermes/plugins/nio/scripts/`, the Claude
Code plugin cache, etc.) have no parent declaring `"type": "module"`.
So every hook invocation crashed with:

```text
SyntaxError: Cannot use import statement outside a module
```

Fix: `scripts/build.js` writes a minimal `{"type":"module"}` to
`package.json` beside each bundle output dir; `plugins/hermes/setup.sh`
explicitly copies the sentinel alongside the two CLIs (its install
flow copies individual files, not a recursive directory).

**2. `provider.getTracer()` instead of global `trace.getTracer()`
(commit `7818cb7`).** Bun's single-file bundle ships two physical
copies of `@opentelemetry/api` (one direct, one via
`@opentelemetry/sdk-trace-node`). `provider.register()` writes the
global to API-instance A; `trace.getTracer()` reads from API-instance
B and gets a no-op tracer. Spans get `.startSpan()`/`.end()`/
`.forceFlush()`'d silently — never reach `SimpleSpanProcessor`, never
reach `OTLPTraceExporter`, no `TraceService/Export` RPC fires.

Fix: three call sites in `traces-collector.ts` (`recordPostToolUse`,
`recordPostTaskToolUse`, `endTurn`) now use `provider.getTracer(...)`
directly with the locally-passed `NodeTracerProvider`, bypassing the
global registry entirely.

**3. Pending state migration on session-id promotion (commit
`8bc988b`).** Hermes's `pre_tool_call` shell-hook payload sometimes
arrives with `session_id=""` while the matching `post_tool_call`
carries the real session id. `ensureTurn()` was treating that as a
session change between the two hook-cli subprocess invocations,
wiping `pending_spans` mid-flight. Post then couldn't find the
pre's entry and `recordPostToolUse` early-returned.

Fix: when previous state was on a sentinel session (`""` or
`"unknown"`) and a real session arrives, migrate `pending_spans` +
`pending_guard_attrs` into the new turn instead of resetting.

**4. Non-deterministic `turn_trace_id` + sentinel passthrough
(commit `58a4242`).** `turn_trace_id` was derived from
`MD5(session_id + ":" + turn_number)`. Identical (session, turn)
combinations produced identical 32-char hex forever, so a Hermes
session at turn N today derived the same trace id as turn N
yesterday — yesterday's span ids appeared stitched into today's
trace tree. Worse, the session-promotion fix in #3 was incorrectly
resetting `turn_number` to 1 each time, so every promoted turn
across one entire Hermes session re-derived `MD5(real:1)` and
collapsed onto a single trace id.

Fix (two parts):
- `turn_trace_id` is now a fresh 16-byte random hex per turn,
  generated in `ensureTurn` and persisted to the state file. PRE/POST
  processes share it via state-file load rather than re-deriving.
- `ensureTurn` ignores sentinel `session_id` when prev holds a real
  session — falls back to `prev.session_id` and continues the
  current turn instead of resetting.

**5. Composite spanKey fallback for Hermes pre/post asymmetry
(commit `42f194c`).** Hermes's `pre_tool_call` doesn't carry
`tool_call_id` while `post_tool_call` does (the asymmetry is at
`agent/agent_runtime_helpers.py invoke_tool()` —
`get_pre_tool_call_block_message()` is called without threading the
in-scope `tool_call_id`). Old `spanKey()` used
`tool_use_id || ${tool_name}:${Date.now()}` as key — pre saved under
a random timestamp-based key, post looked up the real
`tool_use_id`, lookup missed.

Fix:
- `spanKey()` fallback is now DETERMINISTIC —
  `${tool_name}:${tool_summary}` instead of `${tool_name}:${Date.now()}`.
- New `resolveSpanKey()` in collector-core's `PostToolUse` path
  tries the primary spanKey first, then the composite fallback if
  the primary missed. Handles asymmetric platforms where pre's
  spanKey is the composite but post's is the real tool_use_id.

**End-to-end verified** against the bundled `~/.hermes/plugins/nio/scripts/hook-cli.js`
with an OTLP HTTP sink intercepting the wire payload. Two
consecutive turns under one Hermes session produce 4 spans each
(1 turn root + 3 tool children) with distinct trace ids and
correct parent-child structure.
