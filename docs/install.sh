#!/usr/bin/env bash
#
# Nio installer.
# Hosted at https://core0-io.github.io/nio/install.sh
# See https://core0-io.github.io/nio/docs/install.html for usage.
#
# Copyright 2026 core0-io
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO="core0-io/nio"
DOCS_URL="https://core0-io.github.io/nio/docs/install.html"
RELEASES_URL="https://github.com/${REPO}/releases"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"

usage() {
  cat <<USAGE
Nio installer — see ${DOCS_URL}

Args:
  --platform NAME       claude-code | codex | openclaw | hermes (repeatable)
  --uninstall           uninstall instead of install
  --reset-config        reset ~/.nio/config.yaml to defaults
  --cc-home PATH        passed through to claude-code setup.sh
  --codex-home PATH     passed through to codex setup.sh
  --openclaw-home PATH  passed through to openclaw setup.sh
  --hermes-home PATH    passed through to hermes setup.sh
  -h, --help            this message

Env:
  NIO_VERSION=v2.2.0    pin a specific release tag (default: latest)
USAGE
}

die() { echo "ERROR: $*" >&2; exit 1; }

# ---------- Parse args ----------
PLATFORM_ARGS=()
PASS_THROUGH=()
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --platform)
      [ $# -ge 2 ] || die "--platform requires a value"
      PLATFORM_ARGS+=("$2"); shift 2 ;;
    --platform=*)
      PLATFORM_ARGS+=("${1#*=}"); shift ;;
    --uninstall)
      UNINSTALL=1; shift ;;
    --reset-config)
      PASS_THROUGH+=("$1"); shift ;;
    --cc-home|--codex-home|--openclaw-home|--hermes-home)
      [ $# -ge 2 ] || die "$1 requires a path"
      PASS_THROUGH+=("$1" "$2"); shift 2 ;;
    --cc-home=*|--codex-home=*|--openclaw-home=*|--hermes-home=*)
      PASS_THROUGH+=("$1"); shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "ERROR: unknown arg: $1" >&2
      echo "Run with --help for usage." >&2
      exit 1 ;;
  esac
done

# ---------- Pre-checks ----------
for cmd in curl unzip; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' is required but not on PATH."
done

# ---------- Resolve target platforms ----------
PLATFORMS=()
if [ ${#PLATFORM_ARGS[@]} -gt 0 ]; then
  PLATFORMS=("${PLATFORM_ARGS[@]}")
else
  [ -d "$HOME/.claude" ]   && PLATFORMS+=("claude-code")
  [ -d "$HOME/.codex" ]    && PLATFORMS+=("codex")
  [ -d "$HOME/.openclaw" ] && PLATFORMS+=("openclaw")
  [ -d "$HOME/.hermes" ]   && PLATFORMS+=("hermes")
  if [ ${#PLATFORMS[@]} -eq 0 ]; then
    cat >&2 <<EOM
ERROR: no agent CLI detected. Looked for:
  ~/.claude   (Claude Code)
  ~/.codex    (Codex CLI)
  ~/.openclaw (OpenClaw)
  ~/.hermes   (Hermes)

Install one of those first, or pass --platform NAME explicitly.
See ${DOCS_URL}
EOM
    exit 1
  fi
fi

for p in "${PLATFORMS[@]}"; do
  case "$p" in
    claude-code|codex|openclaw|hermes) ;;
    *)
      echo "ERROR: unknown platform '$p'" >&2
      echo "Valid: claude-code, codex, openclaw, hermes" >&2
      exit 1 ;;
  esac
done

# ---------- Working dir ----------
WORK_DIR="$(mktemp -d -t nio-install-XXXXXX)"
trap 'if [ -d "${WORK_DIR:-}" ]; then find "$WORK_DIR" -delete 2>/dev/null || true; fi' EXIT

# ---------- Resolve version ----------
fetch_latest_tag() {
  curl -fsSL "$API_URL" 2>/dev/null | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4
}

VER="${NIO_VERSION:-}"
if [ -z "$VER" ]; then
  VER="$(fetch_latest_tag || true)"
fi
if [ -z "$VER" ]; then
  cat >&2 <<EOM
ERROR: could not fetch latest version from GitHub API.
Likely cause: rate-limit (60 unauthenticated requests/hr per IP).
Workaround: pin a version explicitly, e.g. NIO_VERSION=v2.2.0
See ${RELEASES_URL} for available versions.
EOM
  exit 1
fi

# ---------- Banner ----------
echo
echo "  Nio Installer"
echo "  ============================================="
if [ "$UNINSTALL" -eq 1 ]; then
  echo "  Mode:      uninstall"
else
  echo "  Mode:      install"
  echo "  Version:   $VER"
fi
echo "  Platforms: ${PLATFORMS[*]}"
echo

# ---------- Download + delegate per platform ----------
download_zip() {
  local plat="$1" target="$2"
  local zip_name="nio-${plat}-${VER}.zip"
  local zip_url="${RELEASES_URL}/download/${VER}/${zip_name}"
  local zip_file="${WORK_DIR}/${zip_name}"

  echo "  Fetching: ${zip_url}"
  curl -fsSL -o "$zip_file" "$zip_url" || { echo "  ERROR: download failed" >&2; return 1; }
  unzip -q -o "$zip_file" -d "$target"  || { echo "  ERROR: unzip failed"   >&2; return 1; }
  [ -f "${target}/setup.sh" ] || { echo "  ERROR: zip is missing setup.sh at root" >&2; return 1; }
}

run_setup() {
  local plat_dir="$1"
  local args=()
  [ "$UNINSTALL" -eq 1 ] && args+=("--uninstall")
  if [ ${#PASS_THROUGH[@]} -gt 0 ]; then
    args+=("${PASS_THROUGH[@]}")
  fi
  ( cd "$plat_dir" && bash setup.sh "${args[@]+"${args[@]}"}" )
}

SUCCEEDED=()
FAILED=()
for plat in "${PLATFORMS[@]}"; do
  echo
  echo "  --- $plat ---"
  plat_dir="${WORK_DIR}/${plat}"
  mkdir -p "$plat_dir"
  if download_zip "$plat" "$plat_dir" && run_setup "$plat_dir"; then
    SUCCEEDED+=("$plat")
  else
    echo "  ERROR: $plat install/setup failed" >&2
    FAILED+=("$plat")
  fi
done

# ---------- Summary ----------
echo
echo "  ============================================="
echo "  Summary"
[ ${#SUCCEEDED[@]} -gt 0 ] && echo "    OK:     ${SUCCEEDED[*]}"
[ ${#FAILED[@]}    -gt 0 ] && echo "    FAILED: ${FAILED[*]}"
echo

if [ "$UNINSTALL" -eq 0 ] && [ ${#SUCCEEDED[@]} -gt 0 ]; then
  cat <<EOM
  Next steps:
    1. Edit ~/.nio/config.yaml (set collector.endpoint, protection level, ...)
    2. Restart your agent session so Nio hooks load
    3. See https://core0-io.github.io/nio/docs/configuration.html
EOM
fi

[ ${#FAILED[@]} -eq 0 ]
