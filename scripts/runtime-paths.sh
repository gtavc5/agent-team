# Shared Bash executable discovery and per-instance pins. Never source a pin file.

runtime_init_path() {
  runtime_checkout_dir=$(CDPATH= cd -P -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
  if [[ ${YAAT_NO_DEFAULT_PATH:-0} != 1 ]]; then
    export PATH="${PATH:+$PATH:}/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$HOME/.local/bin:$HOME/.pi/agent/bin:$HOME/.pixi/envs/nodejs/bin:$HOME/.pixi/envs/default/bin:$HOME/.pixi/bin:$HOME/.cargo/bin:/usr/bin:/bin"
  fi
}

runtime_path_valid() {
  [[ $1 = /* && $1 != *:* && $1 != *[[:cntrl:]]* ]]
}

runtime_executable() {
  runtime_path_valid "$1" && [[ -f $1 && -x $1 ]]
}

runtime_node_supported() {
  local version
  runtime_executable "$1" || return 1
  version=$(NODE_OPTIONS= NODE_V8_COVERAGE= NODE_DISABLE_COMPILE_CACHE=1 "$1" --version 2>/dev/null) || return 1
  [[ $version =~ ^v?([0-9]+)\.[0-9]+\.[0-9]+$ ]] && (( 10#${BASH_REMATCH[1]} >= 26 ))
}

runtime_mise_shim() {
  local data_dir=${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}
  [[ ${1%/*} = "${data_dir%/}/shims" || $1 = */mise/shims/* ]]
}

runtime_resolve_bin() {
  local candidate=$1 name=${1##*/} dir link hops=0 shim_resolved=0
  while runtime_executable "$candidate" && (( hops < 40 )); do
    if runtime_mise_shim "$candidate"; then
      # Resolve the shim in the checkout, not the caller's directory, without installing.
      (( ! shim_resolved )) || return 1
      candidate=$(cd -- "$runtime_checkout_dir" &&
        MISE_AUTO_INSTALL=0 MISE_NOT_FOUND_AUTO_INSTALL=0 mise which "$name" </dev/null 2>/dev/null) || return 1
      [[ ${candidate##*/} = "$name" ]] || return 1
      shim_resolved=1
      continue
    fi

    dir=$(CDPATH= cd -P -- "${candidate%/*}/" 2>/dev/null && pwd -P) || return 1
    if [[ $candidate != "${dir%/}/$name" ]]; then
      candidate="${dir%/}/$name"
      hops=$((hops + 1))
      continue
    fi

    # Follow same-name aliases out of fnm multishell bins (or into a mise shim).
    # Keep npm/Pi's actual bin entry when it links to a differently named package file.
    if [[ -L $candidate ]]; then
      link=$(readlink "$candidate") || return 1
      if [[ ${link##*/} = "$name" ]]; then
        case "$link" in /*) candidate=$link ;; *) candidate="${dir%/}/$link" ;; esac
        hops=$((hops + 1))
        continue
      fi
    fi
    case "$candidate" in */fnm_multishells/*) return 1 ;; esac
    if [[ -n ${FNM_MULTISHELL_PATH:-} && $candidate = "${FNM_MULTISHELL_PATH%/}/"* ]]; then
      return 1
    fi
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}

runtime_find() {
  local name=$1 check=$2 dir candidate data_home=${XDG_DATA_HOME:-$HOME/.local/share}
  local dirs=()
  IFS=: read -r -a dirs <<< "${PATH:-:}"
  if [[ -n ${NVM_BIN:-} ]]; then dirs+=("$NVM_BIN"); fi
  if [[ -n ${FNM_MULTISHELL_PATH:-} ]]; then dirs+=("${FNM_MULTISHELL_PATH%/}/bin"); fi
  # Fall back to installed versions when a shell profile did not activate a version manager.
  for dir in "${dirs[@]}" "${NVM_DIR:-$HOME/.nvm}"/versions/node/v*/bin \
      "${FNM_DIR:-$data_home/fnm}"/node-versions/v*/installation/bin \
      "$HOME/Library/Application Support/fnm"/node-versions/v*/installation/bin \
      "${MISE_DATA_DIR:-$data_home/mise}"/installs/node/*/bin \
      "${MISE_DATA_DIR:-$data_home/mise}"/installs/npm-earendil-works-pi-coding-agent/*/bin; do
    [[ -n $dir ]] || continue
    [[ $dir = /* ]] || dir="$PWD/$dir"
    candidate=$(runtime_resolve_bin "${dir%/}/$name") || continue
    if "$check" "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

runtime_select_bin() {
  local name=$1 check=$2 candidate=$3
  if [[ -n $candidate ]]; then
    if [[ -z ${YAAT_RUNTIME_PINS:-} || -n ${runtime_install_cwd:-} ]]; then
      candidate=$(runtime_resolve_bin "$candidate") || return 1
    fi
    "$check" "$candidate" && printf '%s\n' "$candidate"
  elif [[ $name != node && -n ${YAAT_NODE_BIN:-} ]] &&
      candidate=$(runtime_resolve_bin "${YAAT_NODE_BIN%/*}/$name") && "$check" "$candidate"; then
    printf '%s\n' "$candidate"
  else
    runtime_find "$name" "$check"
  fi
}

runtime_select_node() {
  local candidate
  candidate=$(runtime_select_bin node runtime_node_supported "${YAAT_NODE_BIN:-}") || return 1
  export YAAT_NODE_BIN="$candidate"
}

runtime_select_npm() {
  local candidate
  candidate=$(runtime_select_bin npm runtime_executable "${YAAT_NPM_BIN:-}") || return 1
  export YAAT_NPM_BIN="$candidate"
}

runtime_select_pi() {
  local candidate
  candidate=$(runtime_select_bin pi runtime_executable "${YAAT_PI_BIN:-}") || return 1
  export YAAT_PI_BIN="$candidate"
}

runtime_use_paths() {
  # npm and Pi often use /usr/bin/env node. Keep the verified Node bin first.
  local bin
  for bin in "${YAAT_PI_BIN:-}" "${YAAT_NPM_BIN:-}" "${YAAT_NODE_BIN:-}"; do
    if runtime_executable "$bin"; then PATH="${bin%/*}:$PATH"; fi
  done
  export PATH
}

runtime_require_node() {
  if ! runtime_select_node; then
    printf 'error: Node.js >= 26 is required (executable: %s). Run scripts/setup-prereqs.sh --check.\n' "${YAAT_NODE_BIN:-not found}" >&2
    return 1
  fi
}

runtime_require_npm() {
  if ! runtime_select_npm; then
    printf 'error: npm is required (executable: %s). Run scripts/setup-prereqs.sh --check.\n' "${YAAT_NPM_BIN:-not found}" >&2
    return 1
  fi
}

runtime_require_pi() {
  if ! runtime_select_pi; then
    printf 'error: Pi is required (executable: %s). Run scripts/setup-prereqs.sh --check.\n' "${YAAT_PI_BIN:-not found}" >&2
    return 1
  fi
}

runtime_load_pins() {
  local file="$1/.yaat-runtime-paths" node_bin npm_bin pi_bin extra
  unset YAAT_RUNTIME_PINS
  if [[ $file != /* ]]; then file="$PWD/$file"; fi
  if [[ ! -e $file && ! -L $file ]]; then return 0; fi
  if [[ -f $file && -r $file ]] && {
    IFS= read -r node_bin && IFS= read -r npm_bin && IFS= read -r pi_bin &&
      ! IFS= read -r extra && [[ -z $extra ]];
  } < "$file" &&
    runtime_path_valid "$node_bin" && runtime_path_valid "$npm_bin" && runtime_path_valid "$pi_bin"; then
    export YAAT_RUNTIME_PINS="$file"
    export YAAT_NODE_BIN="$node_bin" YAAT_NPM_BIN="$npm_bin" YAAT_PI_BIN="$pi_bin"
  else
    printf 'error: invalid runtime pins in %s; re-run scripts/yaat-service.sh install to re-pin.\n' "$file" >&2
    return 1
  fi
}

runtime_write_pins() (
  local file="$1/.yaat-runtime-paths" tmp
  [[ ! -d $file ]] || { printf 'error: runtime pin path is a directory: %s\n' "$file" >&2; return 1; }
  tmp=$(mktemp "$file.XXXXXX") || return 1
  trap 'rm -f -- "$tmp"' EXIT
  printf '%s\n' "$YAAT_NODE_BIN" "$YAAT_NPM_BIN" "$YAAT_PI_BIN" > "$tmp" && mv -f -- "$tmp" "$file"
)
