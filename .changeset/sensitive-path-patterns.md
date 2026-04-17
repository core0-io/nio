---
"@core0-io/ffwd-agent-guard": patch
---

- **New `action_guard_rules.sensitive_path_patterns` field**: regex companion to the existing substring-based `sensitive_paths`. Closes a gap where the substring matcher (`includes("/" + pattern)` OR `endsWith(pattern)`) couldn't match dynamic path segments (`/abc/<id>/fff`), bare-relative paths anchored at position 0 (`raw_files/foo.txt`), or case-insensitive variants. Accepts the same `/pattern/flags` syntax as other regex fields. Invalid entries are silently skipped.

- **`config.default.yaml` rewritten**: every field under `guard.action_guard_rules` and `guard.file_scan_rules` now has detailed comments covering purpose+severity, exact matching semantics, regex syntax, and copy-paste examples. The `sensitive_paths` block calls out the leading-slash footgun explicitly (`/etc/` becomes `//etc/` internally and almost never matches — use `etc/`).

- **`plugins/shared/skill/ACTION-POLICIES.md`**: added "User-Supplied Sensitive Path Patterns" section documenting both layers (substring + regex) and how they feed the `SENSITIVE_PATH` finding.

- **+57 tests** across 3 new suites — `action-guard-rules.test.ts` (29), `file-scan-rules.test.ts` (13), `guard-config.test.ts` (15) — covering the user-extension path of every previously untested field under `guard.*` (positive, negative, matcher-branch-specific, invalid-regex-skip). Suite is now 444/444 passing (was 387).
