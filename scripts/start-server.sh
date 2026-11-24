#!/usr/bin/env bash
# Start the YAAT / Agent Team server with a service-safe PATH and pre-flight checks.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASE_DIR="${AGENT_TEAM_BASE_DIR:-$REPO_DIR}"
source "$REPO_DIR/scripts/runtime-paths.sh"
runtime_init_path
runtime_load_pins "$BASE_DIR"
runtime_require_node

if [ ! -f "$REPO_DIR/dist/server.js" ]; then
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
exec "$YAAT_NODE_BIN" dist/server.js "$@"
