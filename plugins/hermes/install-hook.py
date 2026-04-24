#!/usr/bin/env python3
# Copyright 2026 core0-io
# SPDX-License-Identifier: Apache-2.0

"""Safely merge Nio's shell-hook entries into the user's
~/.hermes/config.yaml.

Invoked by plugins/hermes/setup.sh. The snippet declares one entry per
Hermes lifecycle event (pre_tool_call, post_tool_call, pre_llm_call,
post_llm_call, on_session_start, on_session_end, subagent_stop). Each
entry points at the same hook-cli.js — the CLI dispatches internally
based on the stdin payload's `hook_event_name` field.

We never clobber a user's custom hooks: we backup first, then for each
event in the snippet either add a new top-level entry, append our entry
to the user's existing list, or rewrite the path on a stale Nio entry.

Exit codes:
  0   success (hooks installed or already present)
  1   user-facing error (file missing, bad config, refused confirmation)
  2   internal error (unexpected state we don't know how to merge)
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# PyYAML is strongly preferred — Hermes runs on Python so it's almost
# always present. We degrade to a line-based fallback only for the
# tiny subset of operations we need when PyYAML is absent.
# ---------------------------------------------------------------------------
try:
    import yaml  # type: ignore
    HAVE_YAML = True
except ImportError:
    HAVE_YAML = False


def log(msg: str) -> None:
    print(f"[nio-hermes] {msg}", file=sys.stderr)


def prompt_yes_no(question: str, default_yes: bool = True) -> bool:
    if not sys.stdin.isatty():
        return default_yes
    suffix = " [Y/n] " if default_yes else " [y/N] "
    try:
        ans = input(question + suffix).strip().lower()
    except (EOFError, KeyboardInterrupt):
        return False
    if not ans:
        return default_yes
    return ans in ("y", "yes")


# ---------------------------------------------------------------------------
# Snippet template loading
# ---------------------------------------------------------------------------

def load_snippet(snippet_path: Path, hook_cli_abs: str) -> str:
    """Read config-snippet.yaml, strip file-level comments, resolve
    the __NIO_HOOK_CLI_PATH__ sentinel to hook_cli_abs."""
    text = snippet_path.read_text(encoding="utf-8")
    lines = text.splitlines()
    start = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            start = i
            break
    body = "\n".join(lines[start:])
    if "__NIO_HOOK_CLI_PATH__" not in body:
        raise ValueError(
            "snippet template is missing the __NIO_HOOK_CLI_PATH__ sentinel"
        )
    return body.replace("__NIO_HOOK_CLI_PATH__", hook_cli_abs)


# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------

def backup(config_path: Path) -> Optional[Path]:
    if not config_path.exists():
        return None
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    bak = config_path.with_name(config_path.name + f".bak-{stamp}")
    shutil.copy2(config_path, bak)
    log(f"backed up existing config to {bak}")
    return bak


# ---------------------------------------------------------------------------
# YAML merge (PyYAML path) — multi-event aware
# ---------------------------------------------------------------------------

def entry_targets_nio(cmd: Any) -> bool:
    return (
        isinstance(cmd, str)
        and "hook-cli.js" in cmd
        and "/skills/nio/scripts/" in cmd
    )


def merge_event(
    hooks: Dict[str, Any],
    event_name: str,
    our_entry: Dict[str, Any],
) -> str:
    """Apply our entry to a single event key. Returns the per-event
    status: 'added' | 'added-alongside' | 'already-installed' |
    'rewrote-path'."""
    pre = hooks.get(event_name)
    if pre is None:
        hooks[event_name] = [our_entry]
        return "added"
    if not isinstance(pre, list):
        raise ValueError(
            f"hooks.{event_name} in ~/.hermes/config.yaml is not a list; "
            "refusing to overwrite. Please merge the snippet manually."
        )

    nio_entries = [
        e for e in pre
        if isinstance(e, dict) and entry_targets_nio(e.get("command"))
    ]
    if not nio_entries:
        pre.append(our_entry)
        return "added-alongside"

    same = [e for e in nio_entries if e.get("command") == our_entry["command"]]
    if same:
        return "already-installed"

    # Path drift — rewrite the first stale Nio entry to point at the new
    # location.
    for e in pre:
        if (
            isinstance(e, dict)
            and entry_targets_nio(e.get("command"))
            and e.get("command") != our_entry["command"]
        ):
            e["command"] = our_entry["command"]
            return "rewrote-path"

    return "rewrote-path"


def merge_with_yaml(
    existing_text: str,
    snippet_body: str,
) -> Tuple[str, Dict[str, str]]:
    """Multi-event merge. Returns (new_text, statuses) where statuses
    maps event_name → status. The snippet body has already been
    path-resolved by load_snippet, so the absolute hook-cli path is
    embedded in each entry's `command` field."""
    existing: Any = yaml.safe_load(existing_text) or {}
    if not isinstance(existing, dict):
        raise ValueError(
            "~/.hermes/config.yaml does not parse as a YAML mapping; "
            "refusing to merge"
        )

    snippet_parsed = yaml.safe_load(snippet_body) or {}
    snippet_hooks = snippet_parsed.get("hooks", {})
    if not isinstance(snippet_hooks, dict) or not snippet_hooks:
        raise ValueError(
            "snippet template has no hooks block — internal error"
        )

    hooks = existing.get("hooks")
    if not isinstance(hooks, dict):
        existing["hooks"] = hooks = {}

    statuses: Dict[str, str] = {}
    for event_name, our_entries in snippet_hooks.items():
        if not isinstance(our_entries, list) or not our_entries:
            continue
        # Snippet always lists exactly one entry per event.
        our_entry = our_entries[0]
        statuses[event_name] = merge_event(hooks, event_name, our_entry)

    new_text = yaml.safe_dump(existing, default_flow_style=False, sort_keys=False)
    return new_text, statuses


# ---------------------------------------------------------------------------
# YAML merge (no-PyYAML fallback)
# ---------------------------------------------------------------------------

_TOP_KEY_RE = re.compile(r"^(\S+):\s*$")


def has_top_level_hooks(text: str) -> bool:
    for line in text.splitlines():
        m = _TOP_KEY_RE.match(line)
        if m and m.group(1) == "hooks":
            return True
    return False


def has_nio_entry(text: str) -> bool:
    return "/skills/nio/scripts/" in text and "hook-cli.js" in text


def merge_without_yaml(
    existing_text: str,
    hook_cli_abs: str,
    snippet_body: str,
) -> Tuple[str, Dict[str, str]]:
    """Conservative fallback when PyYAML is missing. The fallback can
    ONLY handle the "no existing hooks: block at all" case — the 6
    lifecycle event entries need real YAML parsing for a correct
    per-event merge. Any existing hooks: or Nio entry is refused with
    a clear instruction to install PyYAML (or use setup.sh's default
    path that picks up Hermes's venv python, which already has it)."""
    if has_nio_entry(existing_text) or has_top_level_hooks(existing_text):
        raise ValueError(
            "Your config.yaml already contains a `hooks:` block (possibly "
            "from a previous partial Nio install). Install PyYAML "
            "(`pip install --user pyyaml`) and re-run setup.sh for a "
            "correct per-event merge, or paste the full snippet from "
            "plugins/hermes/config-snippet.yaml manually."
        )

    suffix = "\n" if not existing_text.endswith("\n") else ""
    new_text = existing_text + suffix + "\n" + snippet_body.rstrip() + "\n"
    return new_text, {"_all": "added"}


# ---------------------------------------------------------------------------
# Uninstall — walks every event in the user's hooks block.
# ---------------------------------------------------------------------------

def uninstall(config_path: Path, hook_cli_abs: str) -> int:
    if not config_path.exists():
        log("nothing to do — config file does not exist")
        return 0
    if not HAVE_YAML:
        log(
            "uninstall requires PyYAML. Install with "
            "`pip install --user pyyaml` and re-run, or edit "
            "~/.hermes/config.yaml manually."
        )
        return 1

    text = config_path.read_text(encoding="utf-8")
    data = yaml.safe_load(text) or {}
    if not isinstance(data, dict):
        log("config.yaml does not parse as a mapping; aborting")
        return 2
    hooks = data.get("hooks")
    if not isinstance(hooks, dict):
        log("no hooks: block found — nothing to uninstall")
        return 0

    removed_any = False
    for event_name in list(hooks.keys()):
        pre = hooks.get(event_name)
        if not isinstance(pre, list):
            continue
        before = len(pre)
        remaining = [
            e for e in pre
            if not (
                isinstance(e, dict)
                and isinstance(e.get("command"), str)
                and entry_targets_nio(e["command"])
            )
        ]
        if len(remaining) == before:
            continue
        removed_any = True
        if remaining:
            hooks[event_name] = remaining
        else:
            del hooks[event_name]

    if not removed_any:
        log("no Nio hook-cli entries found — nothing to uninstall")
        return 0

    if not hooks:
        del data["hooks"]

    backup(config_path)
    new_text = yaml.safe_dump(data, default_flow_style=False, sort_keys=False)
    config_path.write_text(new_text, encoding="utf-8")
    log(f"removed Nio hook-cli entries from {config_path}")
    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def summarize(statuses: Dict[str, str]) -> str:
    """Render per-event statuses as a one-line summary."""
    if "_all" in statuses:
        return statuses["_all"]
    counts: Dict[str, List[str]] = {}
    for event, st in statuses.items():
        counts.setdefault(st, []).append(event)
    parts = []
    for st in ("added", "added-alongside", "rewrote-path", "already-installed"):
        if st in counts:
            parts.append(f"{st}={len(counts[st])}")
    return ", ".join(parts) or "no-op"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="Merge Nio's lifecycle shell-hooks into ~/.hermes/config.yaml",
    )
    ap.add_argument("--config", required=True, type=Path,
                    help="path to ~/.hermes/config.yaml")
    ap.add_argument("--hook-cli", required=True,
                    help="absolute path to bundled hook-cli.js")
    ap.add_argument("--snippet", required=True, type=Path,
                    help="path to plugins/hermes/config-snippet.yaml")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the resulting YAML to stdout without writing")
    ap.add_argument("--yes", action="store_true",
                    help="skip confirmation prompts (for CI / scripting)")
    ap.add_argument("--uninstall", action="store_true",
                    help="remove the Nio hook entries and exit")
    args = ap.parse_args(argv)

    config_path: Path = args.config.expanduser()

    if args.uninstall:
        return uninstall(config_path, args.hook_cli)

    if not args.snippet.exists():
        log(f"snippet template not found: {args.snippet}")
        return 1

    try:
        snippet_body = load_snippet(args.snippet, args.hook_cli)
    except ValueError as e:
        log(f"snippet template error: {e}")
        return 2

    existing_text = config_path.read_text(encoding="utf-8") if config_path.exists() else ""

    try:
        if HAVE_YAML:
            new_text, statuses = merge_with_yaml(existing_text, snippet_body)
        else:
            log("PyYAML not installed — using fallback merge (appends only)")
            new_text, statuses = merge_without_yaml(
                existing_text, args.hook_cli, snippet_body,
            )
    except ValueError as e:
        log(f"merge aborted: {e}")
        return 1

    all_already = bool(statuses) and all(s == "already-installed" for s in statuses.values())
    if all_already:
        log(f"Nio hook-cli already installed for all events at {config_path} — no change")
        return 0

    if args.dry_run:
        print("=== new ~/.hermes/config.yaml ===")
        print(new_text)
        log(f"dry-run complete ({summarize(statuses)}); no files were modified")
        return 0

    has_rewrite = any(s == "rewrote-path" for s in statuses.values())
    if (
        has_rewrite
        and not args.yes
        and not prompt_yes_no(
            "An existing Nio entry points at a different path. "
            "Rewrite it to the new location?"
        )
    ):
        log("aborted by user")
        return 1

    config_path.parent.mkdir(parents=True, exist_ok=True)
    backup(config_path)
    config_path.write_text(new_text, encoding="utf-8")

    log(f"installed Nio shell-hooks into {config_path} ({summarize(statuses)})")
    log(json.dumps({"command": args.hook_cli, "statuses": statuses}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
