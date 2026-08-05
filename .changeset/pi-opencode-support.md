---
"@core0-io/nio": minor
---

Add Pi and opencode platform support

Feature parity with the existing platforms: guard Phase 0-6, OTEL
traces/metrics/logs, audit log, the `/nio` skill surface with the six
focused skills, an idempotent installer, and a per-platform release zip —
with two documented host-imposed gaps: Pi emits no subagent task spans
(Pi has no subagent concept), and an opencode tool that throws skips
`tool.execute.after`, so its span is reclaimed at `session.idle` rather
than closed precisely.

Both platforms load Nio as an in-process plugin, so the platform-agnostic
part of the OpenClaw plugin was extracted into a shared
`InProcessPluginRuntime` that all three now share.

Pi is the first platform where a `confirm` verdict opens a real
interactive dialog rather than folding to `guard.confirm_action`.

**Behaviour change — opencode config writes are now guarded.** Any agent
write under `~/.config/opencode/` is a `SENSITIVE_PATH` finding and is
**denied at `balanced`**, the default protection level. That includes
benign-looking files such as `AGENTS.md` and `agent/*.md`, not just
`opencode.json`. The whole directory is covered because
`~/.config/opencode/plugins/` is an auto-load directory opencode globs
and executes at startup — a write there is arbitrary code execution on
the next launch, so the guard treats the tree the same way it already
treats `.pi/`, `.openclaw/` and `.hermes/plugins/`. The project-local
`.opencode/` tree is covered identically. Ordinary opencode users will
notice this; if you want the agent to edit its own instruction files,
add the specific paths to `guard.allowed_commands` / run at
`permissive`, or move those files out of the config dir.

The same protection now follows `XDG_CONFIG_HOME`. Previously the
sensitive-path list only ever matched the literal `.config/opencode/`
fragment, so a user who had relocated their XDG config dir got **no**
opencode path protection at all. Every `.config/…` entry in the list now
gains an equivalent rooted at `$XDG_CONFIG_HOME` when that variable is
set — which also extends `~/.config/Claude/claude_desktop_config.json`
and `~/.config/systemd/user/` to relocated config dirs.
