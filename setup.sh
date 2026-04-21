#!/usr/bin/env bash
set -euo pipefail

# Nio — All-in-one setup
# Detects platform and runs the appropriate plugin setup script(s).
# Supports: Claude Code, OpenClaw, ClawHub

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---- Partition args between sub-scripts ----
# --cc-home goes only to claude-code; --openclaw-home only to openclaw.
# Everything else (--uninstall, --reset-config, etc.) goes to both.
UNINSTALL=0
CC_HOME_ARG=""
OPENCLAW_HOME_ARG=""
CC_ARGS=()
OC_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall|uninstall)
      UNINSTALL=1
      CC_ARGS+=("--uninstall")
      OC_ARGS+=("--uninstall")
      shift ;;
    --cc-home)
      CC_HOME_ARG="${2:-}"
      CC_ARGS+=("--cc-home" "${2:-}")
      shift 2 ;;
    --cc-home=*)
      CC_HOME_ARG="${1#*=}"
      CC_ARGS+=("$1")
      shift ;;
    --openclaw-home)
      OPENCLAW_HOME_ARG="${2:-}"
      OC_ARGS+=("--openclaw-home" "${2:-}")
      shift 2 ;;
    --openclaw-home=*)
      OPENCLAW_HOME_ARG="${1#*=}"
      OC_ARGS+=("$1")
      shift ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--cc-home <path>] [--openclaw-home <path>] [--reset-config] [--uninstall]"
      echo ""
      echo "  --cc-home <path>        Path to .claude directory."
      echo "                          Defaults to \$CLAUDE_CONFIG_DIR, then \$HOME/.claude."
      echo "  --openclaw-home <path>  Path to .openclaw directory."
      echo "                          Defaults to \$OPENCLAW_STATE_DIR, then \$HOME/.openclaw."
      echo "  --reset-config          Overwrite existing nio config with defaults."
      echo "  --uninstall             Remove the plugin and config."
      echo ""
      echo "  INSTALL_ALL=1           Force install for all platforms (env var)."
      exit 0 ;;
    *)
      CC_ARGS+=("$1")
      OC_ARGS+=("$1")
      shift ;;
  esac
done

# Resolve detection paths: --flag > env var > $HOME default
if [ -n "$CC_HOME_ARG" ]; then
  CC_HOME="$CC_HOME_ARG"
elif [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  CC_HOME="$CLAUDE_CONFIG_DIR"
else
  CC_HOME="$HOME/.claude"
fi

if [ -n "$OPENCLAW_HOME_ARG" ]; then
  OPENCLAW_HOME="$OPENCLAW_HOME_ARG"
elif [ -n "${OPENCLAW_STATE_DIR:-}" ]; then
  OPENCLAW_HOME="$OPENCLAW_STATE_DIR"
else
  OPENCLAW_HOME="$HOME/.openclaw"
fi

echo ""
echo "  Nio — AI Agent Security Guard"
echo "  ============================================="
echo ""

# ---- Uninstall mode ----
if [ "$UNINSTALL" -eq 1 ]; then
  echo "  Uninstalling Nio (all platforms)..."
  [ -f "$SCRIPT_DIR/plugins/claude-code/setup.sh" ] && bash "$SCRIPT_DIR/plugins/claude-code/setup.sh" "${CC_ARGS[@]+"${CC_ARGS[@]}"}"
  [ -f "$SCRIPT_DIR/plugins/openclaw/setup.sh" ] && bash "$SCRIPT_DIR/plugins/openclaw/setup.sh" "${OC_ARGS[@]+"${OC_ARGS[@]}"}"
  echo ""
  echo "  Nio has been uninstalled from all platforms."
  echo ""
  exit 0
fi

INSTALLED=0

# ---- Claude Code ----
if [ -d "$CC_HOME" ] || [ "${INSTALL_ALL:-}" = "1" ]; then
  echo "  Detected: Claude Code ($CC_HOME)"
  echo ""
  bash "$SCRIPT_DIR/plugins/claude-code/setup.sh" "${CC_ARGS[@]+"${CC_ARGS[@]}"}"
  INSTALLED=1
fi

# ---- OpenClaw / ClawHub ----
if [ -d "$OPENCLAW_HOME" ] || [ "${INSTALL_ALL:-}" = "1" ]; then
  echo "  Detected: OpenClaw ($OPENCLAW_HOME)"
  echo ""
  bash "$SCRIPT_DIR/plugins/openclaw/setup.sh" "${OC_ARGS[@]+"${OC_ARGS[@]}"}"
  INSTALLED=1
fi

# ---- No platform detected ----
if [ "$INSTALLED" -eq 0 ]; then
  echo "  No supported platform detected."
  echo ""
  echo "  Looked for:"
  echo "    - Claude Code  $CC_HOME"
  echo "    - OpenClaw     $OPENCLAW_HOME"
  echo ""
  echo "  If your install lives elsewhere, pass --cc-home or --openclaw-home:"
  echo "    ./setup.sh --cc-home /path/to/.claude"
  echo "    ./setup.sh --openclaw-home /path/to/.openclaw"
  echo ""
  echo "  Or install for a specific platform directly:"
  echo "    plugins/claude-code/setup.sh"
  echo "    plugins/openclaw/setup.sh"
  echo ""
  echo "  To force install for all platforms:"
  echo "    INSTALL_ALL=1 ./setup.sh"
  echo ""
  exit 1
fi
