#!/usr/bin/env bash
set -euo pipefail

# FFWD AgentGuard — One-click setup
# Supports: Claude Code, OpenClaw, ClawHub
# Detects the platform and installs to the correct location.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_SRC="$SCRIPT_DIR/skills/ffwd-agent-guard"
FFWD_AGENT_GUARD_DIR="$HOME/.ffwd-agent-guard"
MIN_NODE_VERSION=18

echo ""
echo "  FFWD AgentGuard — AI Agent Security Guard"
echo "  ============================================="
echo ""

# ---- Pre-check: Node.js ----
if ! command -v node &>/dev/null; then
  echo "  ERROR: Node.js is not installed."
  echo "  FFWD AgentGuard requires Node.js >= $MIN_NODE_VERSION."
  echo "  Install from: https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt "$MIN_NODE_VERSION" ]; then
  echo "  ERROR: Node.js v$(node -v) is too old."
  echo "  FFWD AgentGuard requires Node.js >= $MIN_NODE_VERSION."
  echo "  Install from: https://nodejs.org"
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "  ERROR: npm is not installed."
  exit 1
fi

# ---- Detect platform ----
detect_platform() {
  # Check OpenClaw first (workspace skills or managed skills)
  if [ -d "$HOME/.openclaw" ]; then
    # Prefer workspace skills if workspace exists
    if [ -d "$HOME/.openclaw/workspace" ]; then
      SKILLS_DIR="$HOME/.openclaw/workspace/skills/ffwd-agent-guard"
      PLATFORM="openclaw-workspace"
    else
      SKILLS_DIR="$HOME/.openclaw/skills/ffwd-agent-guard"
      PLATFORM="openclaw-managed"
    fi
    return
  fi

  # Check Claude Code
  if [ -d "$HOME/.claude" ]; then
    SKILLS_DIR="$HOME/.claude/skills/ffwd-agent-guard"
    PLATFORM="claude-code"
    return
  fi

  # Fallback: create Claude Code dir (most common)
  SKILLS_DIR="$HOME/.claude/skills/ffwd-agent-guard"
  PLATFORM="claude-code"
}

detect_platform
echo "  Platform detected: $PLATFORM"
echo "  Install target:    $SKILLS_DIR"
echo ""

# ---- Uninstall mode ----
if [ "${1:-}" = "--uninstall" ] || [ "${1:-}" = "uninstall" ]; then
  echo "  Uninstalling FFWD AgentGuard..."
  rm -rf "$SKILLS_DIR" 2>/dev/null && echo "  Removed skill from $SKILLS_DIR" || true
  # Also clean up other possible locations
  rm -rf "$HOME/.claude/skills/ffwd-agent-guard" 2>/dev/null || true
  rm -rf "$HOME/.openclaw/skills/ffwd-agent-guard" 2>/dev/null || true
  rm -rf "$HOME/.openclaw/workspace/skills/ffwd-agent-guard" 2>/dev/null || true
  rm -rf "$FFWD_AGENT_GUARD_DIR" 2>/dev/null && echo "  Removed config from $FFWD_AGENT_GUARD_DIR" || true
  echo ""
  echo "  FFWD AgentGuard has been uninstalled."
  echo ""
  exit 0
fi

# ---- Step 1: Build the project ----
echo "[1/5] Building FFWD AgentGuard..."
if [ -f "$SCRIPT_DIR/package.json" ]; then
  cd "$SCRIPT_DIR"
  npm install --ignore-scripts 2>/dev/null
  npm run build 2>/dev/null
  echo "  OK: Build complete"
else
  echo "  ERROR: package.json not found. Run this script from the ffwd-agent-guard repo root."
  exit 1
fi

# ---- Step 2: Install CLI dependencies ----
echo "[2/5] Installing CLI dependencies..."
if [ -d "$SKILL_SRC/scripts" ]; then
  cd "$SKILL_SRC/scripts"
  npm install 2>/dev/null
  echo "  OK: CLI dependencies installed"
fi

# ---- Step 3: Copy skill files ----
echo "[3/5] Installing skill files..."
mkdir -p "$SKILLS_DIR"
for f in SKILL.md README.md scan-rules.md action-policies.md evals.md patrol-checks.md .clawignore; do
  [ -f "$SKILL_SRC/$f" ] && cp "$SKILL_SRC/$f" "$SKILLS_DIR/" 2>/dev/null || true
done
echo "  OK: Skill files installed"

# ---- Step 4: Copy scripts + node_modules ----
echo "[4/5] Installing scripts and dependencies..."
mkdir -p "$SKILLS_DIR/scripts"

# Copy script files
for f in checkup-report.js guard-hook.js auto-scan.js trust-cli.ts action-cli.ts package.json package-lock.json; do
  [ -f "$SKILL_SRC/scripts/$f" ] && cp "$SKILL_SRC/scripts/$f" "$SKILLS_DIR/scripts/" 2>/dev/null || true
done

# Copy data directory
if [ -d "$SKILL_SRC/scripts/data" ]; then
  mkdir -p "$SKILLS_DIR/scripts/data"
  cp -r "$SKILL_SRC/scripts/data/"* "$SKILLS_DIR/scripts/data/" 2>/dev/null || true
fi

# Install node_modules in the target (avoids symlink issues in containers)
cd "$SKILLS_DIR/scripts"
if [ -f "package.json" ]; then
  npm install 2>/dev/null
  echo "  OK: Scripts and dependencies installed"
else
  echo "  WARN: No package.json found in scripts directory"
fi

# ---- Step 5: Create config directory ----
echo "[5/5] Setting up configuration..."
mkdir -p "$FFWD_AGENT_GUARD_DIR"
if [ ! -f "$FFWD_AGENT_GUARD_DIR/config.json" ]; then
  echo '{"level":"balanced"}' > "$FFWD_AGENT_GUARD_DIR/config.json"
  echo "  OK: Config created (protection level: balanced)"
else
  echo "  OK: Config already exists (keeping current settings)"
fi

# ---- Done ----
echo ""
echo "  ✅ FFWD AgentGuard is installed!"
echo ""
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🦞 NEXT STEP: Run your first security checkup"
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
if [ "$PLATFORM" = "claude-code" ]; then
  echo "  Open Claude Code and type:"
else
  echo "  Send your OpenClaw bot:"
fi
echo ""
echo "    /ffwd-agent-guard checkup"
echo ""
echo "  This will:"
echo "    • Scan all your installed skills for threats"
echo "    • Check credentials, permissions & network exposure"
echo "    • Generate a full HTML security report"
echo "    • Deliver the report directly to you"
echo ""
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Installed to: $SKILLS_DIR"
echo "  Platform:     $PLATFORM"
echo ""
echo "  Other commands:"
echo "    /ffwd-agent-guard scan <path>    Scan code for security risks"
echo "    /ffwd-agent-guard trust list     View trusted skills"
echo "    /ffwd-agent-guard report         View security event log"
echo ""
echo "  To uninstall: ./setup.sh --uninstall"
echo ""
