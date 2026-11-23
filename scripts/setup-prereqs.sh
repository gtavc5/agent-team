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
    '  --skip-python  Do not require or install Python and pip.' \
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

if [[ ${YAAT_NO_DEFAULT_PATH:-0} != 1 ]]; then
  export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$HOME/.local/bin:$HOME/.pixi/envs/nodejs/bin:$HOME/.pixi/bin:$PATH"
fi
setup_os=${YAAT_SETUP_OS:-$(uname -s)}
setup_arch=${YAAT_SETUP_ARCH:-$(uname -m)}
pi_agent_dir=${YAAT_PI_AGENT_DIR:-"$HOME/.pi/agent"}
pi_cli_package=@earendil-works/pi-coding-agent
pi_extensions=(pi-subagents pi-antigravity-acp-provider)
case "$setup_os" in
  Darwin|Linux) ;;
  *) printf '[action] Unsupported platform: %s/%s (expected macOS or Linux).\n' "$setup_os" "$setup_arch" >&2; exit 1 ;;
esac

has() { command -v "$1" >/dev/null 2>&1; }

node_supported() {
  local version
  version=$(node --version 2>/dev/null) || return 1
  [[ $version =~ ^v?([0-9]+)\. ]] && (( 10#${BASH_REMATCH[1]} >= 26 ))
}

has_pip() {
  has pip3 || PYTHONDONTWRITEBYTECODE=1 python3 -m pip --version >/dev/null 2>&1
}

# Read agent metadata without launching Pi or exposing credentials in output or parse errors.
pi_metadata_ok() {
  local kind=$1 name=${2:-}
  [[ -s "$pi_agent_dir/$kind.json" ]] && has node || return 1
  NODE_OPTIONS= NODE_V8_COVERAGE= NODE_DISABLE_COMPILE_CACHE=1 node -e '
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

check_command() {
  local label=${2:-$1}
  if has "$1"; then
    printf '[ok] %s\n' "$label"
  else
    printf '[missing] %s\n' "$label"
    required_missing=1
  fi
}

check_prereqs() {
  local required_missing=0 pi_missing=0 pkg
  printf '%s\n' 'Core runtime (required)'
  if [[ "$setup_os" == Darwin ]]; then check_command brew; fi
  check_command git
  check_command curl
  check_command openssl
  if ! has node; then
    printf '%s\n' '[missing] node (>=26 required for node:sqlite)'
    required_missing=1
  elif ! node_supported; then
    printf '%s\n' '[outdated] node (>=26 required for node:sqlite)'
    required_missing=1
  else
    printf '%s\n' '[ok] node (>=26, node:sqlite)'
  fi
  check_command npm
  check_command pi "pi ($pi_cli_package)"

  printf '\n%s\n' 'Python/Pip tooling'
  if (( skip_python )); then
    printf '%s\n' '[ok] python3 and pip3 skipped (--skip-python)'
  else
    check_command python3
    if has_pip; then
      printf '%s\n' '[ok] pip3 (or python3 -m pip)'
    else
      printf '%s\n' '[missing] pip3 (or python3 -m pip)'
      required_missing=1
    fi
  fi
  if has uv; then
    printf '%s\n' '[ok] uv (optional)'
  else
    printf '%s\n' '[warn] uv not found (optional)'
  fi

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

install_macos_deps() {
  local brew_installer=https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh installer brew_prefix
  if ! has curl; then
    printf '%s\n' '[action] Restore macOS curl (install Command Line Tools with xcode-select --install if missing).'
    if ! has brew; then
      printf '%s\n' '[action] Homebrew installation requires curl; restore curl before installing Homebrew.'
      macos_deps_blocked=1
      return 0
    fi
  fi
  if ! has brew; then
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

  if ! node_supported || ! has npm; then
    if has brew && brew list --formula node >/dev/null 2>&1; then
      run brew upgrade node
    else
      run brew install node
    fi
  fi
  if ! has git; then run brew install git; fi
  if ! has openssl; then
    run brew install openssl
    if ! (( dry_run )) && ! has openssl; then
      export PATH="$(brew --prefix openssl)/bin:$PATH"
    fi
  fi
  if ! (( skip_python )) && { ! has python3 || ! has_pip; }; then
    run brew install python
  fi
}

linux_system_hints() {
  local manager python_pkg=python3 pip_pkg=python3-pip cmd
  if has dnf; then
    manager='sudo dnf install'
  elif has pacman; then
    manager='sudo pacman -S --needed'
    python_pkg=python pip_pkg=python-pip
  elif has zypper; then
    manager='sudo zypper install'
  elif has apk; then
    manager='sudo apk add'
    pip_pkg=py3-pip
  else
    manager='sudo apt-get install' # Debian/Ubuntu example when no manager is detected.
  fi

  set --
  for cmd in git curl openssl; do
    if ! has "$cmd"; then set -- "$@" "$cmd"; fi
  done
  if ! (( skip_python )); then
    if ! has python3; then set -- "$@" "$python_pkg"; fi
    if ! has_pip; then set -- "$@" "$pip_pkg"; fi
  fi
  if (( $# )); then printf '[action] Install system packages with your distro package manager, e.g.: %s %s\n' "$manager" "$*"; fi

  if ! node_supported || ! has npm; then
    cmd=pixi
    if ! has pixi; then
      printf '%s\n' '[action] Install Pixi: curl -fsSL https://pixi.sh/install.sh | sh'
      cmd='"$HOME/.pixi/bin/pixi"'
    fi
    printf '[action] Install Node.js >=26 and npm: %s global install --environment nodejs --expose node --expose npm "nodejs>=26"\n' "$cmd"
  fi
  if ! (( skip_python )) && ! has uv; then
    printf '%s\n' '[action] Optional uv: curl -fsSL https://astral.sh/uv/install.sh | sh'
  fi
}

install_pi() {
  local pkg
  if ! has pi; then run npm install -g "$pi_cli_package"; fi
  for pkg in "${pi_extensions[@]}"; do
    if ! extension_installed "$pkg"; then
      PI_CODING_AGENT_DIR="$pi_agent_dir" run pi install "npm:$pkg"
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
  if { node_supported && has npm; } || { (( dry_run )) && [[ "$setup_os" == Darwin ]] && ! (( macos_deps_blocked )); }; then
    install_pi
  fi
  if (( dry_run )); then
    printf '%s\n' 'Next: rerun without --dry-run to install, or follow any [action] steps above.'
    exit 0
  fi
fi
check_prereqs
