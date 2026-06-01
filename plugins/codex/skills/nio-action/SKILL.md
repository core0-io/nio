---
name: nio-action
description: Nio runtime action safety evaluator. Use when the user asks whether a specific runtime action is safe — e.g. "is it safe to run `<command>`", "should I allow this curl/POST", "evaluate this file write / secret access", "check this action with nio". Returns allow/deny/confirm. Focused single-purpose skill; for other Nio operations use /nio.
compatibility: Requires Node.js 18+.
metadata:
  author: core0-io
  version: "2.4.4"
user-invocable: true
command-arg-mode: raw
argument-hint: "<type>: <description>"
---

# Nio — Action Safety Evaluation

Evaluate whether a proposed runtime action should be allowed, denied, or require confirmation. This is the focused `action` capability of the Nio framework. For detailed policies and detector rules, see [ACTION-POLICIES.md](ACTION-POLICIES.md).

> **Passive invocation.** If the user asks whether some concrete command/request/file-op/secret-access is safe to run, you MUST evaluate it with the CLI below rather than guessing. (For scanning a body of code/files, use `nio-scan`; for live endpoint scores, use `nio-external-score`.)

## Resolving the Script Path

The CLI for this skill lives in the **sibling `nio` skill**, not in this skill's own directory. Resolve it relative to where you loaded this SKILL.md:

1. This SKILL.md's parent directory is THIS skill's directory (e.g. `<plugins>/skills/nio-action/`).
2. The script is the sibling `nio` skill's `scripts/action-cli.js` — i.e. `../nio/scripts/action-cli.js` relative to this directory. Derive the absolute path; do **not** hard-code `~/.claude/...`.
3. Invoke with a **single** `node` command — no `cd`, no `;`/`&&`/`|`/`$(...)`/backticks.

Example (substitute the real absolute path):

```bash
node /absolute/path/to/skills/nio/scripts/action-cli.js decide --type exec_command --command "ls"
```

## Supported Action Types

- `network_request` — HTTP/HTTPS requests
- `exec_command` — Shell command execution
- `read_file` / `write_file` — File system operations
- `secret_access` — Environment variable access

## Decision Framework

Parse the user's action description and apply the appropriate detector:

**Network Requests**: Check domain against webhook list and high-risk TLDs, check body for secrets
**Command Execution**: Check against dangerous/sensitive/system/network command lists, detect shell injection
**Secret Access**: Classify secret type and apply priority-based risk levels

## Default Policies

| Scenario | Decision |
|----------|----------|
| Private key exfiltration | **DENY** (always) |
| API secret exfiltration | CONFIRM |
| Command execution | **DENY** (default) |
| Untrusted domain | CONFIRM |
| Body contains secret | **DENY** |

## Action CLI

For structured decisions, use Nio's bundled `action-cli.js` (resolved per the path rules above). It returns JSON.

```
node ../nio/scripts/action-cli.js decide --type exec_command --command "<cmd>"
```

Parse the JSON output: if `decision` is `deny`, recommend **DENY** with the returned evidence. Combine with policy-based checks (webhook domains, secret scanning, etc.).

## Output Format

```
## Nio Action Evaluation

**Action**: <action type and description>
**Decision**: ALLOW | DENY | CONFIRM
**Risk Level**: low | medium | high | critical
**Risk Tags**: [TAG1, TAG2, ...]

### Evidence
- <description of each risk factor found>

### Recommendation
<What should happen and why — allow the action to proceed, block it, or escalate for human confirmation>
```
