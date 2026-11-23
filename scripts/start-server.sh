#!/usr/bin/env bash
# Start the YAAT / Agent Team server with a service-safe PATH and pre-flight checks.
set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$HOME/.pixi/envs/nodejs/bin:$HOME/.pixi/envs/default/bin:$HOME/.pixi/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/bin:/bin${PATH:+:$PATH}"

# Optional proxy configuration:
# export http_proxy=http://127.0.0.1:7890/
# export https_proxy=http://127.0.0.1:7890/

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASE_DIR="${AGENT_TEAM_BASE_DIR:-$REPO_DIR}"

if ! command -v node >/dev/null 2>&1; then
  printf 'error: node not found in PATH. Run scripts/setup-prereqs.sh to install Node.js >= 26.\n' >&2
  exit 1
fi

NODE_VER="$(node -v 2>/dev/null || true)"
NODE_MAJOR="${NODE_VER#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
case "$NODE_MAJOR" in
  ""|*[!0-9]*)
    printf 'error: could not parse Node.js version (%s). Run scripts/setup-prereqs.sh.\n' "${NODE_VER:-unknown}" >&2
    exit 1
    ;;
  *)
    if [ "$NODE_MAJOR" -lt 26 ]; then
      printf 'error: Node.js >= 26 is required (found %s). Run scripts/setup-prereqs.sh.\n' "$NODE_VER" >&2
      exit 1
    fi
    ;;
esac

if [ ! -f "$REPO_DIR/dist/server.js" ]; then
  printf 'error: %s/dist/server.js not found. Run "npm run build" in %s first.\n' "$REPO_DIR" "$REPO_DIR" >&2
  exit 1
fi

if [ ! -f "$BASE_DIR/config.toml" ]; then
  if [ -z "${AGENT_TEAM_BASE_DIR:-}" ]; then
    printf 'error: %s/config.toml not found.\n' "$BASE_DIR" >&2
    printf '  If you ran "scripts/yaat-service.sh init-config", start with: AGENT_TEAM_BASE_DIR="$HOME/.yaat" scripts/start-server.sh\n' >&2
    printf '  Or initialize config in the repo dir: scripts/yaat-service.sh init-config --base-dir %q\n' "$REPO_DIR" >&2
  else
    printf 'error: %s/config.toml not found. Run: scripts/yaat-service.sh init-config --base-dir %q\n' "$BASE_DIR" "$BASE_DIR" >&2
  fi
  exit 1
fi

cd "$REPO_DIR"
exec node dist/server.js
