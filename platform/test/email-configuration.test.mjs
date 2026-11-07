import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emailConfiguration } from '../server/email-configuration.mjs';

const base = { PIXKIT_EMAIL_FROM: 'mail@example.test', PIXKIT_EMAIL_OTP_SECRET: 'a'.repeat(64) };
const smtp = {
  ...base, PIXKIT_EMAIL_TRANSPORT: 'smtp', PIXKIT_SMTP_HOST: 'smtp.example.test',
  PIXKIT_SMTP_PORT: '587', PIXKIT_SMTP_USER: 'mail@example.test', PIXKIT_SMTP_PASSWORD: 'fixture-credential',
};

test('email configuration keeps local sendmail backwards compatible and resolves explicit authenticated SMTP', () => {
  assert.equal(emailConfiguration({}), null);
  assert.deepEqual(emailConfiguration({ ...base, PIXKIT_EMAIL_SENDMAIL: '/usr/sbin/sendmail' }), {
    transport: 'sendmail', from: base.PIXKIT_EMAIL_FROM, secret: base.PIXKIT_EMAIL_OTP_SECRET, executable: '/usr/sbin/sendmail',
  });
  const settings = emailConfiguration(smtp);
  assert.equal(settings.transport, 'smtp');
  assert.equal(settings.port, 587);
  assert.equal(settings.secure, false);
  assert.equal(settings.password, smtp.PIXKIT_SMTP_PASSWORD);
  assert.equal(emailConfiguration({ ...smtp, PIXKIT_SMTP_PORT: '465' }).secure, true);
  assert.equal(emailConfiguration({ ...smtp, PIXKIT_EMAIL_SENDMAIL: '/usr/sbin/sendmail' }).transport, 'smtp');
});

test('partial configuration and plaintext SMTP fail closed without leaking credentials', () => {
  for (const env of [
    { PIXKIT_SMTP_PASSWORD: 'fixture-credential' },
    { ...base },
    { ...base, PIXKIT_EMAIL_SENDMAIL: 'relative-command' },
    { ...base, PIXKIT_EMAIL_SENDMAIL: '/bin/sendmail\0' },
    { ...smtp, PIXKIT_EMAIL_TRANSPORT: 'sendmail', PIXKIT_EMAIL_SENDMAIL: '/usr/sbin/sendmail' },
    { ...smtp, PIXKIT_SMTP_PORT: '25' },
    { ...smtp, PIXKIT_SMTP_PORT: '0587' },
    { ...smtp, PIXKIT_SMTP_PASSWORD: '' },
    { ...smtp, PIXKIT_EMAIL_TRANSPORT: 'unrecognized' },
    { ...smtp, PIXKIT_EMAIL_FROM: 'mail@example.test\nBcc: attacker@example.test' },
    { ...smtp, PIXKIT_EMAIL_OTP_SECRET: 'incomplete' },
  ]) {
    assert.throws(() => emailConfiguration(env), error => {
      assert.doesNotMatch(error.message, /fixture-credential|attacker@example|mail@example/);
      return error instanceof TypeError;
    });
  }
});
