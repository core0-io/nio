# Contributing to Nio

Thanks for your interest in Nio. This document covers the day-to-day
mechanics: getting a local dev environment running, the project layout,
and what we expect in a pull request. For a reference on the security
pipeline itself, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Prerequisites

- **Node.js ≥ 18** (20 LTS recommended)
- **pnpm ≥ 9** — `npm install -g pnpm`
- **Bun** — used to bundle `dist/` entrypoints into the plugin
  distributions. `curl -fsSL https://bun.sh/install | bash`

## Getting set up

```bash
git clone https://github.com/core0-io/nio.git
cd nio
pnpm install
pnpm run build    # tsc → bun bundle → sync shared config/skill → sync site version
pnpm test         # 500+ tests, should finish in < 15s
```

If the build or tests fail cleanly on `main`, please file an issue —
that is a regression.

## Project layout

```
src/
├── core/                       # Phase analysers + orchestrator (platform-agnostic)
│   ├── action-orchestrator.ts  # 6-phase pipeline entry
│   ├── action-decision.ts      # ActionDecision / ProtectionLevel helpers
│   └── analysers/              # One directory per phase analyser
│       ├── allowlist/          # Phase 1
│       ├── runtime/            # Phase 2
│       ├── static/             # Phase 3
│       ├── behavioural/        # Phase 4
│       ├── llm/                # Phase 5
│       └── external/           # Phase 6
├── adapters/                   # Per-platform I/O (Claude Code, OpenClaw, …)
│   ├── hook-engine.ts          # evaluateHook — Phase 0 + dispatch + audit
│   └── self-invocation.ts      # Guard-hook self-call short-circuit
├── scripts/                    # CLI entrypoints (guard-hook, action-cli, …)
├── scanner/                    # File-scanning pipeline
└── tests/                      # node:test, runs against compiled dist/tests/
plugins/
├── shared/                     # Source of truth for skill + config (synced)
├── claude-code/                # Claude Code hooks + skill
└── openclaw/                   # OpenClaw plugin + skill
docs/                           # Architecture + user docs (GitHub Pages)
scripts/                        # build.js, release.js, sync-*.js
```

## Workflow

### 1. Pick or file an issue

For anything non-trivial, open an issue first so the approach can be
reviewed before you spend time on code. Typos and obvious one-liners
can skip straight to a PR.

### 2. Branch + code

```bash
git checkout -b feat/short-description
```

We follow **[Conventional Commits](https://www.conventionalcommits.org/)**
for commit subjects. Common prefixes used in this repo:

- `feat:` — user-visible new functionality
- `fix:` — bug fix (including false positives/negatives in detection rules)
- `refactor:` — internal reorganisation, no behaviour change
- `docs:` — documentation only
- `chore:` — tooling, release, licence, dependencies
- `test:` — test-only changes
- `perf:` — performance-focused change

Scopes are optional but help (`fix(guard): ...`, `feat(openclaw): ...`).

### 3. Write tests

- Unit tests live alongside `src/tests/*.test.ts`.
- Integration tests (`evaluateHook` end-to-end, plugin wiring) live in
  `src/tests/integration.test.ts`.
- Detection-quality tests (new rule / rule tweak) go in
  `src/tests/action-guard-rules.test.ts` or
  `src/tests/file-scan-rules.test.ts`.
- Fixtures for deliberately-malicious scan targets live under
  `src/tests/fixtures/vulnerable-skill/`.

Run the full suite:

```bash
pnpm run build && pnpm test
```

A PR that adds a detection rule **must** include at least one positive
and one negative fixture for that rule.

### 4. Add a changeset

Every user-facing change needs a changeset so it appears in
`CHANGELOG.md`:

```bash
pnpm version-select
```

The command is interactive: pick the bump type (patch/minor/major) and
write a one-line description. A markdown file is committed under
`.changeset/`.

Internal refactors with no user-visible behaviour change can skip the
changeset (add `skip` in the interactive prompt).

### 5. Pre-PR self-check

```bash
pnpm tsc --noEmit     # 0 errors expected
pnpm test             # all green
pnpm run build        # artefacts regenerate cleanly
```

If you touch detection rules, do a manual smoke:

```bash
node plugins/claude-code/skills/nio/scripts/action-cli.js evaluate \
  --type exec_command --command "ls /tmp"
# expect decision: allow
```

### 6. Open the PR

Fill in the PR template. At minimum: describe the change, link any
issue, and confirm tests + changeset.

Husky runs a **license-header** hook on commit to keep SPDX headers
intact. If it fails, it will print which files are missing the header;
just add the standard two-line header and re-commit:

```ts
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0
```

## Release process (maintainers)

End-to-end release is documented in [CLAUDE.md](CLAUDE.md) (the project
ops reference). Short form:

```bash
pnpm bump          # consume changesets, update CHANGELOG + versions
git commit -am "release v$(jq -r .version package.json)"
pnpm tag           # changeset tag → local git tags
git push --follow-tags
pnpm release:publish   # build + per-platform zips + gh release
```

## Licensing

By contributing to Nio you agree that your contribution is licensed
under the [Apache License 2.0](LICENSE). If the change imports code or
ideas from another project, update [`NOTICE`](NOTICE) and, if
applicable, add the upstream licence file under `LICENSES/`.

## Security issues

**Do not file security vulnerabilities as regular issues.** See
[`SECURITY.md`](SECURITY.md) for the private reporting process.

## Questions

Open a GitHub Discussion or a regular issue (labelled `question`).
