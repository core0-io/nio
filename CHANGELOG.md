# @core0-io/ffwd-agent-guard

## 1.0.2

### Patch Changes

- Features

  Add guard.confirm_action config (allow | deny | ask, default allow) to control how each platform handles a confirm decision. Fixes OpenClaw incorrectly blocking the 0.5–0.8 balanced-mode range (no native interactive confirm); Claude Code can also force allow/deny instead of prompting.

  Refactor

  Consolidate skill docs under plugins/shared/skill/ as the single source of truth, synced to both platform plugin dirs during build — eliminates drift between Claude Code and OpenClaw copies.
  Restructure OpenClaw plugin layout: runtime files moved into plugins/openclaw/plugin/ subdir, isolated from skills/ to avoid false positives from OpenClaw's plugin validator.

  Fix

  Release flow now cleans up stale release artifacts before publishing a new version.

## 1.0.1

### Patch Changes

---
