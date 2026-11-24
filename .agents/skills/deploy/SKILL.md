---
name: deploy
description: Build and restart the production agent-team server safely from inside a session, watch the deploy log, and verify the server came back. Read BEFORE any build/restart/redeploy or when asked whether the server restarted.
---

# Deploy

Production is `node dist/server.js` (default port `9800`), run by:

- **macOS:** `launchd` agent `com.yaat.server` in `gui/$(id -u)` (managed via `scripts/yaat-service.sh`)
- **Linux:** `agent-team-server.service` (`systemd --user`, managed via `scripts/yaat-service.sh`), or `~/.local/bin/agent-team-service supervise` on machines without a systemd user bus

Every agent session — including the one running this request — is a child process of that server. A restart kills the requesting session mid-turn, so restarts are always deferred and detached.

## Confirm who you are

Linux:

```bash
pid=$(systemctl --user show -p MainPID --value "${YAAT_SERVICE_LABEL:-agent-team-server}" 2>/dev/null)
[[ $pid =~ ^[1-9] ]] || pid=$(pgrep -f '^\S*node dist/server.js' -o); echo server=$pid
pgrep -P "$pid" | wc -l                       # live agent sessions (you are one)
grep -qa "AGENT_TEAM" /proc/$$/environ && echo "running inside the server"
```

macOS:

```bash
pid=$(launchctl print "gui/$(id -u)/${YAAT_SERVICE_LABEL:-com.yaat.server}" 2>/dev/null | awk '/pid =/{print $3; exit}')
[[ $pid =~ ^[1-9] ]] || pid=$(pgrep -f 'node dist/server.js' -o); echo server=$pid
pgrep -P "$pid" | wc -l                       # live agent sessions (you are one)
ps eww -p $$ | grep -q "AGENT_TEAM_" && echo "running inside the server"
```

A "busy agent" seen in the UI while you are working is usually you. Never conclude the server is idle from the panel.

## Redeploy

Only when the user asked for a restart in this turn. Finish all edits, run `npm run check && npm test` first, then:

```bash
./scripts/yaat-service.sh deploy-deferred 10
```

On Linux, `yaat-service.sh deploy-deferred` uses `systemd-run --user --no-block --collect` to enqueue a transient service in its own cgroup, outside the server unit's `KillMode=control-group`. If `systemd-run` or the user bus is unavailable, or enqueueing fails, it falls back to best-effort `setsid nohup` (or just `nohup` if `setsid` is missing); the fallback does not leave the server's cgroup. On macOS, it detaches via `perl` `fork` + `POSIX::setsid()`.

When running inside a `yaat-service.sh`-installed service, `yaat-service.sh` automatically inherits `YAAT_SERVICE_LABEL`, `AGENT_TEAM_PORT`, `YAAT_PLIST_DIR`, `YAAT_UNIT_DIR`, and `AGENT_TEAM_BASE_DIR` from the service environment so custom instances redeploy themselves without extra flags. The script sleeps, runs `npm run build`, restarts via `YAAT_DEPLOY_RESTART_CMD` -> `systemd --user` -> macOS `launchd` -> `~/.local/bin/agent-team-service`, logs to `~/.cache/agent-team-deploy.log`, and probes `http://127.0.0.1:${AGENT_TEAM_PORT:-9800}/manifest.webmanifest`. It lives in the repo on purpose: `/tmp` gets wiped and a script placed there once silently never ran. End your turn promptly after scheduling — the delay only has to outlast your final message.

If the user said "先别重启" (don't restart yet), commit and stop; schedule nothing.

## Verify (next turn, or when asked "重启了吗")

```bash
tail -25 ~/.cache/agent-team-deploy.log        # "=== build ok, restarting" / "=== restarted" / "=== health check ok"
./scripts/yaat-service.sh health
./scripts/yaat-service.sh status
ls -l dist/server.js
```

On Linux you can also inspect `systemctl --user show -p ActiveEnterTimestamp -p MainPID "${YAAT_SERVICE_LABEL:-agent-team-server}"`; on macOS `launchctl print "gui/$(id -u)/${YAAT_SERVICE_LABEL:-com.yaat.server}"` shows the active PID and run state. Compare the service start time with the log's timestamp and `dist/server.js` mtime with your last commit. If the log has no entry after your commit, the deferred script did not run: reschedule, don't assume.

## Testing a build without touching production

Run a second instance on another port with its **own base dir and its own build**. Without `AGENT_TEAM_BASE_DIR` it would read and write production's data (the repo root's `.agent-team/`, or `~/.yaat` when using `yaat-service.sh`); built into `dist/`, production would serve the new bundle.

```bash
D=$PWD/.agent-team/dev-9801
./scripts/yaat-service.sh init-config --base-dir "$D" --no-auth
(cd webview && npx vite build --outDir "$D/build/webview" --emptyOutDir)
npx esbuild service/src/index.ts --bundle --format=cjs --platform=node --target=node26 \
  --outfile="$D/build/server.js" --external:@anthropic-ai/claude-agent-sdk --external:@cursor/sdk
npm run demo -- "$D"                            # optional, on an empty base dir: demo project and history
AGENT_TEAM_HOST=127.0.0.1 AGENT_TEAM_PORT=9801 AGENT_TEAM_BASE_DIR=$D node "$D/build/server.js" > /tmp/agent-team-9801.log 2>&1 &
```

Stop it by PID (`kill $!`), never with `pkill -f` on the command line — that pattern matches your own shell. Writing to an agent there starts a real session on the user's account.

## Never

- `systemctl restart` / `launchctl kickstart` / `kill` the server inline.
- Restart without `npm run check && npm test` green.
- Trust "没有活跃的进程" without `pgrep -P` — the count has been wrong before.
