#!/usr/bin/env python3
# Copyright 2026 core0-io
# SPDX-License-Identifier: Apache-2.0

"""Safely merge Nio's pre_tool_call shell-hook entry into the user's
~/.hermes/config.yaml.

Invoked by plugins/hermes/setup.sh. Keeps the merge conservative so
we never clobber a user's custom hooks: we backup first, then either
append the snippet as a new top-level `hooks:` key, or add our entry
to the user's existing `hooks.pre_tool_call:` list.

Exit codes:
  0   success (hook installed or already present)
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
from typing import Any, Optional, Tuple

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
        # Non-interactive: fall back to the default. Callers that want
        # a non-TTY happy path should pass --yes explicitly.
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
    # Strip leading comment-only lines + blank lines so the result
    # is just the hooks: YAML block. Keeps the merged config tidy.
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
# YAML merge (PyYAML path)
# ---------------------------------------------------------------------------

def merge_with_yaml(
    existing_text: str,
    hook_cli_abs: str,
    snippet_body: str,
) -> Tuple[str, str]:
    """Return (new_text, status) where status is one of:
       'added', 'already-installed', 'rewrote-path', 'added-alongside'
    """
    existing: Any = yaml.safe_load(existing_text) or {}
    if not isinstance(existing, dict):
        raise ValueError(
            "~/.hermes/config.yaml does not parse as a YAML mapping; "
            "refusing to merge"
        )

    snippet_parsed = yaml.safe_load(snippet_body) or {}
    our_entry = snippet_parsed["hooks"]["pre_tool_call"][0]

    def entry_targets_nio(cmd: Any) -> bool:
        return isinstance(cmd, str) and "hook-cli.js" in cmd and "/skills/nio/scripts/" in cmd

    hooks = existing.get("hooks")
    if not isinstance(hooks, dict):
        existing["hooks"] = {"pre_tool_call": [our_entry]}
        status = "added"
    else:
        pre = hooks.get("pre_tool_call")
        if pre is None:
            hooks["pre_tool_call"] = [our_entry]
            status = "added"
        elif not isinstance(pre, list):
            raise ValueError(
                "hooks.pre_tool_call in ~/.hermes/config.yaml is not a "
                "list; refusing to overwrite. Please merge the snippet "
                "manually."
            )
        else:
            existing_nio = [
                e for e in pre
                if isinstance(e, dict) and entry_targets_nio(e.get("command"))
            ]
            if not existing_nio:
                pre.append(our_entry)
                status = "added-alongside"
            else:
                # Already has a Nio entry — check path.
                same = [
                    e for e in existing_nio
                    if e.get("command") == our_entry["command"]
                ]
                if same:
                    status = "already-installed"
                else:
                    # Path moved — rewrite the first matching entry.
                    for e in pre:
                        if (
                            isinstance(e, dict)
                            and entry_targets_nio(e.get("command"))
                            and e.get("command") != our_entry["command"]
                        ):
                            e["command"] = our_entry["command"]
                            break
                    status = "rewrote-path"

    new_text = yaml.safe_dump(existing, default_flow_style=False, sort_keys=False)
    return new_text, status


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
) -> Tuple[str, str]:
    """Conservative fallback: only handles the "no existing hooks:" case
    safely. Anything more complex is punted to the user with a clear
    message.
    """
    if has_nio_entry(existing_text):
        # Check whether the path matches.
        if hook_cli_abs in existing_text:
            return existing_text, "already-installed"
        raise ValueError(
            "An older Nio hook-cli entry appears in your config but at a "
            "different path. Install PyYAML (`pip install --user pyyaml`) "
            "and re-run setup.sh to rewrite the path automatically, or "
            "edit the command manually."
        )
    if has_top_level_hooks(existing_text):
        raise ValueError(
            "Your config.yaml already has a `hooks:` block. Install "
            "PyYAML (`pip install --user pyyaml`) and re-run setup.sh "
            "to merge automatically, or paste the snippet from "
            "plugins/hermes/config-snippet.yaml into the existing block."
        )

    # No existing hooks block — safe to append.
    suffix = "\n" if not existing_text.endswith("\n") else ""
    new_text = existing_text + suffix + "\n" + snippet_body.rstrip() + "\n"
    return new_text, "added"


# ---------------------------------------------------------------------------
# Uninstall
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
    pre = hooks.get("pre_tool_call")
    if not isinstance(pre, list):
        log("no pre_tool_call list — nothing to uninstall")
        return 0

    before = len(pre)
    remaining = [
        e for e in pre
        if not (
            isinstance(e, dict)
            and isinstance(e.get("command"), str)
            and "hook-cli.js" in e["command"]
            and "/skills/nio/scripts/" in e["command"]
        )
    ]
    if len(remaining) == before:
        log("no Nio hook-cli entry found — nothing to uninstall")
        return 0

    backup(config_path)
    if remaining:
        hooks["pre_tool_call"] = remaining
    else:
        del hooks["pre_tool_call"]
    if not hooks:
        del data["hooks"]

    new_text = yaml.safe_dump(data, default_flow_style=False, sort_keys=False)
    config_path.write_text(new_text, encoding="utf-8")
    log(f"removed Nio hook-cli entry from {config_path}")
    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="Merge Nio's pre_tool_call shell-hook into ~/.hermes/config.yaml",
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
                    help="remove the Nio hook entry and exit")
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
            new_text, status = merge_with_yaml(
                existing_text, args.hook_cli, snippet_body,
            )
        else:
            log("PyYAML not installed — using fallback merge (appends only)")
            new_text, status = merge_without_yaml(
                existing_text, args.hook_cli, snippet_body,
            )
    except ValueError as e:
        log(f"merge aborted: {e}")
        return 1

    if status == "already-installed":
        log(f"Nio hook-cli is already installed at {config_path} — no change")
        return 0

    if args.dry_run:
        print("=== new ~/.hermes/config.yaml ===")
        print(new_text)
        log(f"dry-run complete (status={status}); no files were modified")
        return 0

    if (
        status == "rewrote-path"
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

    messages = {
        "added": f"installed Nio hook-cli entry into {config_path}",
        "added-alongside":
            f"added Nio hook-cli entry alongside existing pre_tool_call hooks "
            f"in {config_path}",
        "rewrote-path":
            f"rewrote existing Nio hook-cli path to the new location in {config_path}",
    }
    log(messages.get(status, f"merge complete (status={status})"))
    log(json.dumps({"command": args.hook_cli, "status": status}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
