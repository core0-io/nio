#!/usr/bin/env bash
set -euo pipefail

# Nio — Codex CLI plugin setup
# Codex 0.118+ manages plugins via ~/.codex/config.toml — no `codex plugin`
# subcommand exists yet, so this script edits the TOML directly via a
# small Node helper.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NIO_DIR="${NIO_HOME:-$HOME/.nio}"
MIN_NODE_VERSION=18
MARKETPLACE_NAME="nio"
PLUGIN_NAME="nio"
PLUGIN_ID="$PLUGIN_NAME@$MARKETPLACE_NAME"

# ---- Parse args ----
UNINSTALL=0
RESET_CONFIG=0
CODEX_HOME_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall|uninstall)
      UNINSTALL=1; shift ;;
    --reset-config)
      RESET_CONFIG=1; shift ;;
    --codex-home)
      CODEX_HOME_ARG="${2:-}"; shift 2 ;;
    --codex-home=*)
      CODEX_HOME_ARG="${1#*=}"; shift ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--codex-home <path>] [--reset-config] [--uninstall]"
      echo ""
      echo "  --codex-home <path>  Path to .codex directory."
      echo "                       Defaults to \$CODEX_HOME, then \$HOME/.codex."
      echo "  --reset-config       Overwrite existing nio config with defaults."
      echo "  --uninstall          Remove the plugin and config."
      exit 0 ;;
    *)
      echo "  ERROR: Unknown option: $1"
      echo "  Run with --help for usage."
      exit 1 ;;
  esac
done

# Resolve Codex home: --codex-home > $CODEX_HOME > $HOME/.codex
if [ -n "$CODEX_HOME_ARG" ]; then
  CODEX_HOME_DIR="$CODEX_HOME_ARG"
elif [ -n "${CODEX_HOME:-}" ]; then
  CODEX_HOME_DIR="$CODEX_HOME"
else
  CODEX_HOME_DIR="$HOME/.codex"
fi
CONFIG_TOML="$CODEX_HOME_DIR/config.toml"

echo ""
echo "  Nio — Codex CLI Plugin Setup"
echo "  ============================================="
echo "  Codex home: $CODEX_HOME_DIR"
echo ""

# ---- Pre-check: Node.js ----
if ! command -v node &>/dev/null; then
  echo "  ERROR: Node.js is not installed."
  echo "  Nio requires Node.js >= $MIN_NODE_VERSION."
  echo "  Install from: https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt "$MIN_NODE_VERSION" ]; then
  echo "  ERROR: Node.js v$(node -v) is too old."
  echo "  Nio requires Node.js >= $MIN_NODE_VERSION."
  exit 1
fi

# ---- Pre-check: Codex home exists ----
if [ ! -d "$CODEX_HOME_DIR" ]; then
  echo "  ERROR: Codex home not found at $CODEX_HOME_DIR"
  echo "  Install Codex CLI first: https://github.com/openai/codex"
  exit 1
fi
mkdir -p "$CODEX_HOME_DIR"
[ -f "$CONFIG_TOML" ] || touch "$CONFIG_TOML"

# Tiny TOML editor — line-based, additive. Removes our blocks on uninstall.
toml_edit() {
  # $1 = mode: install | uninstall
  CONFIG_TOML="$CONFIG_TOML" \
  MARKETPLACE_NAME="$MARKETPLACE_NAME" \
  PLUGIN_ID="$PLUGIN_ID" \
  MARKETPLACE_PATH="$SCRIPT_DIR" \
  MODE="$1" \
  node <<'JS_EOF'
const fs = require('fs');
const path = process.env.CONFIG_TOML;
const mp = process.env.MARKETPLACE_NAME;
const pid = process.env.PLUGIN_ID;
const src = process.env.MARKETPLACE_PATH;
const mode = process.env.MODE;

let text = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';

// Remove a top-level block (matched by exact section header) including all
// its key/value lines, up to the next [section] or EOF.
function stripBlock(headerLiteral) {
  const escaped = headerLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\n)\\[${escaped}\\][^\\[]*?(?=\\n\\[|$)`, 'g');
  text = text.replace(re, '');
}

stripBlock(`marketplaces.${mp}`);
stripBlock(`plugins."${pid}"`);
text = text.replace(/\s+$/, '') + '\n';

if (mode === 'install') {
  const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  text += `\n[marketplaces.${mp}]\nlast_updated = "${ts}"\nsource_type = "local"\nsource = "${src}"\n\n[plugins."${pid}"]\nenabled = true\n`;

  // Ensure features.codex_hooks = true (required for hooks to fire).
  const featRe = /\[features\][\s\S]*?(?=\n\[|$)/;
  const m = text.match(featRe);
  if (m) {
    if (!/codex_hooks\s*=\s*true/.test(m[0])) {
      text = text.replace(featRe, m[0].replace(/\s*$/, '') + '\ncodex_hooks = true\n');
    }
  } else {
    text += `\n[features]\ncodex_hooks = true\n`;
  }
}

fs.writeFileSync(path, text.replace(/\n{3,}/g, '\n\n'));
JS_EOF
}

# ---- Uninstall mode ----
if [ "$UNINSTALL" -eq 1 ]; then
  echo "  Uninstalling Nio (Codex)..."
  toml_edit uninstall && echo "  Removed marketplace + plugin entries from $CONFIG_TOML"
  rm -rf "$NIO_DIR" 2>/dev/null && echo "  Removed config" || true
  echo ""
  echo "  Nio has been uninstalled."
  echo ""
  exit 0
fi

# ---- Step 1: Register marketplace + enable plugin in config.toml ----
echo "[1/2] Registering Codex plugin..."
toml_edit install
echo "  OK: Marketplace 'nio' → $SCRIPT_DIR"
echo "  OK: Plugin '$PLUGIN_ID' enabled"
echo "  OK: features.codex_hooks = true"

# ---- Step 2: Create config directory ----
echo "[2/2] Setting up configuration..."
mkdir -p "$NIO_DIR"
if [ "$RESET_CONFIG" -eq 1 ] || [ ! -f "$NIO_DIR/config.yaml" ]; then
  if [ -f "$SCRIPT_DIR/config.default.yaml" ]; then
    cp "$SCRIPT_DIR/config.default.yaml" "$NIO_DIR/config.yaml"
  fi
  [ "$RESET_CONFIG" -eq 1 ] && echo "  OK: Config reset to defaults" || echo "  OK: Default config written"
else
  echo "  OK: Existing config kept"
fi

# ---- Done ----
echo ""
echo "  Nio (Codex) is installed!"
echo ""
echo "  Hooks take effect on the next Codex session."
echo ""
echo "  Try one of:"
echo "    codex \"Scan this skill for execution risks\""
echo "    codex \"Show the agent execution audit log\""
echo ""
echo "  To uninstall: $(basename "$0") --uninstall"
echo ""
