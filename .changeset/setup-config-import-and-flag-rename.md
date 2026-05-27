---
"@core0-io/nio": minor
---

**Install-time operator-config support + setup-flag rename.**

Two changes ship together; both touch every `setup.sh` (the four per-plugin scripts, the root dispatcher, and `install.sh`).

### `--config <path>` (new)

Operators can now hand a pre-tuned `~/.nio/config.yaml` to a user and have it applied during install in a single step instead of "download then manually copy":

```bash
curl -fsSL https://core0-io.github.io/nio/install.sh | bash -s -- --config /path/to/nio.yaml
# or post-clone
./setup.sh --config /path/to/nio.yaml
```

The flag goes through the same code path as the `/nio config import <path>` slash command (Phase 1 of this work): schema validation → full `/nio doctor` probe suite against the **incoming** config (external_analyser reachability, OAuth token fetch, LLM key sanity, collector connectivity) → only if every probe passes does the overwrite proceed → previous file preserved as `config.yaml.bak.<ISO-stamp>`. If any probe fails, the install aborts non-zero and the live config is not touched.

The path is local-file only (no URL fetching — the install host is the one that has to be able to reach the analyser/collector endpoints during the doctor probe). `NIO_CONFIG=<path>` env var works as a fallback when the flag isn't given. `install.sh` resolves the path to absolute before forwarding to the extracted setup.sh so the path still resolves from `/tmp/nio-install-XXXXXX/`.

### `--reset-config` → `--reset-to-defaults` (BREAKING)

The old `--reset-config` flag is renamed to `--reset-to-defaults` to remove the ambiguity introduced by `--config <path>` (both contain the word `config`; they do very different things — reset to bundled template vs. apply a file). There is **no compat alias**: the old name now errors as `Unknown option: --reset-config`. Anyone with `--reset-config` in CI scripts, install playbooks, or muscle memory needs to switch.

The pair now reads cleanly: `--reset-to-defaults` (what state we reset *to*) vs `--config <path>` (what file we read *from*). They are mutually exclusive — passing both errors at arg-parse time.

### Other notes

- `/nio config import <path>` slash command also ships in this release with the same doctor-gate semantics (Phase 1).
- `handleDoctor()` in `src/adapters/openclaw-dispatch.ts` was refactored into a thin wrapper over `runDoctor(configOverride?)` that returns `{ ok, report }`, so the import path and the live `/nio doctor` command share the exact same probe logic.
- 17 new tests across `dispatch-config-import.test.ts` (11 cases) and `config-cli.test.ts` (4 import cases + 2 rename cases). Full suite 1068/1068 green.
