---
"@core0-io/nio": minor
---

feat(hermes): native shell-hooks adapter

Nio now integrates with Hermes Agent via its native shell-hooks
subsystem ([upstream PR #13296](https://github.com/NousResearch/hermes-agent/pull/13296)).
Hermes spawns `hook-cli.js` on every `pre_tool_call` event; the CLI
runs the full Phase 0–6 pipeline and emits Claude-Code-style
`{"decision": "block", "reason": "..."}` on block, `{}` on allow.
No Python plugin, no pip install — just `bash plugins/hermes/setup.sh`
to merge a `hooks:` entry into `~/.hermes/config.yaml`.

New public exports: `HermesAdapter`, `HermesAdapterOptions`.
New bundled CLI: `hook-cli.js` (thin wrapper over `evaluateHook`
with `--platform` + `--stdin` + `--envelope` modes; Hermes-shaped
stdout formatter that folds the Nio-native `ask` decision through
`guard.confirm_action` since Hermes's wire protocol is block-or-allow
only).

See `README.md#hermes-integration` and `docs/ARCHITECTURE.md#shell-hook-dispatch-hermes`
for the full story.
