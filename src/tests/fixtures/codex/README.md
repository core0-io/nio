# Codex hook stdin fixtures

Real captures from Codex CLI (`codex_hooks` feature flag enabled). Used by
`src/tests/adapter.test.ts` to validate `CodexAdapter.parseInput`.

## How these were captured

1. `codex features enable codex_hooks`
2. Wrote `~/.codex/hooks.json` with all 6 events pointing at a shell script
   that appended `{ capture_event, stdin }` to `/tmp/codex-stdin.jsonl`
3. Ran several `codex exec --skip-git-repo-check` sessions (read-only and
   workspace-write sandboxes) with prompts that exercise the shell tool
4. Sanitized: replaced `/Users/<user>/.codex/` with `/tmp/codex-test-home/`
   so transcript paths are stable

## Observed schema notes

- Codex's only native tool in 0.118.x is `Bash`. Write/Edit/Read/WebFetch
  do not exist as separate native tools — the model performs writes via
  shell commands. Plugin- and MCP-provided tools surface separately.
- `tool_input` for Bash is `{ "command": "<string>" }` — identical to
  Claude Code's Bash shape.
- `permission_mode` is a Codex-specific extra field carrying the active
  approval policy (e.g. `bypassPermissions`, `untrusted`).
- `tool_use_id` (Pre/PostToolUse) is a `call_*` opaque ID.
- PostToolUse adds `tool_response` as a stringified result.
- Stop carries `stop_hook_active` (whether a hook is asking to keep going)
  and `last_assistant_message`.
- SessionStart `source` is `"startup" | "resume" | "clear"`.
- `permission-request` was not reachable in `bypassPermissions` mode —
  fixture for that event is left for Phase 2.
