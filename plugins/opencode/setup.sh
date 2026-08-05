#!/usr/bin/env bash
set -euo pipefail

# Nio — opencode plugin setup
#
# opencode has no plugin-install CLI, so this performs a full idempotent
# nuke + copy into the opencode config dir:
#   plugins/nio.js       — the bundled Nio plugin
#   commands/nio.md      — the /nio slash command template
#   skills/nio + nio-*   — the unified umbrella skill and the six
#                          focused per-capability skills
#
# Plugin discovery is confirmed by opencode's config/plugin.ts, which
# globs "{plugin,plugins}/*.{ts,js}" — both spellings work; we use the
# documented plural form.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NIO_DIR="${NIO_HOME:-$HOME/.nio}"
MIN_NODE_VERSION=18

UNINSTALL=0
RESET_CONFIG=0
OC_HOME_ARG=""
CONFIG_FILE_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall|uninstall)  UNINSTALL=1; shift ;;
    --reset-to-defaults)    RESET_CONFIG=1; shift ;;
    --opencode-home)        OC_HOME_ARG="${2:-}"; shift 2 ;;
    --opencode-home=*)      OC_HOME_ARG="${1#*=}"; shift ;;
    --config)               CONFIG_FILE_ARG="${2:-}"; shift 2 ;;
    --config=*)              CONFIG_FILE_ARG="${1#*=}"; shift ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--opencode-home <path>] [--config <path>] [--reset-to-defaults] [--uninstall]"
      echo ""
      echo "  --opencode-home <path>  Path to the opencode config dir."
      echo "                          Defaults to \$XDG_CONFIG_HOME/opencode,"
      echo "                          then \$HOME/.config/opencode."
      echo "  --config <path>         Apply an operator-provided ~/.nio/config.yaml."
      echo "  --reset-to-defaults     Overwrite existing nio config with bundled defaults."
      echo "  --uninstall             Remove the plugin, command, skills, and config."
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

if [ -n "$OC_HOME_ARG" ]; then
  OC_HOME="$OC_HOME_ARG"
elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
  OC_HOME="$XDG_CONFIG_HOME/opencode"
else
  OC_HOME="$HOME/.config/opencode"
fi

FOCUSED_SKILLS="nio-scan nio-action nio-report nio-config nio-doctor nio-external-score"

echo ""
echo "  Nio — opencode Plugin Setup"
echo "  ============================================="
echo "  opencode home: $OC_HOME"
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

if [ "$UNINSTALL" -eq 1 ]; then
  echo "  Uninstalling Nio (opencode)..."
  rm -f  "$OC_HOME/plugins/nio.js"  2>/dev/null && echo "  Removed plugin"  || true
  rm -f  "$OC_HOME/commands/nio.md" 2>/dev/null && echo "  Removed command" || true
  rm -rf "$OC_HOME/skills/nio"      2>/dev/null && echo "  Removed skill"   || true
  for s in $FOCUSED_SKILLS; do
    rm -rf "${OC_HOME:?}/skills/$s" 2>/dev/null || true
  done
  rm -rf "$NIO_DIR" 2>/dev/null && echo "  Removed config" || true
  echo ""
  echo "  Nio has been uninstalled."
  echo ""
  exit 0
fi

echo "[1/4] Installing plugin..."
mkdir -p "$OC_HOME/plugins"
rm -f "$OC_HOME/plugins/nio.js"
cp "$SCRIPT_DIR/plugins/nio.js" "$OC_HOME/plugins/nio.js"
# ESM sentinel: opencode imports the bundle directly, and the install dir
# has no ESM-declaring ancestor package.json.
if [ -f "$SCRIPT_DIR/plugins/package.json" ] && [ ! -f "$OC_HOME/plugins/package.json" ]; then
  cp "$SCRIPT_DIR/plugins/package.json" "$OC_HOME/plugins/package.json"
fi
echo "  OK: $OC_HOME/plugins/nio.js"

echo "[2/4] Installing /nio command..."
mkdir -p "$OC_HOME/commands"
cp "$SCRIPT_DIR/commands/nio.md" "$OC_HOME/commands/nio.md"
echo "  OK: $OC_HOME/commands/nio.md"

echo "[3/4] Installing skills..."
mkdir -p "$OC_HOME/skills"
for s in nio $FOCUSED_SKILLS; do
  if [ -d "$SCRIPT_DIR/skills/$s" ]; then
    rm -rf "${OC_HOME:?}/skills/$s"
    cp -r "$SCRIPT_DIR/skills/$s" "$OC_HOME/skills/$s"
  fi
done
echo "  OK: skills installed to $OC_HOME/skills"

echo "[4/4] Setting up configuration..."
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
echo "  Nio (opencode) is installed!"
echo ""
echo "  Restart opencode, then run:"
echo ""
echo "    /nio scan <path>"
echo ""
echo "  To uninstall: $(basename "$0") --uninstall"
echo ""
