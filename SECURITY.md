# Security Policy

Nio is an execution-assurance and observability tool for autonomous AI
agents — it detects risky actions, blocks dangerous commands, and scans
third-party skills for execution risks. Because Nio sits on the critical
path between an agent and its tools, a vulnerability here can mean a
bypassed guard or an undetected malicious skill. We take that seriously.

## Reporting a vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Use GitHub's private vulnerability reporting:

1. Go to the [Security tab](../../security) of this repository.
2. Click **"Report a vulnerability"**.
3. Describe the issue — ideally with a minimal reproducer and the
   impacted Nio version (`pnpm run build && node dist/index.js --version`,
   or the `version` field of `package.json` in your installation).

If you cannot use GitHub's private reporting (e.g. you do not have a
GitHub account), you may open an issue titled *"Security concern —
request private contact"* **without any technical details** and a
maintainer will reach out to move the conversation into a private
channel.

### What to expect

- **Acknowledgement** — within 3 business days.
- **Initial assessment** — within 7 business days (severity, affected
  versions, tentative fix plan).
- **Coordinated disclosure** — we will propose a disclosure date once a
  fix is ready. For critical issues (guard bypass with remote exploit
  potential) this is typically 7–14 days after the patched release; for
  lower severity, 30–90 days. We are happy to coordinate with your own
  disclosure timeline if reasonable.
- **Credit** — if you would like to be credited in the advisory and
  release notes, tell us the name/handle you want to use.

## In scope

The following count as security issues and are eligible for a private
report:

- **Guard bypass** — a command, network request, file write, or secret
  access that should have been denied/flagged but was allowed through
  any of the 6 phase analysers (`AllowlistAnalyser`, `RuntimeAnalyser`,
  `StaticAnalyser`, `BehaviouralAnalyser`, `LLMAnalyser`,
  `ExternalAnalyser`).
- **Phase 0 tool-gate bypass** — a tool in `blocked_tools` still
  executes on a supported platform (Claude Code, OpenClaw).
- **Scanner false-negative on a published ruleset rule** — a skill
  obviously triggering a built-in scan rule slips past the scanner.
- **Audit-log tampering** — `~/.nio/audit.jsonl` can be forged or
  truncated by a non-privileged local adversary in a way that hides
  decisions.
- **Bundled-script injection** — the `isNioSelfInvocation` short-
  circuit is tricked into passing a non-Nio command.
- **Secret leakage in logs or telemetry** — a real user secret
  extracted by Nio's pipeline ends up in the OTEL exporter payload, a
  finding body, or the audit log.
- **Denial of service** — crafted input that crashes the hook or makes
  an evaluation take substantially longer than the phase budget.
- **Dependency-chain compromise** — known upstream vulnerability in a
  bundled dependency with a reachable impact.

## Out of scope

- **Detection-rule tuning** — if a scanner rule has too many false
  positives or misses a nuanced pattern, that is a rule-quality issue,
  not a vulnerability. Open a regular GitHub issue.
- **Social-engineering a host LLM** — getting a model to generate a
  malicious command is a host-model concern, not a Nio concern, unless
  Nio's own guard then fails to catch the resulting action.
- **Self-DoS from misconfiguration** — setting `protection_level:
  strict` with a `blocked_tools.claude_code: ['Bash']` and then
  complaining that Bash is blocked is expected behaviour.
- **Upstream CVEs with no reachable impact** — a transitive dependency
  CVE that does not affect any code path we ship is tracked via
  `pnpm audit` and addressed on the normal release cadence.

## Supported versions

Security fixes are applied to the most recent minor version. Older
minor versions receive fixes only for critical issues.

| Version | Supported            |
|---------|----------------------|
| 2.x     | ✅ Yes (latest)      |
| < 2.0   | ❌ No (please upgrade) |

## Our posture

- No bug-bounty programme at this time.
- No NDA required for good-faith disclosure; we will not pursue legal
  action against researchers acting in good faith under these terms.
- We follow [CVE][cve] for formal disclosure of fixed vulnerabilities.

[cve]: https://www.cve.org/
