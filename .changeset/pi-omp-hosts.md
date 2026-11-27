---
"@core0-io/nio": minor
---

Pi package works on unattended OMP-based hosts. MCP tools named `<server>__<tool>` (and `<service>__<connection>__<tool>`) are gated as MCP on pi; `eval`, `web_search` and `bash_background` tool calls, and OMP's input-only `edit` modes, are now analysed instead of passed through (OMP's `ast_edit` is not; block it with `blocked_tools.pi: [ast_edit]` if needed); the prompt is captured from `before_agent_start`, so turn spans carry it on hosts that never emit `input`; and the pi package ships a managed-config preset for unattended hosts (confirm verdicts denied) plus a `nio-crew.zip` release asset: the same package named `nio`, with no version in the file name.
