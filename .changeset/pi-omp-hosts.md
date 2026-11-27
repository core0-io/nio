---
"@core0-io/nio": minor
---

Pi package works on unattended OMP-based hosts. MCP tools named `<server>__<tool>` (and `<service>__<connection>__<tool>`) are gated as MCP on pi; the OMP tools `eval`, `bash_background` and `web_search` are now analysed instead of passed through; the prompt is captured from `before_agent_start`, so turn spans carry it on hosts that never emit `input`; and the pi package ships a managed-config preset for unattended hosts (confirm verdicts denied) plus an unversioned `nio-pi.zip` release asset.
