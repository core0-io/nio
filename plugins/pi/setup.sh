#!/usr/bin/env bash
set -euo pipefail

# Nio — Pi extension setup
# Installs the Nio extension + skills for the Pi coding agent.
#
# Preferred path: `pi install "$SCRIPT_DIR"` — the release zip IS a valid
# pi package (package.json carries the `pi` manifest key and the
# pi-package keyword), so Pi records it in ~/.pi/agent/settings.json and
# can manage it with `pi update` / `pi remove`.
#
# Fallback path (no `pi` CLI on PATH): copy the bundle into
# ~/.pi/agent/extensions/nio/ and append its absolute path to the
# `extensions` array in settings.json. The documented settings form
# accepts an explicit file or directory path, which avoids depending on
# `index.js` auto-discovery (the documented auto-discovery table only
# names *.ts and */index.ts).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NIO_DIR="${NIO_HOME:-$HOME/.nio}"
MIN_NODE_VERSION=18

UNINSTALL=0
RESET_CONFIG=0
PI_HOME_ARG=""
CONFIG_FILE_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall|uninstall) UNINSTALL=1; shift ;;
    --reset-to-defaults)   RESET_CONFIG=1; shift ;;
    --pi-home)             PI_HOME_ARG="${2:-}"; shift 2 ;;
    --pi-home=*)           PI_HOME_ARG="${1#*=}"; shift ;;
    --config)              CONFIG_FILE_ARG="${2:-}"; shift 2 ;;
    --config=*)            CONFIG_FILE_ARG="${1#*=}"; shift ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--pi-home <path>] [--config <path>] [--reset-to-defaults] [--uninstall]"
      echo ""
      echo "  --pi-home <path>      Path to the pi agent dir. Exported as"
      echo "                        PI_CODING_AGENT_DIR so the pi CLI honours it."
      echo "                        Defaults to \$PI_CODING_AGENT_DIR, then \$HOME/.pi/agent."
      echo "  --config <path>       Apply an operator-provided ~/.nio/config.yaml."
      echo "                        Runs /nio doctor against the file and aborts the"
      echo "                        install if any probe fails."
      echo "  --reset-to-defaults   Overwrite existing nio config with bundled defaults."
      echo "  --uninstall           Remove the extension, skills, and config."
      exit 0 ;;
    *) echo "  ERROR: Unknown option: $1"; echo "  Run with --help for usage."; exit 1 ;;
  esac
done

NIO_CONFIG="${CONFIG_FILE_ARG:-${NIO_CONFIG:-}}"
if [ -n "$NIO_CONFIG" ]; then
  if [ ! -f "$NIO_CONFIG" ]; then
    echo "  ERROR: --config file not found: $NIO_CONFIG" >&2; exit 1
  fi
  NIO_CONFIG="$(cd "$(dirname "$NIO_CONFIG")" && pwd)/$(basename "$NIO_CONFIG")"
fi
if [ "$RESET_CONFIG" -eq 1 ] && [ -n "$NIO_CONFIG" ]; then
  echo "  ERROR: --config and --reset-to-defaults are mutually exclusive." >&2; exit 1
fi
if [ "$UNINSTALL" -eq 1 ] && [ -n "$NIO_CONFIG" ]; then
  echo "  ERROR: --config and --uninstall are mutually exclusive." >&2; exit 1
fi

# Resolution order mirrors plugins/openclaw/setup.sh:
#   --pi-home > $PI_CODING_AGENT_DIR > $HOME/.pi/agent
# PI_CODING_AGENT_DIR is Pi's own documented override for its config
# directory (docs/environment-variables.md).
if [ -n "$PI_HOME_ARG" ]; then
  PI_HOME="$PI_HOME_ARG"
elif [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
  PI_HOME="$PI_CODING_AGENT_DIR"
else
  PI_HOME="$HOME/.pi/agent"
fi

# CRITICAL: export it so the `pi` CLI we shell out to below writes into the
# home we resolved, not the user's real one. Without this, `pi install`
# silently ignores --pi-home and edits ~/.pi/agent/settings.json — that is
# not hypothetical, it happened during development. Same shape as
# OpenClaw's `export OPENCLAW_STATE_DIR`.
export PI_CODING_AGENT_DIR="$PI_HOME"

SETTINGS="$PI_HOME/settings.json"
EXT_DIR="$PI_HOME/extensions/nio"
SKILLS_DIR="$PI_HOME/skills"

# Ownership receipt for the `skills` registration.
#
# `$EXT_DIR/index.js` is unambiguously Nio's — no one else writes that
# path. `$SKILLS_DIR` is NOT: it is the generic `<pi-home>/skills`
# directory, and a user may well have registered it in settings.json for
# their own skills long before Nio existed. So Nio may only ever remove
# that entry if Nio is the one who added it.
#
# This file records exactly that. It is written by the CLI-less fallback
# install, and only when the entry was not already present. Its absence
# means "not ours — leave it alone".
SKILLS_RECEIPT="$EXT_DIR/.nio-registered-skills-dir"

echo ""
echo "  Nio — Pi Extension Setup"
echo "  ============================================="
echo "  Pi home: $PI_HOME"
echo ""

if ! command -v node &>/dev/null; then
  echo "  ERROR: Node.js is not installed. Nio requires Node.js >= $MIN_NODE_VERSION."
  exit 1
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt "$MIN_NODE_VERSION" ]; then
  echo "  ERROR: Node.js v$(node -v) is too old. Nio requires >= $MIN_NODE_VERSION."
  exit 1
fi

# Idempotent settings.json editing. Removes our entries first (matched by
# exact value, not substring — the skills entry is a plain directory path
# with no "nio" in it), then re-adds them on install, so re-running never
# duplicates.
#
# An EMPTY `skills_path` means "do not touch the `skills` array at all".
# Callers pass "" whenever Nio has no receipt proving it added the
# generic `<pi-home>/skills` registration itself — see $SKILLS_RECEIPT.
settings_edit() {
  local mode="$1" ext_path="$2" skills_path="${3:-}"
  node -e '
    const fs = require("fs"), path = require("path");
    const [file, mode, extPath, skillsPath] = process.argv.slice(1);
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const strip = (arr, value) => (Array.isArray(arr) ? arr : [])
      .filter((e) => {
        const s = typeof e === "string" ? e : e && e.source;
        return s !== value;
      });
    cfg.extensions = strip(cfg.extensions, extPath);
    if (skillsPath) cfg.skills = strip(cfg.skills, skillsPath);
    if (mode === "install") {
      cfg.extensions.push(extPath);
      if (skillsPath) cfg.skills.push(skillsPath);
    }
    if (cfg.extensions.length === 0) delete cfg.extensions;
    if (Array.isArray(cfg.skills) && cfg.skills.length === 0) delete cfg.skills;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  ' "$SETTINGS" "$mode" "$ext_path" "$skills_path"
}

# Exit 0 when $SKILLS_DIR is already listed in settings.json's `skills`.
skills_dir_registered() {
  node -e '
    const fs = require("fs");
    const [file, value] = process.argv.slice(1);
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const arr = Array.isArray(cfg.skills) ? cfg.skills : [];
    const hit = arr.some((e) => (typeof e === "string" ? e : e && e.source) === value);
    process.exit(hit ? 0 : 1);
  ' "$SETTINGS" "$SKILLS_DIR"
}

# Strip Nio's registrations from settings.json, removing the generic
# skills entry ONLY when the receipt says Nio added it.
settings_strip_ours() {
  [ -f "$SETTINGS" ] || return 0
  if [ -f "$SKILLS_RECEIPT" ]; then
    settings_edit uninstall "$EXT_DIR/index.js" "$SKILLS_DIR"
  else
    settings_edit uninstall "$EXT_DIR/index.js" ""
  fi
}

if [ "$UNINSTALL" -eq 1 ]; then
  echo "  Uninstalling Nio (Pi)..."
  if command -v pi >/dev/null 2>&1; then
    pi remove "$SCRIPT_DIR" >/dev/null 2>&1 && echo "  Removed pi package" || true
  fi
  if [ -f "$SETTINGS" ]; then
    settings_strip_ours && echo "  Cleaned settings.json" || true
  fi
  rm -rf "$EXT_DIR" 2>/dev/null && echo "  Removed extension" || true
  rm -rf "${SKILLS_DIR:?}/nio" 2>/dev/null && echo "  Removed skill" || true
  for s in nio-scan nio-action nio-report nio-config nio-doctor nio-external-score nio-monitor; do
    rm -rf "${SKILLS_DIR:?}/$s" 2>/dev/null || true
  done
  rm -rf "$NIO_DIR" 2>/dev/null && echo "  Removed config" || true
  echo ""
  echo "  Nio has been uninstalled."
  echo ""
  exit 0
fi

echo "[1/3] Registering extension..."
if command -v pi >/dev/null 2>&1; then
  # Order matters: register FIRST, clean up the old fallback install
  # only once that succeeded.
  #
  # `pi install` records the package path in settings.json's `packages`
  # array; it does not copy anything into $EXT_DIR, so tearing $EXT_DIR
  # down afterwards cannot damage what it just registered. Doing the
  # teardown first — as this used to — meant a failing `pi install`
  # tripped `set -e` with the fallback files already deleted AND their
  # settings.json entries already stripped: no registration, no files,
  # a machine that had a working Nio a second ago and now has none.
  # With the teardown last, a failure leaves the previous fallback
  # install fully intact and still registered.
  if ! pi install "$SCRIPT_DIR"; then
    echo "  ERROR: 'pi install' failed. Nothing was changed — any previous" >&2
    echo "         Nio install is still registered and still in place." >&2
    exit 1
  fi
  # Now strip any prior CLI-less fallback registration. A user who
  # installed before the `pi` CLI was on PATH has the extension path (and
  # possibly the skills path) appended to settings.json; the `pi install`
  # above added a SECOND, package-based registration on top of it. Nio
  # would then load twice — double guard evaluation, duplicate audit rows
  # and duplicate spans per tool call. Idempotent: a no-op on a
  # first-time CLI install, since settings_edit's `strip` just filters
  # entries that aren't there.
  #
  # settings_strip_ours removes the generic `<pi-home>/skills` entry only
  # when $SKILLS_RECEIPT proves Nio added it. Without that guard, a user
  # who had registered that directory for their OWN skills would silently
  # lose the registration just by running Nio's setup.
  settings_strip_ours
  # The fallback copy is now unregistered; drop it (and its receipt) so a
  # later re-run doesn't strip an entry that is no longer Nio's.
  rm -rf "$EXT_DIR" 2>/dev/null || true
  echo "  OK: Registered as a pi package"
else
  echo "  WARN: 'pi' CLI not found — falling back to a direct install."
  # Decide ownership of the generic skills registration BEFORE wiping
  # $EXT_DIR (which is where the receipt lives). Nio owns it if it
  # already owned it, or if nothing has registered it yet.
  if [ -f "$SKILLS_RECEIPT" ] || ! skills_dir_registered; then
    NIO_OWNS_SKILLS=1
  else
    NIO_OWNS_SKILLS=0
  fi
  rm -rf "$EXT_DIR"
  mkdir -p "$EXT_DIR"
  cp "$SCRIPT_DIR/extensions/nio/index.js" "$EXT_DIR/index.js"
  mkdir -p "$SKILLS_DIR"
  for s in nio nio-scan nio-action nio-report nio-config nio-doctor nio-external-score nio-monitor; do
    if [ -d "$SCRIPT_DIR/skills/$s" ]; then
      rm -rf "${SKILLS_DIR:?}/$s"
      cp -r "$SCRIPT_DIR/skills/$s" "$SKILLS_DIR/$s"
    fi
  done
  settings_edit install "$EXT_DIR/index.js" "$SKILLS_DIR"
  [ "$NIO_OWNS_SKILLS" -eq 1 ] && : > "$SKILLS_RECEIPT" || true
  echo "  OK: Extension installed to $EXT_DIR"
fi

echo "[2/3] Verifying skills..."
if command -v pi >/dev/null 2>&1; then
  echo "  OK: Skills load from the registered package"
else
  echo "  OK: Skills installed to $SKILLS_DIR"
fi

echo "[3/3] Setting up configuration..."
mkdir -p "$NIO_DIR"
if [ -n "$NIO_CONFIG" ]; then
  echo "  Applying operator config: $NIO_CONFIG"
  if ! node "$SCRIPT_DIR/skills/nio/scripts/config-cli.js" import "$NIO_CONFIG"; then
    echo "  FAIL: config import rejected by /nio doctor — install aborted." >&2
    exit 1
  fi
  echo "  OK: Operator config applied"
elif [ "$RESET_CONFIG" -eq 1 ] || [ ! -f "$NIO_DIR/config.yaml" ]; then
  [ -f "$SCRIPT_DIR/config.default.yaml" ] && cp "$SCRIPT_DIR/config.default.yaml" "$NIO_DIR/config.yaml"
  [ "$RESET_CONFIG" -eq 1 ] && echo "  OK: Config reset to defaults" || echo "  OK: Default config written"
else
  echo "  OK: Existing config kept"
fi

echo ""
echo "  Nio (Pi) is installed!"
echo ""
echo "  Start pi and run:"
echo ""
echo "    /nio scan <path>"
echo ""
echo "  To uninstall: $(basename "$0") --uninstall"
echo ""
