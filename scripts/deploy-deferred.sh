#!/usr/bin/env bash
# Build and restart the server after a short delay, detached from the caller.
# Used when the request comes from an agent running inside this very server:
# the delay lets its turn finish before the restart kills the session.
# Prefer launching via: scripts/yaat-service.sh deploy-deferred [delay-seconds]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$REPO_DIR/scripts/runtime-paths.sh"
runtime_init_path

DELAY="${1:-10}"
sleep "$DELAY"

cd "$REPO_DIR" || exit 1
BASE_DIR="${AGENT_TEAM_BASE_DIR:-$HOME/.yaat}"

LOG="${YAAT_DEPLOY_LOG:-$HOME/.cache/agent-team-deploy.log}"
mkdir -p "$(dirname "$LOG")"

OS_NAME="${YAAT_SERVICE_OS:-$(uname -s)}"
UID_VAL="${YAAT_UID:-$(id -u)}"
PORT="${AGENT_TEAM_PORT:-9800}"
LAUNCHCTL_BIN="${YAAT_LAUNCHCTL_BIN:-launchctl}"
SYSTEMCTL_BIN="${YAAT_SYSTEMCTL_BIN:-systemctl}"
if [ -n "${YAAT_SERVICE_LABEL:-}" ]; then
  LABEL="$YAAT_SERVICE_LABEL"
elif [ "$OS_NAME" = "Darwin" ]; then
  LABEL="com.yaat.server"
else
  LABEL="agent-team-server"
fi
if [ "$OS_NAME" = "Darwin" ]; then
  LABEL="${LABEL%.plist}"
else
  LABEL="${LABEL%.service}"
fi
PLIST_DIR="${YAAT_PLIST_DIR:-$HOME/Library/LaunchAgents}"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
UNIT_DIR="${YAAT_UNIT_DIR:-$HOME/.config/systemd/user}"

{
  printf '=== %s build %s\n' "$(date)" "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  runtime_load_pins "$BASE_DIR"
  runtime_require_node
  runtime_select_pi || true
  if [ -n "${YAAT_DEPLOY_SKIP_BUILD:-}" ] && [ "${YAAT_DEPLOY_SKIP_BUILD:-}" != "0" ]; then
    runtime_use_paths
    printf '=== build skipped (YAAT_DEPLOY_SKIP_BUILD=%s)\n' "$YAAT_DEPLOY_SKIP_BUILD"
  else
    runtime_require_npm
    runtime_use_paths
    "$YAAT_NPM_BIN" run build || exit 1
    printf '=== build ok, restarting\n'
  fi

  if [ -n "${YAAT_DEPLOY_RESTART_CMD:-}" ]; then
    bash -c "$YAAT_DEPLOY_RESTART_CMD" || exit 1
  elif [ "$OS_NAME" = "Linux" ] && command -v "$SYSTEMCTL_BIN" >/dev/null 2>&1 && \
    [ "$("$SYSTEMCTL_BIN" --user show -p LoadState --value "$LABEL" 2>/dev/null || true)" = "loaded" ]; then
    "$REPO_DIR/scripts/yaat-service.sh" --label "$LABEL" --unit-dir "$UNIT_DIR" restart || exit 1
  elif [ "$OS_NAME" = "Darwin" ] && command -v "$LAUNCHCTL_BIN" >/dev/null 2>&1 && \
    { "$LAUNCHCTL_BIN" print "gui/${UID_VAL}/${LABEL}" >/dev/null 2>&1 || [ -f "$PLIST_PATH" ]; }; then
    "$REPO_DIR/scripts/yaat-service.sh" --label "$LABEL" --plist-dir "$PLIST_DIR" restart || exit 1
  elif [ -x "$HOME/.local/bin/agent-team-service" ]; then
    "$HOME/.local/bin/agent-team-service" restart || exit 1
  else
    printf '=== no supported service manager found; server was not restarted\n'
    exit 1
  fi

  printf '=== restarted\n'
  if "$REPO_DIR/scripts/yaat-service.sh" --port "$PORT" health --wait 15; then
    printf '=== health check ok\n'
  else
    printf '=== health check timed out (best-effort probe)\n'
  fi
} >>"$LOG" 2>&1
