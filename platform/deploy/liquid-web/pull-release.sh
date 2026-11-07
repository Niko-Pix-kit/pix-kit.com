#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[[ $# == 4 ]] || fail "Usage: $0 RELEASE_REF EXPECTED_COMMIT /absolute/path/to/private /absolute/path/to/node"
release_ref=$1
expected_commit=$2
[[ $release_ref == refs/heads/main || $release_ref == refs/heads/release/liquid-web ||
   $release_ref == refs/tags/* ]] || fail 'Select main, release/liquid-web, or an explicit tag.'
git check-ref-format "$release_ref" || fail 'Invalid release ref.'
[[ $expected_commit =~ ^[0-9a-f]{40}$ ]] || fail 'Provide the full CI-verified commit SHA.'
[[ $3 == /* && $4 == /* ]] || fail 'Use absolute paths for the private directory and Node binary.'
private_dir=$(realpath -e -- "$3")
node_bin=$(realpath -e -- "$4")
[[ -d $private_dir && -O $private_dir && $(stat -c %a -- "$private_dir") == 700 ]] ||
  fail 'The private directory must belong to this account and have mode 0700.'
[[ -f $node_bin && -x $node_bin ]] || fail 'Node binary is missing or is not executable.'
export PATH="$(dirname -- "$node_bin"):$PATH"
export GIT_TERMINAL_PROMPT=0

releases="$HOME/.pixkit/releases"
mkdir -p -- "$releases"
[[ -O $releases && ! -L $releases ]] ||
  fail 'The release directory must belong to this account and must not be a symlink.'
chmod 00700 -- "$releases"
exec 9> "$releases/.pull.lock"
flock -n 9 || fail 'Another release pull is running.'

release="$releases/$expected_commit"
if [[ -e $release || -L $release ]]; then
  [[ -d $release && -O $release && ! -L $release &&
     $(git -C "$release" rev-parse HEAD) == "$expected_commit" ]] || fail 'Invalid staged checkout.'
  printf 'Release already staged at %s\n' "$release"
  exit
fi

stage=$(mktemp -d -- "$releases/.stage.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git -C "$stage" init --quiet --template=
git -C "$stage" fetch --quiet --depth=1 --no-tags \
  https://github.com/Niko-Pix-kit/pix-kit.com.git "$release_ref"
fetched_commit=$(git -C "$stage" rev-parse 'FETCH_HEAD^{commit}')
[[ $fetched_commit == "$expected_commit" ]] || fail 'Fetched commit differs from the selected CI-verified commit.'
git -C "$stage" -c core.hooksPath=/dev/null checkout --quiet --detach "$expected_commit"
npm ci --prefix "$stage/platform" --omit=dev --ignore-scripts --no-audit --no-fund
bash "$stage/platform/deploy/liquid-web/activate-mariadb.sh" check "$private_dir" "$node_bin"
mv -T -- "$stage" "$release"
printf 'Release staged at %s\n' "$release"
