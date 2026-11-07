import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSendmailTransport } from '../server/sendmail.mjs';
import messages from '../ui/email-messages.json' with { type: 'json' };
import locales from '../../data/i18n/locales.json' with { type: 'json' };

const origin = 'https://pix-kit.com';
const verificationUrl = `${origin}/account/email/confirm/#selector=${'A'.repeat(43)}&token=${'B'.repeat(43)}&purpose=signup`;

function mimeBody(message, type) {
  const part = message.match(new RegExp(`Content-Type: ${type}; charset=UTF-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`));
  assert.ok(part, `Missing ${type} MIME alternative`);
  return Buffer.from(part[1], 'base64').toString('utf8');
}

test('sendmail submits localized one-time link mail with an embedded logo and isolated environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pixkit-mail-test-'));
  try {
    const executable = join(directory, 'capture');
    const output = join(directory, 'message');
    const argumentsFile = join(directory, 'arguments');
    await writeFile(executable, `#!/bin/sh\nif [ "\${PIXKIT_TEST_MAIL_SECRET+x}" ]; then exit 1; fi\nprintf '%s\\n' "$@" > '${argumentsFile}'\ncat > '${output}'\n`, { mode: 0o700 });
    const sender = createSendmailTransport({ executable, from: 'noreply@example.test', origin });
    process.env.PIXKIT_TEST_MAIL_SECRET = 'fixture';
    try {
      for (const { code } of locales) {
        const localUrl = verificationUrl.replace('/account/', code === 'en' ? '/account/' : `/${code}/account/`);
        await sender({ email: 'member@example.test', verificationUrl: localUrl, locale: code });
        const message = await readFile(output, 'utf8');
        assert.match(message, /^From: Pix-kit <noreply@example\.test>\r\nTo: member@example\.test\r\n/);
        assert.match(message, /Content-ID: <pixkit-logo>/);
        const plain = mimeBody(message, 'text/plain');
        const html = mimeBody(message, 'text/html');
        assert.ok(plain.includes(messages[code].expiry));
        assert.ok(plain.includes(localUrl));
        assert.ok(html.includes(localUrl.replaceAll('&', '&amp;')));
        assert.ok(html.includes('src="cid:pixkit-logo"'));
        assert.match(html, /color:#008acb/);
        assert.match(html, /color:#ff7100/);
        assert.doesNotMatch(html, /undefined/);
        assert.equal((html.match(/href=/g) ?? []).length, 1, 'Mail contains a single explicit confirmation action');
        for (const word of message.match(/=\?UTF-8\?B\?.*?\?=/g) ?? []) assert.ok(word.length <= 75);
      }
      const resetUrl = verificationUrl.replace('purpose=signup', 'purpose=reset');
      await sender({ email: 'member@example.test', verificationUrl: resetUrl, locale: 'fr', purpose: 'reset' });
      const reset = mimeBody(await readFile(output, 'utf8'), 'text/plain');
      assert.ok(reset.includes(messages.fr.resetSubject));
      assert.ok(reset.includes(messages.fr.resetTitle));
      assert.deepEqual((await readFile(argumentsFile, 'utf8')).trim().split('\n'), ['-i', '-t', '-f', 'noreply@example.test']);
    } finally {
      delete process.env.PIXKIT_TEST_MAIL_SECRET;
    }
    for (const input of [
      { email: 'a@example.test\nBcc: b@example.test', verificationUrl },
      { email: 'member@example.test', verificationUrl, purpose: 'unknown' },
      { email: 'member@example.test', verificationUrl: verificationUrl.replace(origin, 'https://other.example') },
      { email: 'member@example.test', verificationUrl: verificationUrl.replace('#', '?') },
      { email: 'member@example.test', verificationUrl: verificationUrl + '&token=' + 'C'.repeat(43) },
      { email: 'member@example.test', verificationUrl: verificationUrl.replace('purpose=signup', 'purpose=reset') },
      { email: 'member@example.test', verificationUrl: verificationUrl.replace('/account/email/confirm/', '/other/') },
      { email: 'member@example.test', verificationUrl: verificationUrl + '&redirect=https://other.example' },
    ]) assert.throws(() => sender(input), /Invalid verification message/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sendmail rejects transport failure with bounded safe diagnostic categories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pixkit-mail-failure-'));
  try {
    const executable = join(directory, 'reject');
    await writeFile(executable, '#!/bin/sh\ncat >/dev/null\nprintf "%s\\n" "qmail-inject: queue unavailable for private@example.test" >&2\nexit 111\n', { mode: 0o700 });
    const sender = createSendmailTransport({ executable, from: 'noreply@example.test', origin });
    await assert.rejects(sender({ email: 'member@example.test', verificationUrl }), error => {
      assert.equal(error.code, 'MAIL_SUBMISSION_FAILED');
      assert.equal(error.exitCode, 111);
      assert.equal(error.reason, 'queue_unavailable');
      assert.doesNotMatch(JSON.stringify(error), /private@example/);
      assert.doesNotMatch(error.message, /private@example/);
      return true;
    });
    const absent = createSendmailTransport({ executable: join(directory, 'missing'), from: 'noreply@example.test', origin });
    await assert.rejects(absent({ email: 'member@example.test', verificationUrl }), error => {
      assert.equal(error.code, 'MAIL_SUBMISSION_FAILED');
      assert.equal(error.transportCode, 'ENOENT');
      return true;
    });
    assert.throws(() => createSendmailTransport({ executable, from: 'noreply@example.test', origin: 'http://pix-kit.com' }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
