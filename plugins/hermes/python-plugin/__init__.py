# Copyright 2026 core0-io
# SPDX-License-Identifier: Apache-2.0

"""Nio Hermes plugin — registers /nio as a command-dispatch handler.

Hermes routes slash commands directly to the registered handler,
bypassing the LLM. Our handler is a thin Python wrapper that spawns
the bundled scripts/nio-cli.js subprocess and returns its stdout.

This is the Hermes-side complement of plugins/openclaw/'s
api.registerTool('nio_command', ...) — same behaviour, different host
API. No pip install: this directory is dropped into
~/.hermes/plugins/nio/ by plugins/hermes/setup.sh and Hermes
auto-discovers it on next startup (~/.hermes/plugins/<name>/ is one of
four discovery paths in hermes_cli/plugins.py::discover_and_load).

Lifecycle hooks (pre_tool_call / post_tool_call / on_session_*) stay
shell-hook-driven via ~/.hermes/config.yaml (installed by Ext E) —
this plugin does not register any lifecycle hooks; only the slash
command surface.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Optional


# Resolve the bundled CLI relative to this plugin's directory. setup.sh
# lays the install out as:
#
#   ~/.hermes/plugins/nio/
#   ├── __init__.py       (this file)
#   ├── plugin.yaml
#   └── scripts/
#       ├── nio-cli.js    (slash-command dispatcher)
#       └── hook-cli.js   (shell-hook dispatcher; installed by Ext E)
NIO_CLI = Path(__file__).resolve().parent / "scripts" / "nio-cli.js"

# Default 30s should comfortably cover a static + behavioural scan on a
# medium repo. Override with NIO_CLI_TIMEOUT for slow environments.
DEFAULT_TIMEOUT_S = int(os.environ.get("NIO_CLI_TIMEOUT", "30"))


def _handle_slash(raw_args: str) -> Optional[str]:
    """Dispatch /nio <args> to the bundled nio-cli.js.

    `raw_args` is everything after `/nio ` as a single string. We pass
    it as a single argv arg so nio-cli's join-on-space logic preserves
    the user's original spacing without us pre-tokenising.

    Returns plain text (config JSON, action decision, scan summary, ...)
    that Hermes routes back to the user channel verbatim. None and ""
    are equivalent — Hermes treats both as "no reply".
    """
    if not NIO_CLI.exists():
        return (
            f"[nio] CLI bundle not found at {NIO_CLI}.\n"
            "Re-run plugins/hermes/setup.sh to reinstall."
        )

    try:
        result = subprocess.run(
            ["node", str(NIO_CLI), raw_args],
            capture_output=True,
            text=True,
            timeout=DEFAULT_TIMEOUT_S,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return f"[nio] timed out after {DEFAULT_TIMEOUT_S}s"
    except FileNotFoundError:
        return (
            "[nio] 'node' not on PATH. Install Node.js 18+ and try again."
        )
    except Exception as exc:  # defensive — never crash the agent
        return f"[nio] subprocess error: {exc}"

    if result.returncode != 0:
        # Surface stderr (or stdout fallback) so users see why things
        # failed without having to dig through Hermes logs.
        tail = (result.stderr or result.stdout or "").strip()
        return f"[nio error] {tail or '(no output)'}"

    return result.stdout


def register(ctx) -> None:
    """Hermes plugin entry point.

    `ctx` is Hermes's plugin-registration context (PluginContext in
    hermes_cli/plugins.py). It exposes register_command + register_hook
    + register_tool. We only register the slash command — lifecycle
    hooks stay shell-hook-driven (config.yaml).
    """
    ctx.register_command(
        "nio",
        handler=_handle_slash,
        description="Nio — execution assurance: scan / action / config / report / reset",
    )
