#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

[[ $# -eq 2 && $1 == /* && $2 == /* && -t 0 ]] || {
  printf '%s\n' "Usage: $0 /absolute/path/to/private /absolute/path/to/node (interactive terminal required)" >&2
  exit 1
}
private_dir=$1
node_bin=$(realpath -e -- "$2")
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cleanup() { unset smtp_host smtp_port smtp_user smtp_from smtp_password; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

read -r -p 'SMTP host [smtp.gmail.com]: ' smtp_host
read -r -p 'SMTP port [465]: ' smtp_port
read -r -p 'SMTP username (primary mailbox, not an alias): ' smtp_user
read -r -p 'From address [existing setting or info@pix-kit.com]: ' smtp_from
IFS= read -r -s -p 'SMTP app password (hidden): ' smtp_password
builtin printf '\n'
builtin printf '%s\0' "${smtp_host:-smtp.gmail.com}" "${smtp_port:-465}" \
  "$smtp_user" "$smtp_from" "$smtp_password" |
  "$node_bin" "$script_dir/configure-smtp.mjs" "$private_dir"
