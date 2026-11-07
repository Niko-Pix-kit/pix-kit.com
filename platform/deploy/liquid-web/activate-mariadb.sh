#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

if [[ $# -ne 3 ]]; then
  fail "Usage: $0 {check|start|stop} /absolute/path/to/private /absolute/path/to/node"
fi
action=$1
[[ $action == check || $action == start || $action == stop ]] || fail "Unknown action: $action"
[[ $2 == /* && $3 == /* ]] || fail "Use absolute paths for the private directory and Node binary."
# Mail credentials come exclusively from the protected configuration file.
unset PIXKIT_EMAIL_FROM PIXKIT_EMAIL_OTP_SECRET PIXKIT_EMAIL_SENDMAIL PIXKIT_EMAIL_TRANSPORT
unset PIXKIT_SMTP_HOST PIXKIT_SMTP_PORT PIXKIT_SMTP_USER PIXKIT_SMTP_PASSWORD

private_dir=$(realpath -e -- "$2")
node_bin=$(realpath -e -- "$3")
checkout=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)
server="$checkout/platform/server/node.mjs"
env_file="$private_dir/pixkit-mariadb.env"
socket="$private_dir/pixkit.sock"
pid_file="$private_dir/pixkit-mariadb.pid"

[[ -d $private_dir && -O $private_dir && $(stat -c %a -- "$private_dir") == 700 ]] ||
  fail "The private directory must belong to this account and have mode 0700."
[[ -x $node_bin && -f $server ]] || fail "Node or the release entry point is missing."

if [[ $action == stop ]]; then
  [[ -f $pid_file && ! -L $pid_file && -O $pid_file ]] || fail "No recorded MariaDB process."
  read -r pid < "$pid_file"
  [[ $pid =~ ^[1-9][0-9]*$ && -O /proc/$pid ]] || fail "The recorded process is no longer owned by this account."
  mapfile -d '' -t process_args < "/proc/$pid/cmdline"
  [[ ${#process_args[@]} -eq 3 && ${process_args[0]} == "$node_bin" &&
     ${process_args[1]} == "--env-file=$env_file" && ${process_args[2]} == "$server" ]] ||
    fail "The recorded process is not running this PixKit release."
  kill -TERM "$pid"
  printf '%s\n' 'Stop requested. Wait for the process to exit before starting another release.'
  exit
fi

[[ -f $env_file && ! -L $env_file && -O $env_file && $(stat -c %a -- "$env_file") == 600 ]] ||
  fail "Create pixkit-mariadb.env in the private directory with mode 0600."

"$node_bin" --env-file="$env_file" --input-type=module - "$socket" <<'JS'
const required = [
  'PIXKIT_DB_NAME', 'PIXKIT_DB_USER', 'PIXKIT_DB_PASSWORD',
  'PIXKIT_GOOGLE_CLIENT_ID', 'PIXKIT_GOOGLE_CLIENT_SECRET',
];
if (Number(process.versions.node.split('.')[0]) < 22 ||
    process.env.PIXKIT_AUTH_BACKEND !== 'mariadb' ||
    !['https://pix-kit.com', 'https://app.pix-kit.com'].includes(process.env.PIXKIT_ORIGIN) ||
    process.env.PIXKIT_SOCKET !== process.argv[2] ||
    required.some(name => !process.env[name]) ||
    Buffer.byteLength(process.argv[2]) >= 108) {
  console.error('Check Node 22+, MariaDB and Google settings, production origin, and private socket path.');
  process.exitCode = 1;
}
JS

if [[ $action == start ]]; then
  exec flock -n "$private_dir/pixkit.lock" bash -c '
    socket=$1
    if [[ -L $socket || ( -e $socket && ! -S $socket ) ]]; then
      printf "%s\n" "The production socket path is occupied by a non-socket entry." >&2
      exit 1
    fi
    if [[ -S $socket ]]; then
      "$3" --input-type=module - "$socket" <<\JS
import { createConnection } from "node:net";
const socket = createConnection({ path: process.argv[2] });
socket.setTimeout(2000, () => {
  console.error("The production socket did not respond. Verify the existing service before proceeding.");
  process.exitCode = 1;
  socket.destroy();
});
socket.once("connect", () => {
  console.error("The production socket is already in use.");
  process.exitCode = 1;
  socket.destroy();
});
socket.once("error", (error) => {
  if (error.code !== "ECONNREFUSED" && error.code !== "ENOENT") {
    console.error("Cannot establish whether the production socket is stale.");
    process.exitCode = 1;
  }
});
JS
      if [[ $? -ne 0 ]]; then exit 1; fi
      rm -f -- "$socket" || exit 1
    fi
    printf "%s\n" "$$" > "$2" || exit 1
    exec "$3" --env-file="$4" "$5"
  ' bash "$socket" "$pid_file" "$node_bin" "$env_file" "$server"
fi

(
  cd -- "$checkout/platform"
  "$node_bin" --env-file="$env_file" --input-type=module - <<'JS'
import mariadb from 'mariadb';
import { emailConfiguration } from './server/email-configuration.mjs';

const env = process.env;
let connection;
try {
  connection = await mariadb.createConnection({
    ...(env.PIXKIT_DB_SOCKET ? { socketPath: env.PIXKIT_DB_SOCKET } : { host: '127.0.0.1' }),
    database: env.PIXKIT_DB_NAME,
    user: env.PIXKIT_DB_USER,
    password: env.PIXKIT_DB_PASSWORD,
    connectTimeout: 4000,
    queryTimeout: 5000,
  });
  await connection.query(`
    SELECT id, google_subject, email, display_name, avatar_url, given_name, family_name,
      country_code, preferred_locale, nickname, avatar_preset, public_given_name, public_family_name,
      public_country, public_language, is_admin, created_at, last_sign_in_at
    FROM pixkit_users LIMIT 0
  `);
  await connection.query('SELECT token_hash, user_id, created_at, expires_at FROM pixkit_sessions LIMIT 0');
  if (emailConfiguration(env)) {
    await connection.query('SELECT email, user_id, password_hash, verified_at FROM pixkit_email_identities LIMIT 0');
    await connection.query('SELECT email_key, email_address, verification_hash, password_hash, purpose FROM pixkit_email_challenges LIMIT 0');
    await connection.query('SELECT scope_id, issued_count FROM pixkit_email_send_limit LIMIT 0');
    await connection.query('SELECT subject_key, attempts FROM pixkit_password_limits LIMIT 0');
    await connection.query('SELECT subject_key, issued_count FROM pixkit_email_delivery_limits LIMIT 0');
  }
  console.log('MariaDB connection and account schema OK.');
} catch {
  console.error('MariaDB check failed. Verify the credentials, connection, permissions, and schema.');
  process.exitCode = 1;
} finally {
  if (connection) await connection.end();
}
JS
)

"$node_bin" "$checkout/platform/deploy/liquid-web/check-email.mjs" "$private_dir"

probe_dir=$(mktemp -d -- "$private_dir/check.XXXXXX")
probe_socket="$probe_dir/app.sock"
probe_pid=
cleanup() {
  if [[ -n $probe_pid ]]; then
    kill "$probe_pid" 2>/dev/null || true
    wait "$probe_pid" 2>/dev/null || true
  fi
  rm -rf -- "$probe_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[[ ${#probe_socket} -lt 108 ]] || fail "The temporary socket path is too long."
PIXKIT_SOCKET="$probe_socket" "$node_bin" --env-file="$env_file" "$server" > "$probe_dir/node.log" 2>&1 &
probe_pid=$!
for attempt in {1..20}; do
  [[ -S $probe_socket ]] && break
  kill -0 "$probe_pid" 2>/dev/null || fail "The candidate runtime exited before it opened its socket."
  sleep 0.25
done
[[ -S $probe_socket ]] || fail "The candidate runtime did not open its socket."
curl --noproxy '*' --unix-socket "$probe_socket" --max-time 5 -fsS -o /dev/null http://localhost/account/
status=$(curl --noproxy '*' --unix-socket "$probe_socket" --max-time 5 -fsS -o /dev/null \
  -w '%{http_code}' 'http://localhost/auth/start?provider=google')
[[ $status == 303 ]] || fail "Expected the Google sign-in route to return HTTP 303."
printf '%s\n' 'Candidate account page and Google redirect OK on the temporary socket.'
