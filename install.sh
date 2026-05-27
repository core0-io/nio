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
  --reset-to-defaults   reset ~/.nio/config.yaml to bundled defaults
  --config PATH         apply an operator ~/.nio/config.yaml (runs /nio doctor;
                        aborts install if any probe fails; previous file kept
                        as config.yaml.bak.<ISO-stamp>). Resolved to absolute
                        path here so the extracted setup.sh finds it from any
                        cwd. Mutually exclusive with --reset-to-defaults.
  --cc-home PATH        passed through to claude-code setup.sh
  --codex-home PATH     passed through to codex setup.sh
  --openclaw-home PATH  passed through to openclaw setup.sh
  --hermes-home PATH    passed through to hermes setup.sh
  -h, --help            this message

Env:
  NIO_VERSION=v2.2.0    pin a specific release tag (default: latest)
  NIO_CONFIG=PATH       fallback for --config when the flag is not given
USAGE
}

die() { echo "ERROR: $*" >&2; exit 1; }

# ---------- Parse args ----------
PLATFORM_ARGS=()
PASS_THROUGH=()
UNINSTALL=0
CONFIG_FILE_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --platform)
      [ $# -ge 2 ] || die "--platform requires a value"
      PLATFORM_ARGS+=("$2"); shift 2 ;;
    --platform=*)
      PLATFORM_ARGS+=("${1#*=}"); shift ;;
    --uninstall)
      UNINSTALL=1; shift ;;
    --reset-to-defaults)
      PASS_THROUGH+=("$1"); shift ;;
    --config)
      [ $# -ge 2 ] || die "--config requires a path"
      CONFIG_FILE_ARG="$2"; shift 2 ;;
    --config=*)
      CONFIG_FILE_ARG="${1#*=}"; shift ;;
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

# Resolve --config to an absolute path NOW (before we cd into /tmp for the
# unzip), because the extracted setup.sh runs from the extracted dir and
# would not find a relative-path operator config from the original cwd.
NIO_CONFIG="${CONFIG_FILE_ARG:-${NIO_CONFIG:-}}"
if [ -n "$NIO_CONFIG" ]; then
  if [ ! -f "$NIO_CONFIG" ]; then
    die "--config file not found: $NIO_CONFIG"
  fi
  NIO_CONFIG="$(cd "$(dirname "$NIO_CONFIG")" && pwd)/$(basename "$NIO_CONFIG")"
  PASS_THROUGH+=("--config" "$NIO_CONFIG")
fi

# ---------- Pre-checks ----------
command -v curl >/dev/null 2>&1 || die "'curl' is required but not on PATH."

# Pick an unzipper: prefer unzip, fall back to python3's zipfile module
# (preinstalled on Ubuntu/Debian/Fedora/RHEL where 'unzip' often isn't).
UNZIPPER=""
if command -v unzip >/dev/null 2>&1; then
  UNZIPPER="unzip"
elif command -v python3 >/dev/null 2>&1; then
  UNZIPPER="python3"
elif command -v python >/dev/null 2>&1; then
  UNZIPPER="python"
else
  die "need 'unzip' or 'python3' to extract release archives — install one (e.g. 'sudo apt-get install unzip')."
fi

extract_zip() {
  local zip_file="$1" target="$2"
  case "$UNZIPPER" in
    unzip)
      unzip -q -o "$zip_file" -d "$target" ;;
    python3|python)
      "$UNZIPPER" -m zipfile -e "$zip_file" "$target" ;;
  esac
}

# ---------- Resolve target platforms ----------
# Auto-detect heuristic: a platform counts as "installed" only when BOTH
# its config directory AND its CLI binary are present. Dir-only matches
# (leftover ~/.claude from a removed Claude Code, e.g.) print a warning
# and get skipped; the user can still force-install with --platform NAME.
PLATFORMS=()
SKIPPED_DIR_ONLY=()

detect_platform() {
  local plat="$1" dir="$2" bin="$3"
  if [ ! -d "$dir" ]; then
    return 0
  fi
  if command -v "$bin" >/dev/null 2>&1; then
    PLATFORMS+=("$plat")
  else
    SKIPPED_DIR_ONLY+=("$plat:$dir:$bin")
  fi
}

if [ ${#PLATFORM_ARGS[@]} -gt 0 ]; then
  PLATFORMS=("${PLATFORM_ARGS[@]}")
else
  detect_platform claude-code "$HOME/.claude"   claude
  detect_platform codex       "$HOME/.codex"    codex
  detect_platform openclaw    "$HOME/.openclaw" openclaw
  detect_platform hermes      "$HOME/.hermes"   hermes

  if [ ${#SKIPPED_DIR_ONLY[@]} -gt 0 ]; then
    echo "  Auto-detect: skipped these (config dir exists but CLI not on PATH):" >&2
    for entry in "${SKIPPED_DIR_ONLY[@]}"; do
      IFS=: read -r plat dir bin <<< "$entry"
      echo "    - $plat: $dir is here but '$bin' isn't on PATH" >&2
    done
    echo "    Pass --platform NAME explicitly to force-install one of these." >&2
    echo >&2
  fi

  if [ ${#PLATFORMS[@]} -eq 0 ]; then
    cat >&2 <<EOM
ERROR: no agent CLI detected. Looked for (dir AND binary):
  ~/.claude   + 'claude'   (Claude Code)
  ~/.codex    + 'codex'    (Codex CLI)
  ~/.openclaw + 'openclaw' (OpenClaw)
  ~/.hermes   + 'hermes'   (Hermes)

Install one of those first (and make sure its binary is on PATH —
'pip install --user' targets need ~/.local/bin in PATH; re-open shell
or 'source ~/.profile' if you just installed), or pass --platform NAME
explicitly. See ${DOCS_URL}
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
  extract_zip "$zip_file" "$target"     || { echo "  ERROR: extract failed (via $UNZIPPER)" >&2; return 1; }
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
    2. Start a new agent session so Nio hooks load
    3. See https://core0-io.github.io/nio/docs/configuration.html
EOM
fi

[ ${#FAILED[@]} -eq 0 ]
