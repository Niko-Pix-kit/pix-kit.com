import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('private mail preflight accepts local configuration without sending and rejects unsafe files without secret output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pixkit-preflight-'));
  const file = join(directory, 'pixkit-mariadb.env');
  const script = fileURLToPath(new URL('../deploy/liquid-web/check-email.mjs', import.meta.url));
  const invoke = () => spawnSync(process.execPath, [script, directory], { encoding: 'utf8', timeout: 5000 });
  try {
    chmodSync(directory, 0o700);
    const config = 'PIXKIT_EMAIL_FROM=mail@example.test\nPIXKIT_EMAIL_OTP_SECRET=' + 'a'.repeat(64) +
      '\nPIXKIT_EMAIL_SENDMAIL=/usr/sbin/sendmail\nPIXKIT_DB_PASSWORD=fixture-private-value\n';
    writeFileSync(file, config, { mode: 0o600 });
    const accepted = invoke();
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /recipient delivery is not verified/);
    chmodSync(file, 0o644);
    const rejected = invoke();
    assert.equal(rejected.status, 1);
    assert.doesNotMatch(rejected.stdout + rejected.stderr, /fixture-private-value|mail@example/);
    rmSync(file);
    writeFileSync(join(directory, 'other.env'), config, { mode: 0o600 });
    symlinkSync(join(directory, 'other.env'), file);
    assert.equal(invoke().status, 1, 'A configuration symlink must not be followed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
