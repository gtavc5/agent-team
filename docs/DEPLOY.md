# Deploying YAAT (Agent Team)

Three commands from a fresh clone:

```bash
./scripts/setup-prereqs.sh --install
npm install
./scripts/yaat-service.sh install
```

(Run `./scripts/setup-prereqs.sh` without flags first if you only want a read-only check.)

Verify the server is serving on `http://127.0.0.1:9800`:

```bash
./scripts/yaat-service.sh health
```

`install` creates `~/.yaat/config.toml` with a generated login password (printed once) and `session_secret`, builds the UI and server into `dist/`, and registers and starts the background service (`launchd` on macOS, `systemd --user` on Linux).

---

## How Deployment Is Split

- **Layer 1 — [`scripts/setup-prereqs.sh`](../scripts/setup-prereqs.sh):** one-time machine prerequisites (Node.js 26+, Pi runtime and packages).
- **Layer 2 — [`scripts/yaat-service.sh`](../scripts/yaat-service.sh) + [`scripts/start-server.sh`](../scripts/start-server.sh):** config generation, build, OS service registration, health check, and safe deferred self-redeploy.

`start-server.sh` always prepends Homebrew (`/opt/homebrew/bin`), pixi, and `~/.local/bin` to `PATH`, checks Node >= 26, `dist/server.js`, and `config.toml`, then `exec`s `node dist/server.js`.

---

## Configuration (`config.toml`)

By default `yaat-service.sh` stores runtime state, logs, and `config.toml` under `~/.yaat` (`AGENT_TEAM_BASE_DIR`). Running `node dist/server.js` directly without `AGENT_TEAM_BASE_DIR` uses the repository root instead.

Common `init-config` flags (run automatically by `install` if `config.toml` does not exist):

```bash
# Custom directory, port, or default model
./scripts/yaat-service.sh init-config --base-dir ~/.yaat --model provider/model --effort high

# Localhost-only without login prompt (defaults host to 127.0.0.1 unless --host is passed)
./scripts/yaat-service.sh install --no-auth
```

Note that `--port` and `--host` are saved in the OS service file written by `install` (`launchd` plist or `systemd` unit), not in `config.toml`.

> [!NOTE]
> Keeping `[pi]` present in `config.toml` enables startup Pi model discovery in the UI picker (`yaat-service.sh init-config` writes `[pi]` by default). When `packages` is omitted (or `packages = []`), Pi auto-discovery manages YAAT's allowlisted local/npm packages (`pi-subagents`, `pi-antigravity-acp-provider`, plus optional local skill packages) while preserving object-form resource filters from `~/.pi/agent/settings.json`; setting explicit `packages = [...]` overrides the allowlist, and `exclude_packages` blocks specific packages.

---

## macOS (`launchd`)

`install` writes `~/Library/LaunchAgents/com.yaat.server.plist` and loads it in your `gui/<uid>` domain.

- **Keychain & GUI session (`Aqua`):** the plist sets `LimitLoadToSessionType = Aqua` so the server and child agent processes run inside your desktop login session and can read the macOS login Keychain and credential helpers. Keep a GUI session logged in (or enable auto-login for headless Macs); SSH-only logins without an active Aqua session do not have a `gui/<uid>` domain.
- **In-app restart (`restart_command`):** `init-config` sets `restart_command = ["launchctl", "kickstart", "-k", "gui/<uid>/com.yaat.server"]` under `[server]` in `config.toml`. Without it, UI-triggered server restarts are disabled on macOS.
- **Logs:** written to `~/.yaat/logs/server.out.log` and `~/.yaat/logs/server.err.log` (or view with `./scripts/yaat-service.sh logs`).

---

## Linux (`systemd --user`)

`install` writes `~/.config/systemd/user/agent-team-server.service`, runs `daemon-reload`, and executes `enable --now`.

- **Logs:** view via `./scripts/yaat-service.sh logs` or `journalctl --user -u agent-team-server -f`.
- **Keep running after SSH logout:** run `loginctl enable-linger "$USER"` once if your machine does not keep user services alive when disconnected.

---

## Updating & Self-Deployment

From a normal shell outside the server:

```bash
git pull
./scripts/yaat-service.sh deploy --verify
```

`deploy --verify` runs `npm run check && npm test`, builds `dist/`, restarts the service, and waits up to 15 seconds for `http://127.0.0.1:9800/manifest.webmanifest` to return HTTP 200.

### Bootstrapping from inside an agent session (`deploy-deferred`)

An agent working inside YAAT is a child process of `node dist/server.js`. Restarting the service inline kills its own session mid-turn. Schedule a detached deferred deploy instead, then finish your response promptly:

```bash
./scripts/yaat-service.sh deploy-deferred 10
```

On Linux, `systemd-run --user --no-block --collect` enqueues a transient service in its own cgroup, so it survives the server unit's `KillMode=control-group` restart. If `systemd-run` or the user bus is unavailable, or the enqueue fails, `setsid nohup` (or just `nohup` if `setsid` is missing) detaches on a best-effort basis: it does not leave the server's cgroup. On macOS, the script detaches via `fork` + `POSIX::setsid()` in `perl`.

[`scripts/deploy-deferred.sh`](../scripts/deploy-deferred.sh) sleeps 10 seconds, runs `npm run build`, restarts `systemd --user` or `launchd` (or `~/.local/bin/agent-team-service`), and logs a best-effort health probe to `~/.cache/agent-team-deploy.log`.

---

## Running a Dev Instance

Run a second instance on another port and base directory so it never touches production `.agent-team/` state:

```bash
npm run demo -- "$PWD/.agent-team/dev"
./scripts/yaat-service.sh init-config --base-dir "$PWD/.agent-team/dev" --no-auth
AGENT_TEAM_HOST=127.0.0.1 AGENT_TEAM_PORT=9801 AGENT_TEAM_BASE_DIR="$PWD/.agent-team/dev" node dist/server.js
```

To register a separate background service for dev, pass distinct `--label`, `--port`, and `--base-dir` flags to `yaat-service.sh install`.

---

## Service CLI Reference

| Command                      | Purpose                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `init-config`                | Create base dir (`700`) and `config.toml` (`600`); keeps existing unless `--force`                        |
| `install`                    | Init config if missing, `npm run build` (unless `--no-build`), write & load service (unless `--no-start`) |
| `start` / `stop` / `restart` | Control the registered `launchd` / `systemd --user` service                                               |
| `status`                     | Print `launchctl print` or `systemctl --user status`                                                      |
| `logs`                       | Tail logs (`-n <lines>`, `--no-follow`)                                                                   |
| `health`                     | Probe `http://127.0.0.1:<port>/manifest.webmanifest` (`--wait <sec>`)                                     |
| `deploy`                     | Optional `--verify`, build (unless `--no-build`), restart, `health --wait 15`                             |
| `deploy-deferred [sec]`      | Detached build + restart after delay (default `10`)                                                       |
| `uninstall`                  | Unload and remove service file; preserves `~/.yaat` data                                                  |

Key flags: `--base-dir`, `--port`, `--host`, `--label`, `--plist-dir`, `--unit-dir`, `--model`, `--effort`, `--username`, `--password`, `--no-auth`, `--no-build`, `--no-start`, `--verify`, `--force`, `--dry-run`, `--wait`, `-n`, `--no-follow`.
