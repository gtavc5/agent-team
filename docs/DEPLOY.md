# Deploying YAAT (Agent Team)

Three commands from a fresh clone:

```bash
./scripts/setup-prereqs.sh --install
./scripts/yaat-service.sh install-deps
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

Run installation from a shell where your preferred Node 26+ and Pi are available. Service startup and deferred deploy use the instance's verified executables without loading a login shell. After removing or moving a pinned installation, run the installer again with the intended toolchain. Python/pip and OpenSSL are not server prerequisites; Node crypto can generate login secrets.

### Diagnose a new installation

Open **Service diagnostics** in the sidebar for the running service's effective settings and last model probe. **JSON** exposes the same report to an agent (`GET api/diagnostics`, with the panel's normal authentication). Each issue gives a stage, stable code, effective value/source, affected capability, and next step. Proxy values and provider credentials are not printed.

After building, you can diagnose an instance even if the service did not start:

```bash
AGENT_TEAM_BASE_DIR="$HOME/.yaat" scripts/start-server.sh --doctor
AGENT_TEAM_BASE_DIR="$HOME/.yaat" scripts/start-server.sh --doctor --json
```

This uses the instance toolchain and config, probes the real model catalog and native Codex account without a model turn, and exits nonzero if there is no usable model or config. The CLI inherits the environment of its caller: use the panel report when comparing a terminal to the actual `systemd --user` or `launchd` environment.

### Optional Antigravity ACP runtime

YAAT does not install a missing ACP runtime on startup, first prompt, or quota refresh. Other configured providers remain usable. As the service user, start standalone `pi` with `pi-antigravity-acp-provider` enabled and run `/antigravity-acp setup` to explicitly prepare the managed runtime. Alternatively, set `[pi.acp].binary` in `config.toml` to an existing executable. An invalid explicit override blocks ACP rather than selecting another binary silently.

Catalog probes use Pi's offline mode. If ACP is loaded but its runtime is missing, normal Pi sessions also skip online background model refresh: the provider can otherwise start its installer while refreshing the catalog, even for a non-ACP session. Other providers can still serve prompts. Once a runtime exists, a new session uses the configured online/offline policy; `automatic` explicitly permits managed-runtime updates.

YAAT manages `permissions` and `runtimeUpdates` in its own `pi-agent-home/antigravity-acp-provider/config.json`, not the host profile. Defaults are `yolo` (commands and edits without confirmation) and `manual` (no automatic runtime upgrades). To request confirmation, set `[pi.acp].permissions = "default"`. With a custom runtime, diagnostics report enforcement as **unverified**. Configure outbound proxies in `[server.proxy]`; see `config.example.toml`. Restart the service after changing these ACP or proxy settings.

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
| `install-deps`               | Install checkout dependencies with the selected Node and npm                                              |
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
