import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const helper = await readFile(new URL('../deploy/liquid-web/upgrade-release.sh', import.meta.url), 'utf8');
const pause = () => new Promise(resolve => setTimeout(resolve, 25));

async function waitFor(read) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if (await read()) return; } catch { /* The fixture process is starting. */ }
    await pause();
  }
  throw new Error('Fixture process did not become ready');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'pixkit-upgrade-'));
  const privateDir = join(root, 'site/private');
  const publicDir = join(root, 'site/html');
  const pixkitRoot = join(root, '.pixkit');
  const processes = join(root, 'processes');
  const commands = join(root, 'commands');
  const candidate = join(pixkitRoot, 'candidate');
  const old = join(pixkitRoot, 'releases', '1'.repeat(40));
  const node = await realpath(process.execPath);
  const pidFile = join(privateDir, 'pixkit-mariadb.pid');
  let oldProcess;
  let oldPid;
  try {
    for (const directory of [privateDir, publicDir, processes, commands, candidate, old]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    await writeFile(join(privateDir, 'pixkit-mariadb.env'), 'PIXKIT_FIXTURE=1\n', { mode: 0o600 });
    await writeFile(join(privateDir, 'pixkit-gateway-origin'), 'https://pix-kit.com\n', { mode: 0o600 });
    await writeFile(join(publicDir, 'index.php'), 'old gateway');
    await writeFile(join(publicDir, '.htaccess'), 'old rewrite');
    await writeFile(join(commands, 'php'), '#!/bin/bash\nexit 0\n', { mode: 0o700 });
    await writeFile(join(commands, 'curl'), `#!/bin/bash
for argument in "$@"; do
  if [[ $argument == --unix-socket ]]; then
    read -r pid < "$PIXKIT_FIXTURE_PID"
    kill -0 "$pid" 2>/dev/null
    exit $?
  fi
done
case "\${@: -1}" in
  *auth/start*) printf 303;;
  *community/*) printf '%s' "\${PIXKIT_FIXTURE_STATUS:-200}";;
  *) printf 200;;
esac
`, { mode: 0o700 });

    const launcher = `#!/bin/bash
set -euo pipefail
action=$1
private_dir=$2
node_bin=$3
checkout=$(cd "$(dirname "\${BASH_SOURCE[0]}")/../../.." && pwd -P)
case "$action" in
  check) exit 0;;
  stop)
    read -r pid < "$private_dir/pixkit-mariadb.pid"
    kill -TERM "$pid"
    ;;
  start)
    exec flock -n "$private_dir/pixkit.lock" bash -c '
      mkdir -p "$5/$$"
      printf "%s\\0" "$1" "--env-file=$2" "$3" > "$5/$$/cmdline"
      printf "%s\\n" "$$" > "$4"
      exec "$1" "--env-file=$2" "$3"
    ' bash "$node_bin" "$private_dir/pixkit-mariadb.env" "$checkout/platform/server/node.mjs" \
      "$private_dir/pixkit-mariadb.pid" "$PIXKIT_FIXTURE_PROCESSES"
    ;;
  *) exit 2;;
esac
`;
    for (const [release, name] of [[old, 'old'], [candidate, 'new']]) {
      const deploy = join(release, 'platform/deploy/liquid-web');
      const server = join(release, 'platform/server');
      await mkdir(deploy, { recursive: true });
      await mkdir(server, { recursive: true });
      await writeFile(join(deploy, 'activate-mariadb.sh'), launcher, { mode: 0o700 });
      await writeFile(join(deploy, 'index.php'), `${name} gateway`);
      await writeFile(join(deploy, '.htaccess'), `${name} rewrite`);
      await writeFile(join(server, 'node.mjs'), `import { rmSync } from 'node:fs';
process.on('SIGTERM', () => {
  rmSync(process.env.PIXKIT_FIXTURE_PROCESSES + '/' + process.pid, { recursive: true, force: true });
  process.exit();
});
setInterval(() => {}, 1000);
`);
    }
    // The executor may expose a host /proc mount outside the shell PID namespace.
    // The isolated copy supplies only process metadata; kill and flock remain real.
    const isolated = helper.replace('"$HOME/.pixkit"', `"${pixkitRoot}"`).replaceAll('/proc/', `${processes}/`);
    const helperPath = join(candidate, 'platform/deploy/liquid-web/upgrade-release.sh');
    await writeFile(helperPath, isolated);
    await execute('git', ['init', '--quiet', candidate]);
    await execute('git', ['-C', candidate, 'add', '.']);
    await execute('git', ['-C', candidate, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture']);
    const { stdout } = await execute('git', ['-C', candidate, 'rev-parse', 'HEAD']);
    const sha = stdout.trim();
    const release = join(pixkitRoot, 'releases', sha);
    await execute('mv', [candidate, release]);
    const env = { ...process.env,
      PATH: `${commands}:${process.env.PATH}`,
      PIXKIT_FIXTURE_PID: pidFile,
      PIXKIT_FIXTURE_PROCESSES: processes,
    };
    oldProcess = spawn('bash', [join(old, 'platform/deploy/liquid-web/activate-mariadb.sh'), 'start', privateDir, node], {
      env, stdio: 'ignore',
    });
    await waitFor(async () => {
      oldPid = Number((await readFile(pidFile, 'utf8')).trim());
      return alive(oldPid) && (await readFile(join(processes, String(oldPid), 'cmdline'))).length;
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    const upgrade = (extra = {}) => execute('bash', [join(release, 'platform/deploy/liquid-web/upgrade-release.sh'), sha, privateDir, node], {
      env: { ...env, ...extra }, timeout: 20_000,
    });
    await run({ root, privateDir, publicDir, processes, release, oldPid, pidFile, sha, upgrade });
  } finally {
    const pids = new Set([oldPid]);
    try { pids.add(Number((await readFile(pidFile, 'utf8')).trim())); } catch { /* No process was recorded. */ }
    for (const pid of pids) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, 'SIGTERM'); } catch { /* It already exited. */ }
    }
    if (oldProcess && oldProcess.exitCode === null) await new Promise(resolve => oldProcess.once('exit', resolve));
    await rm(root, { recursive: true, force: true });
  }
}

test('release upgrade promotes the exact process and gateway, then permits an idempotent rerun', { timeout: 30_000 }, async () => {
  await fixture(async ({ privateDir, publicDir, processes, release, pidFile, sha, upgrade }) => {
    const { stdout } = await upgrade();
    assert.ok(stdout.includes(`Release ${sha} activated.`));
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    const args = (await readFile(join(processes, String(pid), 'cmdline'), 'utf8')).split('\0');
    assert.equal(args[2], join(release, 'platform/server/node.mjs'));
    assert.equal(await readFile(join(publicDir, 'index.php'), 'utf8'), 'new gateway');
    assert.equal(await readFile(join(publicDir, '.htaccess'), 'utf8'), 'new rewrite');
    assert.equal(await readFile(join(privateDir, 'pixkit-mariadb.env'), 'utf8'), 'PIXKIT_FIXTURE=1\n');
    const repeated = await upgrade();
    assert.ok(repeated.stdout.includes('is already active'));
    assert.equal(Number((await readFile(pidFile, 'utf8')).trim()), pid);
  });
});

test('a failed public health check restores the previous process and gateway without replacing private settings', { timeout: 30_000 }, async () => {
  await fixture(async ({ privateDir, publicDir, processes, pidFile, upgrade }) => {
    await assert.rejects(upgrade({ PIXKIT_FIXTURE_STATUS: '500' }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /previous gateway and service were restored/);
      return true;
    });
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    const args = (await readFile(join(processes, String(pid), 'cmdline'), 'utf8')).split('\0');
    assert.ok(args[2].includes('1'.repeat(40)));
    assert.equal(await readFile(join(publicDir, 'index.php'), 'utf8'), 'old gateway');
    assert.equal(await readFile(join(publicDir, '.htaccess'), 'utf8'), 'old rewrite');
    assert.equal(await readFile(join(privateDir, 'pixkit-mariadb.env'), 'utf8'), 'PIXKIT_FIXTURE=1\n');
  });
});

test('a modified staged checkout is rejected before stopping the current service', { timeout: 30_000 }, async () => {
  await fixture(async ({ release, oldPid, pidFile, upgrade }) => {
    await writeFile(join(release, 'platform/deploy/liquid-web/index.php'), 'unexpected edit');
    await assert.rejects(upgrade(), error => {
      assert.match(error.stderr, /differs from the selected verified commit/);
      return true;
    });
    assert.equal(alive(oldPid), true);
    assert.equal(Number((await readFile(pidFile, 'utf8')).trim()), oldPid);
  });
});
