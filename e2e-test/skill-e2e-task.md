# Nio Skill Smoke Test

Goal: confirm the `nio` skill is installed and each subcommand (`config`, `scan`, `action`, `report`) routes and executes correctly in this agent. This is a functional check of the skill surface — **not** a security-detection test. We do not care what the scan finds or which decision `action` returns; we only care that each command produces a structured, non-error response.

## How to invoke the skill

Invocation syntax differs per host:

- **Claude Code**: type the slash command directly (`/nio scan .`).
- **OpenClaw / other agents**: no slash router. Discover the skill by reading its `SKILL.md` in your workspace (usually `~/.openclaw/workspace/skills/nio/SKILL.md`), then follow the instructions in that file to run the corresponding subcommand. Typically this means `cd`-ing into the skill directory and running `node scripts/<cli>.js …`.

If you cannot find the `nio` skill in your workspace, list your available skills and stop — the skill is not installed and the rest of this task is not applicable. Report that result.

Run every step in order. For each step, paste the skill's output under **Actual**. Do not skip steps. At the end, mark PASS / FAIL for each.

---

## Step 1 — `config show`

Ask the skill to display the current Nio configuration. Equivalent invocations:

- Slash: `/nio config show`
- Script: `node <skill-dir>/scripts/config-cli.js show`

**Expected:** Prints the current configuration (at minimum `protection_level`, plus other `guard` / `collector` fields). No errors.

**Actual:** *paste output*

## Step 2 — `scan`

Ask the skill to scan the current working directory. Equivalent invocations:

- Slash: `/nio scan .`
- Via SKILL.md: follow the `scan` subcommand section — use Glob + Grep as instructed, or the scanner script if your agent has one.

The point is just that the skill runs and produces a report — the risk level and finding count don't matter.

**Expected:** A scan report appears with `Risk Level`, `Files Scanned`, `Total Findings`, and a findings table (possibly empty). No errors.

**Actual:** *paste output*

## Step 3 — `action`

Ask the skill to evaluate the benign command `ls`. Equivalent invocations:

- Slash: `/nio action exec_command: ls`
- Script: `node <skill-dir>/scripts/action-cli.js decide --type exec_command --command "ls"`

`ls` is benign — this just exercises the decision path.

**Expected:** A decision block / JSON appears with `decision`, `risk_level`, and `risk_tags`. Any decision value (ALLOW / DENY / CONFIRM) is acceptable for this test. No errors.

**Actual:** *paste output*

## Step 4 — `report`

Ask the skill to show recent audit events. Equivalent invocations:

- Slash: `/nio report`
- Via SKILL.md: read `~/.nio/audit.jsonl` (or `$NIO_HOME/audit.jsonl`) as instructed in the `report` subcommand section.

**Expected:** Either a report table of recent events, or a clear message that no events have been recorded yet. No errors.

**Actual:** *paste output*

---

## Verdict

- [ ] Step 1 ran and printed config
- [ ] Step 2 ran and printed a scan report
- [ ] Step 3 ran and printed a decision
- [ ] Step 4 ran and printed a report (or a clean "no events" message)

For any FAIL, state whether the agent (a) said the skill was unavailable, (b) errored during execution, or (c) refused to run. Include the agent's exact response.

---

## Notes

- The `/nio` slash prefix is a Claude Code convention. OpenClaw and most other hosts do not register slash commands — agents there discover skills by reading `SKILL.md` files in their workspace. If your agent reports "command `/nio` not recognized", that is not a skill-installation problem; it means the agent needs to be asked in natural language ("use the nio skill to …").
- This file tests only that the skill is **wired up and callable**. For detection-quality tests (does `scan` actually flag dangerous fixtures, does `action` actually DENY risky inputs), run those against the CLI directly — `node <skill-dir>/scripts/action-cli.js decide --type exec_command --command "<cmd>"` — rather than through an agent whose safety layer may refuse dangerous-string inputs.
- For guard-hook (runtime interception) tests, see [`guard-e2e-task.md`](./guard-e2e-task.md).
