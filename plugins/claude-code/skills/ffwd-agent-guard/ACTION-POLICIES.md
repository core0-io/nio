# Action Evaluation Policies Reference

Detailed detector rules and policies for the `action` subcommand.

## Network Request Detector

### Webhook / Exfiltration Domains (auto-block if not in allowlist)

| Domain | Service |
|--------|---------|
| `discord.com` / `discordapp.com` | Discord webhooks |
| `api.telegram.org` | Telegram bot API |
| `hooks.slack.com` | Slack webhooks |
| `webhook.site` | Webhook testing |
| `requestbin.com` | Request inspection |
| `pipedream.com` | Workflow automation |
| `ngrok.io` / `ngrok-free.app` | Tunneling |
| `beeceptor.com` | API mocking |
| `mockbin.org` | HTTP mocking |

### High-Risk TLDs

`.xyz`, `.top`, `.tk`, `.ml`, `.ga`, `.cf`, `.gq`, `.work`, `.click`, `.link`

Domains with these TLDs are flagged as medium risk. POST/PUT to high-risk TLD escalates to high risk.

### Request Body Secret Scanning

Scan request body for sensitive data. Priority determines risk level:

| Secret Type | Priority | Risk Level | Decision |
|------------|----------|------------|----------|
| Private Key (`0x` + 64 hex) | 100 | critical | DENY |
| SSH Private Key (`-----BEGIN.*PRIVATE KEY`) | 90 | critical | DENY |
| AWS Secret Key (`[A-Za-z0-9/+=]{40}` near AWS context) | 80 | high | CONFIRM |
| AWS Access Key (`AKIA[0-9A-Z]{16}`) | 70 | high | CONFIRM |
| GitHub Token (`gh[pousr]_[A-Za-z0-9_]{36,}`) | 70 | high | CONFIRM |
| Bearer/JWT Token (`ey[A-Za-z0-9-_]+\.ey[A-Za-z0-9-_]+`) | 60 | medium | CONFIRM |
| API Secret (generic `api.*secret` patterns) | 50 | medium | CONFIRM |
| DB Connection String (`(postgres|mysql|mongodb)://`) | 50 | medium | CONFIRM |
| Password in Config (`password\s*[:=]`) | 40 | low | CONFIRM |

User-supplied regexes in `guard.action_guard_rules.secret_patterns` are
additionally evaluated against the request body. Matches produce a `SECRET_LEAK_USER`
finding (high) with the matching pattern source echoed in the title.

### Network Decision Logic

1. Invalid URL -> DENY (high)
2. Domain in webhook list & not in allowlist -> DENY (high)
3. Body contains private key / SSH key -> DENY (critical)
4. Body contains other secrets -> risk based on priority
5. High-risk TLD & not in allowlist -> CONFIRM (medium)
6. POST/PUT to untrusted domain -> escalate medium to high
7. Domain in allowlist -> ALLOW (low)

## Command Execution Detector

### Dangerous Commands (always DENY, critical)

| Command | Risk |
|---------|------|
| `rm -rf` / `rm -fr` | Recursive delete |
| `mkfs` | Format filesystem |
| `dd if=` | Raw disk write |
| `:(){:\|:&};:` (and space variants) | Fork bomb (regex: `:\s*\(\s*\)\s*\{.*:\s*\|\s*:.*&.*\}`) |
| `chmod 777` / `chmod -R 777` | World-writable permissions |
| `> /dev/sda` | Disk overwrite |
| `mv /* ` | Move root contents |
| `wget\|sh` / `curl\|sh` | Download and execute |
| `wget\|bash` / `curl\|bash` | Download and execute |

### User-Supplied Dangerous Patterns (always DENY, critical)

Regexes in `guard.action_guard_rules.dangerous_patterns` are evaluated after
the built-in lists. Use the `/pattern/flags` literal form for case-insensitive
matching (e.g. `'/\b(INSERT|UPDATE|DELETE)\b/i'`). Matches produce a
`DANGEROUS_PATTERN` finding with the matching pattern source echoed in the title.
Invalid regex entries are silently skipped; remaining valid ones still apply.

### Sensitive Data Access (high)

| Command | Target |
|---------|--------|
| `cat /etc/passwd` | User database |
| `cat /etc/shadow` | Password hashes |
| `cat ~/.ssh` | SSH keys |
| `cat ~/.aws` | AWS credentials |
| `cat ~/.kube` | Kubernetes config |
| `cat ~/.npmrc` | npm auth tokens |
| `cat ~/.netrc` | Network credentials |
| `printenv` / `env` / `set` | All environment variables |

### System Modification Commands (medium)

`sudo`, `su`, `chown`, `chmod`, `chgrp`, `useradd`, `userdel`, `groupadd`, `passwd`, `visudo`, `systemctl`, `service`, `init`, `shutdown`, `reboot`, `halt`

### Network Commands (medium)

`curl`, `wget`, `nc`/`netcat`/`ncat`, `ssh`, `scp`, `rsync`, `ftp`, `sftp`

### Shell Injection Patterns (medium)

| Pattern | Description |
|---------|-------------|
| `; command` | Command separator |
| `\| command` | Pipe |
| `` `command` `` | Backtick execution |
| `$(command)` | Command substitution |
| `&& command` | Conditional chain |
| `\|\| command` | Or chain |

### Sensitive Environment Variables

Flag env vars containing: `API_KEY`, `SECRET`, `PASSWORD`, `TOKEN`, `PRIVATE`, `CREDENTIAL`

### Safe Command Allowlist

Commands matching the safe list are allowed without restriction, **unless** they contain shell metacharacters (`;`, `|`, `&`, `` ` ``, `$`, `(`, `)`, `{`, `}`) or access sensitive paths.

| Category | Commands |
|----------|----------|
| **Basic** | `ls`, `echo`, `pwd`, `whoami`, `date`, `hostname`, `uname`, `tree`, `du`, `df`, `sort`, `uniq`, `diff`, `cd` |
| **Read** | `cat`, `head`, `tail`, `wc`, `grep`, `find`, `which`, `type` |
| **File ops** | `mkdir`, `cp`, `mv`, `touch` |
| **Git** | `git status`, `git log`, `git diff`, `git branch`, `git show`, `git remote`, `git clone`, `git checkout`, `git pull`, `git fetch`, `git merge`, `git add`, `git commit`, `git push` |
| **Package managers** | `npm install`, `npm run`, `npm test`, `npm ci`, `npm start`, `npx`, `yarn`, `pnpm`, `pip install`, `pip3 install` |
| **Build & run** | `node`, `python`, `python3`, `tsc`, `go build`, `go run`, `go version`, `cargo build`, `cargo run`, `cargo test`, `make`, `rustc --version`, `java -version` |

### Exec Decision Logic

All rule sets are evaluated on every command; findings accumulate so audit
logs show every dimension the command touched. The decision is derived from
the aggregated score, not from which rule fired first.

1. Fork bomb (regex) -> critical
2. Dangerous command (built-in strings / built-in pipe-to-shell regexes) -> critical
3. User-supplied `dangerous_patterns` -> critical
4. Safe command (no metacharacters, no sensitive paths) -> ALLOW (low) — short-circuits Phase 1
5. Exec not allowed in capability model -> CONFIRM (non-critical) — balanced mode prompts user
6. Sensitive data access -> high
7. System command -> high
8. Network command -> medium
9. Shell injection pattern -> medium
10. Sensitive env vars passed -> evidence

**Note**: In balanced mode, non-critical blocked commands (step 5) trigger a user prompt instead of a hard block. Any critical finding (steps 1-3) always denies regardless of protection level.

## Default Policies

```
secret_exfil:
  private_key: DENY (always block)
  api_secret: CONFIRM (require user approval)

exec_command: DENY (default, unless capability allows)

network:
  untrusted_domain: CONFIRM
  body_contains_secret: DENY
```

## Capability Presets

### none (Most Restrictive)
```json
{
  "network_allowlist": [],
  "filesystem_allowlist": [],
  "exec": "deny",
  "secrets_allowlist": []
}
```

### read_only
```json
{
  "network_allowlist": [],
  "filesystem_allowlist": ["./**"],
  "exec": "deny",
  "secrets_allowlist": []
}
```
