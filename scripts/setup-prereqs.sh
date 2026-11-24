#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' \
    'Usage: scripts/setup-prereqs.sh [--check | --install] [--strict] [--skip-python]' \
    '       scripts/setup-prereqs.sh --install [--dry-run] [--yes | -y]' \
    '' \
    '  --check        Report prerequisites without installing (default).' \
    '  --install      Install supported missing prerequisites, then check again.' \
    '  --dry-run      Print install commands without executing them.' \
    '  --yes, -y      Skip the install confirmation.' \
    '  --skip-python  Skip optional Python and pip checks.' \
    '  --strict       Also require Pi extensions and non-empty auth.json.' \
    '  --help, -h     Show this help.'
}

mode=check
selected_mode=
dry_run=0
yes=0
skip_python=0
strict=0
for arg in "$@"; do
  case "$arg" in
    --check|--install)
      if [[ -n "$selected_mode" && "$selected_mode" != "$arg" ]]; then
        printf '%s\n' '--check and --install are mutually exclusive.' >&2
        exit 2
      fi
      selected_mode=$arg
      mode=${arg#--}
      ;;
    --dry-run) dry_run=1 ;;
    --yes|-y) yes=1 ;;
    --skip-python) skip_python=1 ;;
    --strict) strict=1 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; usage >&2; exit 2 ;;
  esac
done
if [[ "$mode" != install ]] && (( dry_run || yes )); then
  printf '%s\n' '--dry-run and --yes require --install.' >&2
  exit 2
fi

source "$(dirname "$0")/runtime-paths.sh"
runtime_init_path
setup_os=${YAAT_SETUP_OS:-$(uname -s)}
setup_arch=${YAAT_SETUP_ARCH:-$(uname -m)}
pi_agent_dir=${YAAT_PI_AGENT_DIR:-"$HOME/.pi/agent"}
pi_cli_package=@earendil-works/pi-coding-agent
pi_extensions=(pi-subagents pi-antigravity-acp-provider)
case "$setup_os" in
  Darwin|Linux) ;;
  *) printf '[action] Unsupported platform: %s/%s (expected macOS or Linux).\n' "$setup_os" "$setup_arch" >&2; exit 1 ;;
esac

runtime_load_pins "${AGENT_TEAM_BASE_DIR:-$HOME/.yaat}"

has() { command -v "$1" >/dev/null 2>&1; }

has_pip() {
  has pip3 || PYTHONDONTWRITEBYTECODE=1 python3 -m pip --version >/dev/null 2>&1
}

# Read agent metadata without launching Pi or exposing credentials in output or parse errors.
pi_metadata_ok() {
  local kind=$1 name=${2:-}
  [[ -s "$pi_agent_dir/$kind.json" && -n ${YAAT_NODE_BIN:-} ]] || return 1
  NODE_OPTIONS= NODE_V8_COVERAGE= NODE_DISABLE_COMPILE_CACHE=1 "$YAAT_NODE_BIN" -e '
    const fs = require("fs"), path = require("path"), os = require("os");
    const [dir, kind, name] = process.argv.slice(1);
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, kind + ".json"), "utf8"));
      if (kind === "auth") {
        process.exitCode = data && typeof data === "object" && !Array.isArray(data) &&
          Object.keys(data).length > 0 ? 0 : 1;
      } else {
        const installed = Array.isArray(data.packages) && data.packages.some((entry) => {
          let source = typeof entry === "string" ? entry : entry && entry.source;
          if (typeof source !== "string" || !source || /^(npm:|git:|https?:)/.test(source)) return false;
          if (source.startsWith("~/")) source = path.join(os.homedir(), source.slice(2));
          const local = path.resolve(dir, source);
          return path.basename(local) === name && fs.existsSync(local);
        });
        process.exitCode = installed ? 0 : 1;
      }
    } catch (_) {
      process.exitCode = 1;
    }
  ' "$pi_agent_dir" "$kind" "$name" >/dev/null 2>&1
}

extension_installed() {
  [[ -d "$pi_agent_dir/npm/node_modules/$1" ]] || pi_metadata_ok settings "$1"
}

check_required_command() {
  if has "$1"; then
    printf '[ok] %s\n' "$1"
  else
    printf '[missing] %s\n' "$1"
    required_missing=1
  fi
}

check_optional_command() {
  if has "$1"; then
    printf '[ok] %s (optional)\n' "$1"
  else
    printf '[warn] %s not found (optional)\n' "$1"
  fi
}

check_prereqs() {
  local required_missing=0 pi_missing=0 pkg YAAT_NODE_BIN=${YAAT_NODE_BIN:-}
  printf '%s\n' 'Core runtime (required)'
  check_required_command git
  check_required_command curl
  if runtime_select_node; then
    printf '[ok] node (>=26, node:sqlite): %s\n' "$YAAT_NODE_BIN"
  else
    printf '[missing] usable node (>=26 required for node:sqlite): %s\n' "${YAAT_NODE_BIN:-not found}"
    YAAT_NODE_BIN=
    required_missing=1
  fi
  if runtime_select_npm; then
    printf '[ok] npm: %s\n' "$YAAT_NPM_BIN"
  else
    printf '[missing] npm: %s\n' "${YAAT_NPM_BIN:-not found}"
    required_missing=1
  fi
  # Even --version can modify a managed Pi install; inspect the launcher without running it.
  if runtime_select_pi; then
    printf '[ok] pi (%s): %s\n' "$pi_cli_package" "$YAAT_PI_BIN"
  else
    printf '[missing] pi (%s): %s\n' "$pi_cli_package" "${YAAT_PI_BIN:-not found}"
    required_missing=1
  fi

  printf '\n%s\n' 'Optional tooling'
  if [[ "$setup_os" == Darwin ]]; then check_optional_command brew; fi
  check_optional_command openssl
  if (( skip_python )); then
    printf '%s\n' '[ok] python3 and pip3 skipped (--skip-python)'
  else
    check_optional_command python3
    if has_pip; then
      printf '%s\n' '[ok] pip3 (or python3 -m pip) (optional)'
    else
      printf '%s\n' '[warn] pip3 (or python3 -m pip) not found (optional)'
    fi
  fi
  check_optional_command uv

  printf '\n%s\n' 'Pi extensions & auth'
  for pkg in "${pi_extensions[@]}"; do
    if extension_installed "$pkg"; then
      printf '[ok] %s\n' "$pkg"
    else
      printf '[missing] %s\n' "$pkg"
      pi_missing=1
    fi
  done
  if pi_metadata_ok auth; then
    printf '%s\n' '[ok] Pi auth.json (non-empty JSON object)'
  else
    printf '%s\n' '[action] Pi auth.json not verified; run pi with the same agent directory, then /login.'
    pi_missing=1
  fi

  if (( required_missing || (strict && pi_missing) )); then
    if (( required_missing )) && [[ -n ${YAAT_RUNTIME_PINS:-} ]]; then
      printf '[action] If a pinned executable moved, re-run scripts/yaat-service.sh install to re-pin %s.\n' "$YAAT_RUNTIME_PINS"
    fi
    printf '\n%s\n' 'Next: run scripts/setup-prereqs.sh --install or resolve the actions above, then recheck.'
    return 1
  fi
  if (( pi_missing )); then
    printf '\n%s\n' 'Next: finish Pi extension setup and login before starting YAAT.'
  else
    printf '\n%s\n' 'Next: configure and start YAAT.'
  fi
}

run() {
  if (( dry_run )); then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

node_and_npm_available() { runtime_select_node && runtime_select_npm; }

install_macos_deps() {
  local brew_installer=https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh installer brew_prefix need_node=0
  if [[ -z ${YAAT_RUNTIME_PINS:-} ]] && ! node_and_npm_available; then need_node=1; fi
  if ! has curl; then
    printf '%s\n' '[action] Restore macOS curl (install Command Line Tools with xcode-select --install if missing).'
  fi
  if ! (( need_node )) && has git; then return 0; fi
  if ! has brew; then
    if ! has curl; then
      printf '%s\n' '[action] Homebrew installation requires curl; restore curl before installing Homebrew.'
      macos_deps_blocked=1
      return 0
    fi
    if (( dry_run )); then
      printf '[dry-run] installer=$(curl -fsSL %s) && NONINTERACTIVE=1 /bin/bash -c "$installer"\n' "$brew_installer"
    else
      installer=$(curl -fsSL "$brew_installer")
      NONINTERACTIVE=1 /bin/bash -c "$installer"
      hash -r
    fi
    if ! (( dry_run )) && ! has brew; then
      case "$setup_arch" in
        arm64|aarch64) brew_prefix=/opt/homebrew ;;
        *) brew_prefix=/usr/local ;;
      esac
      printf '[action] Ensure Homebrew is on PATH: eval "$(%s/bin/brew shellenv)"\n' "$brew_prefix"
      macos_deps_blocked=1
      return 0
    fi
  fi

  if (( need_node )); then
    if has brew && HOMEBREW_NO_AUTO_UPDATE=1 brew list --formula node >/dev/null 2>&1; then
      run brew upgrade node
    else
      run brew install node
    fi
  fi
  if ! has git; then run brew install git; fi
}

linux_system_hints() {
  local manager cmd
  if has dnf; then
    manager='sudo dnf install'
  elif has pacman; then
    manager='sudo pacman -S --needed'
  elif has zypper; then
    manager='sudo zypper install'
  elif has apk; then
    manager='sudo apk add'
  else
    manager='sudo apt-get install' # Debian/Ubuntu example when no manager is detected.
  fi

  set --
  for cmd in git curl; do
    if ! has "$cmd"; then set -- "$@" "$cmd"; fi
  done
  if (( $# )); then printf '[action] Install system packages with your distro package manager, e.g.: %s %s\n' "$manager" "$*"; fi

  if [[ -z ${YAAT_RUNTIME_PINS:-} ]] && ! node_and_npm_available; then
    cmd=pixi
    if ! has pixi; then
      printf '%s\n' '[action] Install Pixi: curl -fsSL https://pixi.sh/install.sh | sh'
      cmd='"$HOME/.pixi/bin/pixi"'
    fi
    printf '[action] Install Node.js >=26 and npm: %s global install --environment nodejs --expose node --expose npm "nodejs>=26"\n' "$cmd"
  fi
}

install_pi() {
  local pkg
  runtime_use_paths
  if ! runtime_select_pi; then
    [[ -z ${YAAT_RUNTIME_PINS:-} ]] || return 0
    run "${YAAT_NPM_BIN:-npm}" install -g "$pi_cli_package"
    if ! (( dry_run )); then runtime_require_pi; fi
  fi
  for pkg in "${pi_extensions[@]}"; do
    if ! extension_installed "$pkg"; then
      PI_CODING_AGENT_DIR="$pi_agent_dir" run "${YAAT_PI_BIN:-pi}" install "npm:$pkg"
    fi
  done
}

if [[ "$mode" == install ]]; then
  if ! (( yes || dry_run )); then
    printf 'Install missing prerequisites for %s/%s? [y/N] ' "$setup_os" "$setup_arch"
    if ! read -r response || [[ "$response" != [yY] && "$response" != [yY][eE][sS] ]]; then
      printf '%s\n' 'Install cancelled.'
      exit 1
    fi
  fi
  macos_deps_blocked=0
  if [[ "$setup_os" == Darwin ]]; then install_macos_deps; else linux_system_hints; fi
  if node_and_npm_available || { (( dry_run )) && [[ -z ${YAAT_RUNTIME_PINS:-} && "$setup_os" == Darwin ]] && ! (( macos_deps_blocked )); }; then
    install_pi
  fi
  if (( dry_run )); then
    printf '%s\n' 'Next: rerun without --dry-run to install, or follow any [action] steps above.'
    exit 0
  fi
fi
check_prereqs
