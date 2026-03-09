#!/usr/bin/env bash

set -euo pipefail

REPO="${PEEK_REPO:-chandeldivyam/peek-cli}"
PREFIX="${PEEK_PREFIX:-$HOME/.local}"
VERSION="${PEEK_VERSION:-latest}"
BIN_DIR="$PREFIX/bin"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "peek installer error: missing required command '$1'" >&2
    exit 1
  fi
}

check_node() {
  require_cmd node
  require_cmd npm

  local major
  major="$(node -p "process.versions.node.split('.')[0]")"
  if [ "$major" -lt 20 ]; then
    echo "peek installer error: Node.js 20 or newer is required." >&2
    exit 1
  fi
}

asset_url() {
  if [ "$VERSION" = "latest" ]; then
    printf 'https://github.com/%s/releases/latest/download/peek.tgz' "$REPO"
  else
    printf 'https://github.com/%s/releases/download/%s/peek.tgz' "$REPO" "$VERSION"
  fi
}

trap cleanup EXIT

require_cmd curl
check_node
mkdir -p "$BIN_DIR"

echo "Installing peek from $(asset_url)"
curl -fsSL "$(asset_url)" -o "$TMP_DIR/peek.tgz"
npm install --global --silent --prefix "$PREFIX" "$TMP_DIR/peek.tgz"

if ! command -v peek >/dev/null 2>&1; then
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      echo
      echo "peek was installed to $BIN_DIR, but that directory is not in your PATH."
      echo "Add this to your shell profile and restart your shell:"
      echo "  export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
fi

echo
echo "Installed peek to $BIN_DIR/peek"
echo "Run: peek --help"
