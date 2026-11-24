#!/usr/bin/env bash
# Start the YAAT / Agent Team server with a service-safe PATH and pre-flight checks.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
BASE_DIR="${AGENT_TEAM_BASE_DIR:-$REPO_DIR}"
source "$REPO_DIR/scripts/runtime-paths.sh"
runtime_init_path
runtime_load_pins "$BASE_DIR"
runtime_require_node

RELEASE_DIR="$REPO_DIR/dist"
RELEASES="$REPO_DIR/.agent-team/releases"
if [ -e "$RELEASES/current" ] || [ -L "$RELEASES/current" ]; then
  [ -L "$RELEASES/current" ] || { echo 'Invalid current release pointer' >&2; exit 1; }
  RELEASE_DIR="$(cd "$RELEASES/current" && pwd -P)"
  [ "$(dirname "$RELEASE_DIR")" = "$RELEASES" ] && [[ "$(basename "$RELEASE_DIR")" =~ ^gen-[a-zA-Z0-9-]+$ ]] || {
    echo 'Invalid current release generation' >&2; exit 1;
  }
  # Staged servers must serve their own immutable web assets.
  unset AGENT_TEAM_WEB_DIR
fi
if [ ! -f "$RELEASE_DIR/server.js" ]; then
  printf 'error: %s/dist/server.js not found. Run "npm run build" in %s first.\n' "$REPO_DIR" "$REPO_DIR" >&2
  exit 1
fi

doctor=0
for arg in "$@"; do
  if [ "$arg" = --doctor ]; then doctor=1; break; fi
done

if [ "$doctor" -eq 0 ] && [ ! -f "$BASE_DIR/config.toml" ]; then
  if [ -z "${AGENT_TEAM_BASE_DIR:-}" ]; then
    printf 'error: %s/config.toml not found.\n' "$BASE_DIR" >&2
    printf '  If you ran "scripts/yaat-service.sh init-config", start with: AGENT_TEAM_BASE_DIR="$HOME/.yaat" scripts/start-server.sh\n' >&2
    printf '  Or initialize config in the repo dir: scripts/yaat-service.sh init-config --base-dir %q\n' "$REPO_DIR" >&2
  else
    printf 'error: %s/config.toml not found. Run: scripts/yaat-service.sh init-config --base-dir %q\n' "$BASE_DIR" "$BASE_DIR" >&2
  fi
  exit 1
fi

# Preserve missing Pi pins so the server can report degraded Pi without affecting Codex.
runtime_select_pi || true
runtime_use_paths
cd "$REPO_DIR"
export AGENT_TEAM_INSTALLED_REPO="$REPO_DIR" AGENT_TEAM_BASE_DIR="$(cd "$BASE_DIR" && pwd -P)"
exec "$YAAT_NODE_BIN" "$RELEASE_DIR/server.js" "$@"
