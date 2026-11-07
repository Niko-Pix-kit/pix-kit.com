#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[[ $# -eq 3 ]] || fail "Usage: $0 EXPECTED_COMMIT /absolute/path/to/private /absolute/path/to/node"
expected=$1
[[ $expected =~ ^[0-9a-f]{40}$ && $2 == /* && $3 == /* ]] || fail 'Provide the full verified commit and absolute paths.'
private_dir=$(realpath -e -- "$2")
node_bin=$(realpath -e -- "$3")
pixkit_root=$(realpath -e -- "$HOME/.pixkit")
checkout=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)
deploy="$checkout/platform/deploy/liquid-web"
env_file="$private_dir/pixkit-mariadb.env"
pid_file="$private_dir/pixkit-mariadb.pid"
socket="$private_dir/pixkit.sock"
site=$(dirname -- "$private_dir")
public_dir="$site/html"

[[ -d $private_dir && -O $private_dir && $(stat -c %a -- "$private_dir") == 700 ]] ||
  fail 'The private directory must belong to this account and have mode 0700.'
[[ -d $pixkit_root && -O $pixkit_root && -O $checkout && $checkout == "$pixkit_root/releases/$expected" ]] ||
  fail 'Run this helper from the staged release under .pixkit/releases/EXPECTED_COMMIT.'
[[ $(git -C "$checkout" rev-parse HEAD) == "$expected" &&
   -z $(git -C "$checkout" status --porcelain --untracked-files=normal) ]] ||
  fail 'The staged checkout differs from the selected verified commit.'
[[ -x $node_bin && -f $env_file && ! -L $env_file && -O $env_file &&
   $(stat -c %a -- "$env_file") == 600 ]] || fail 'Node or the private configuration is invalid.'
for file in "$public_dir/index.php" "$public_dir/.htaccess" "$private_dir/pixkit-gateway-origin"; do
  [[ -f $file && ! -L $file && -O $file ]] || fail 'The existing gateway files require inspection.'
done
[[ $(cat -- "$private_dir/pixkit-gateway-origin") == https://pix-kit.com ]] || fail 'The gateway must use https://pix-kit.com.'
lock="$private_dir/pixkit-upgrade.lock"
[[ ! -L $lock && ( ! -e $lock || ( -f $lock && -O $lock ) ) ]] || fail 'The upgrade lock requires inspection.'
exec 9> "$lock"
flock -n 9 || fail 'Another release upgrade is running.'

recorded_pid=
recorded_server=
read_process() {
  local -a args=()
  [[ -f $pid_file && ! -L $pid_file && -O $pid_file ]] || return 1
  read -r recorded_pid < "$pid_file" || return 1
  [[ $recorded_pid =~ ^[1-9][0-9]*$ && -O /proc/$recorded_pid ]] || return 1
  mapfile -d '' -t args < "/proc/$recorded_pid/cmdline" || return 1
  [[ ${#args[@]} -eq 3 && ${args[0]} == "$node_bin" &&
     ${args[1]} == "--env-file=$env_file" && ${args[2]} == "$pixkit_root/"*/platform/server/node.mjs ]] || return 1
  recorded_server=${args[2]}
  [[ -f $recorded_server && -O $recorded_server && $(realpath -e -- "$recorded_server") == "$recorded_server" ]]
}
read_process || fail 'The recorded process is not an owned PixKit release using this private configuration.'
old_pid=$recorded_pid
old_server=$recorded_server
old_deploy="${old_server%/platform/server/node.mjs}/platform/deploy/liquid-web"
[[ -f $old_deploy/activate-mariadb.sh && ! -L $old_deploy/activate-mariadb.sh &&
   -O $old_deploy/activate-mariadb.sh ]] || fail 'The previous release launcher requires inspection.'

wait_stopped() {
  local attempt
  for attempt in {1..40}; do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.25
  done
  return 1
}
start_release() {
  nohup env -u PIXKIT_ORIGIN -u PIXKIT_SOCKET -u PIXKIT_DB_SOCKET \
    -u PIXKIT_EMAIL_FROM -u PIXKIT_EMAIL_OTP_SECRET -u PIXKIT_EMAIL_SENDMAIL \
    -u PIXKIT_EMAIL_TRANSPORT -u PIXKIT_SMTP_HOST -u PIXKIT_SMTP_PORT \
    -u PIXKIT_SMTP_USER -u PIXKIT_SMTP_PASSWORD \
    bash "$1/activate-mariadb.sh" start "$private_dir" "$node_bin" \
    >> "$private_dir/pixkit-mariadb.log" 2>&1 < /dev/null 9>&- &
}
ready() {
  local attempt server=$1
  for attempt in {1..40}; do
    if read_process && [[ $recorded_server == "$server" ]] &&
      curl --noproxy '*' --unix-socket "$socket" --max-time 2 -fsS -o /dev/null \
        http://localhost/account/ 2>/dev/null
    then
      return 0
    fi
    sleep 0.25
  done
  return 1
}
public_checks() {
  local path status
  for path in / /about/ /contact/ /account/ /community/ /account/email/confirm/; do
    status=$(curl --resolve pix-kit.com:443:192.190.220.210 --max-time 15 \
      -sS -o /dev/null -w '%{http_code}' "https://pix-kit.com$path") || return 1
    printf '%s: HTTP %s\n' "$path" "$status"
    [[ $status == 200 ]] || return 1
  done
  status=$(curl --resolve pix-kit.com:443:192.190.220.210 --max-time 15 \
    -sS -o /dev/null -w '%{http_code}' 'https://pix-kit.com/auth/start?provider=google') || return 1
  printf 'Google sign-in: HTTP %s\n' "$status"
  [[ $status == 303 ]]
}

php -l "$deploy/index.php"
env -u PIXKIT_ORIGIN -u PIXKIT_SOCKET -u PIXKIT_DB_SOCKET \
  -u PIXKIT_EMAIL_FROM -u PIXKIT_EMAIL_OTP_SECRET -u PIXKIT_EMAIL_SENDMAIL \
  -u PIXKIT_EMAIL_TRANSPORT -u PIXKIT_SMTP_HOST -u PIXKIT_SMTP_PORT \
  -u PIXKIT_SMTP_USER -u PIXKIT_SMTP_PASSWORD \
  bash "$deploy/activate-mariadb.sh" check "$private_dir" "$node_bin"
new_server="$checkout/platform/server/node.mjs"
if [[ $old_server == "$new_server" ]]; then
  ready "$new_server"
  public_checks
  printf 'Release %s is already active.\n' "$expected"
  exit
fi

backup=$(mktemp -d -- "$private_dir/pixkit-upgrade.XXXXXXXX")
chmod 00700 -- "$backup"
cp -p -- "$public_dir/index.php" "$public_dir/.htaccess" "$env_file" \
  "$private_dir/pixkit-gateway-origin" "$backup/"
cutover_started=0
complete=0
cleanup() {
  local status=$?
  trap - EXIT
  if [[ $complete == 1 || $cutover_started == 0 ]]; then return "$status"; fi
  set +e
  if read_process; then
    if [[ $recorded_server == "$new_server" ]]; then
      local new_pid=$recorded_pid
      bash "$deploy/activate-mariadb.sh" stop "$private_dir" "$node_bin" >/dev/null 2>&1 ||
        { printf '%s\n' 'Upgrade stopped; the new process requires inspection.' >&2; exit 1; }
      wait_stopped "$new_pid" ||
        { printf '%s\n' 'Upgrade stopped; the new process did not exit.' >&2; exit 1; }
    elif [[ $recorded_server != "$old_server" ]]; then
      printf '%s\n' 'Upgrade stopped; an unexpected process requires inspection.' >&2
      exit 1
    fi
  fi
  if ! wait_stopped "$old_pid" || ! flock -w 5 "$private_dir/pixkit.lock" true; then
    printf '%s\n' 'Upgrade stopped; the existing process or lock requires inspection.' >&2
    exit 1
  fi
  install -m 644 "$backup/index.php" "$public_dir/index.php" || exit 1
  install -m 644 "$backup/.htaccess" "$public_dir/.htaccess" || exit 1
  start_release "$old_deploy"
  if ready "$old_server"; then
    printf '%s\n' 'Upgrade failed; the previous gateway and service were restored.' >&2
  else
    printf '%s\n' 'Upgrade failed; restoration requires inspection.' >&2
  fi
  printf 'Backup: %s\n' "$backup" >&2
  exit 1
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

cutover_started=1
bash "$old_deploy/activate-mariadb.sh" stop "$private_dir" "$node_bin"
wait_stopped "$old_pid"
flock -w 5 "$private_dir/pixkit.lock" true
install -m 644 "$deploy/index.php" "$public_dir/index.php"
install -m 644 "$deploy/.htaccess" "$public_dir/.htaccess"
start_release "$deploy"
ready "$new_server"
public_checks
complete=1
printf 'Release %s activated. Backup: %s\n' "$expected" "$backup"
