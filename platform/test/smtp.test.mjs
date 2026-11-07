import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmtpTransport } from '../server/smtp.mjs';
import { buildVerificationMessage } from '../server/sendmail.mjs';

const origin = 'https://pix-kit.com';
const verificationUrl = `${origin}/account/email/confirm/#selector=${'A'.repeat(43)}&token=${'B'.repeat(43)}&purpose=signup`;
const config = {
  host: 'smtp.pix-kit.com', port: 465, secure: true,
  user: 'mailer@pix-kit.com', password: 'unit-test-password-value',
  from: 'info@pix-kit.com', origin,
};
const input = { email: 'Member@example.test', verificationUrl, locale: 'fr' };

function fixture(overrides = {}, submit = async message => ({ accepted: message.envelope.to, rejected: [] }), verify = async () => true) {
  let options;
  let verifications = 0;
  const messages = [];
  const send = createSmtpTransport({ ...config, ...overrides }, {
    transportFactory(value) {
      options = value;
      return {
        async sendMail(message) { messages.push(message); return submit(message); },
        async verify() { verifications++; return verify(); },
      };
    },
  });
  return { send, options, messages, get verifications() { return verifications; } };
}

function mimeBody(message, type) {
  const body = message.match(new RegExp(`Content-Type: ${type}; charset=UTF-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`));
  assert.ok(body);
  return Buffer.from(body[1], 'base64').toString('utf8');
}

test('SMTP requires complete authenticated configuration and exact secure submission ports', () => {
  for (const override of [
    { host: undefined }, { user: undefined }, { password: undefined }, { from: undefined },
    { host: '' }, { user: '' }, { password: '' }, { password: '   ' },
    { user: 'mail\nprivate' }, { password: 'private\r\nAUTH LOGIN' },
    { user: ' mailer' }, { password: 'a'.repeat(4097) },
    { host: 'localhost' }, { host: 'mail.local' }, { host: 'mail.internal' },
    { host: '127.0.0.1' }, { host: '192.168.1.1' }, { host: '169.254.169.254' },
    { host: '::1' }, { host: '[2001:db8::1]' }, { host: 'mail.invalid' },
    { host: 'smtp://smtp.pix-kit.com' }, { host: 'smtp.pix-kit.com:465' },
    { host: 'smtp.pix-kit.com\nAUTH LOGIN' }, { host: 'smtp.pix-kit.com.' },
    { host: 'mail..pix-kit.com' }, { host: 'mail.-pix-kit.com' },
    { port: 25 }, { port: 2525 }, { port: '465' }, { port: 465, secure: false },
    { port: 587, secure: true }, { port: 465, secure: undefined },
    { from: 'info@pix-kit.com\nBcc: private@example.test' },
    { origin: 'http://pix-kit.com' }, { origin: `${origin}/` },
  ]) {
    let created = false;
    assert.throws(() => createSmtpTransport({ ...config, ...override }, {
      transportFactory() { created = true; return { sendMail() {} }; },
    }), TypeError, JSON.stringify(Object.keys(override)));
    assert.equal(created, false);
  }
});

test('SMTP enforces TLS, authentication, short timeouts and disabled content fetching without configuration overrides', () => {
  for (const [port, secure] of [[465, true], [587, false]]) {
    const { options } = fixture({
      host: 'SMTP.PIX-KIT.COM', port, secure,
      tls: { rejectUnauthorized: false }, ignoreTLS: true, opportunisticTLS: true, pool: true,
    });
    assert.deepEqual(options.auth, { user: config.user, pass: config.password });
    assert.equal(options.host, 'smtp.pix-kit.com');
    assert.equal(options.port, port);
    assert.equal(options.secure, secure);
    assert.equal(options.forceAuth, true);
    assert.equal(options.requireTLS, port === 587);
    assert.equal(options.ignoreTLS, false);
    assert.equal(options.opportunisticTLS, false);
    assert.deepEqual(options.tls, { servername: 'smtp.pix-kit.com', rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    assert.equal(options.connectionTimeout, 5000);
    assert.equal(options.greetingTimeout, 5000);
    assert.equal(options.socketTimeout, 10_000);
    assert.equal(options.dnsTimeout, 5000);
    for (const option of ['pool', 'logger', 'debug', 'transactionLog']) assert.equal(options[option], false);
    assert.equal(options.disableFileAccess, true);
    assert.equal(options.disableUrlAccess, true);
  }
});

test('SMTP submits the shared branded MIME and explicit single-recipient envelope only', async () => {
  const { send, messages } = fixture({ from: 'info@PIX-KIT.COM' });
  assert.equal(await send(input), undefined);
  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.deepEqual(message.envelope, { from: 'info@pix-kit.com', to: [input.email] });
  assert.equal(message.disableFileAccess, true);
  assert.equal(message.disableUrlAccess, true);
  assert.equal(typeof message.raw, 'string');
  assert.match(message.raw, /^From: Pix-kit <info@pix-kit\.com>\r\nTo: Member@example\.test\r\n/);
  assert.match(message.raw, /Content-ID: <pixkit-logo>/);
  assert.deepEqual(Object.keys(message).sort(), ['disableFileAccess', 'disableUrlAccess', 'envelope', 'raw']);
  const shared = buildVerificationMessage({ ...input, from: config.from, origin });
  for (const type of ['text/plain', 'text/html']) assert.equal(mimeBody(message.raw, type), mimeBody(shared, type));
  assert.ok(mimeBody(message.raw, 'text/plain').includes(verificationUrl));
  assert.ok(mimeBody(message.raw, 'text/html').includes('cid:pixkit-logo'));
});

test('SMTP validates verification links and recipients before invoking the transport', () => {
  const { send, messages } = fixture();
  for (const override of [
    { email: 'member@example.test\r\nBcc: private@example.test' },
    { verificationUrl: verificationUrl.replace(origin, 'https://outside.example') },
    { verificationUrl: verificationUrl.replace('#', '?') },
    { verificationUrl: `${verificationUrl}&token=${'C'.repeat(43)}` },
    { verificationUrl: verificationUrl.replace('/account/email/confirm/', '/other/') },
    { purpose: 'reset' }, { purpose: 'unknown' },
  ]) assert.throws(() => send({ ...input, ...override }), /Invalid verification message/);
  assert.equal(messages.length, 0);
});

test('SMTP fails closed when the intended recipient is not explicitly accepted', async () => {
  for (const result of [
    undefined, {}, { accepted: [] }, { accepted: ['other@example.test'] },
    { accepted: ['member@example.test'] },
    { accepted: [input.email, 'other@example.test'] },
    { accepted: [input.email], rejected: [input.email] },
    { accepted: [{ address: input.email }] },
  ]) {
    const { send, messages } = fixture({}, async () => result);
    await assert.rejects(send(input), error => {
      assert.equal(error.code, 'MAIL_SUBMISSION_FAILED');
      assert.equal(error.reason, 'recipient_rejected');
      assert.equal(error.transportCode, 'EENVELOPE');
      assert.doesNotMatch(error.message, /example\.test/);
      return true;
    });
    assert.equal(messages.length, 1);
  }
});

test('SMTP exposes only fixed diagnostic categories for authentication, TLS, timeout and connection failures', async () => {
  for (const [code, reason] of [
    ['EAUTH', 'authentication_failed'], ['ETIMEDOUT', 'timeout'], ['ECONNREFUSED', 'connection_failed'],
    ['ETLS', 'tls_failed'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_failed'], ['EUNKNOWN_PRIVATE', 'submission_failed'],
  ]) {
    const sensitive = 'private-recipient@example.test unit-test-password-value server-private-response';
    const original = Object.assign(new Error(sensitive), { code, response: sensitive, rejected: [sensitive] });
    const { send, messages } = fixture({}, () => { throw original; });
    await assert.rejects(send(input), error => {
      assert.equal(error.code, 'MAIL_SUBMISSION_FAILED');
      assert.equal(error.reason, reason);
      assert.equal(error.transportCode, code === 'EUNKNOWN_PRIVATE' ? undefined : code);
      assert.doesNotMatch(JSON.stringify(error), /private-recipient|unit-test-password|server-private/);
      assert.doesNotMatch(error.stack, /private-recipient|unit-test-password|server-private/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(messages.length, 1, 'A failed SMTP submission is never retried through another transport');
  }
});

test('SMTP factory failures cannot leak administrator credentials or raw library diagnostics', () => {
  assert.throws(() => createSmtpTransport(config, {
    transportFactory() { throw new Error(config.password); },
  }), error => {
    assert.equal(error.message, 'SMTP transport could not be configured');
    assert.doesNotMatch(error.stack, new RegExp(config.password));
    return true;
  });
  assert.throws(() => createSmtpTransport(config, { transportFactory: () => ({}) }), TypeError);
  assert.throws(() => createSmtpTransport(config, { transportFactory: () => ({ sendMail() {} }) }), TypeError);
});

test('SMTP preflight verifies TLS and authentication without sending or accepting a delivery claim', async () => {
  const instance = fixture();
  assert.equal(instance.verifications, 0);
  assert.equal(await instance.send.verify(), true);
  assert.equal(instance.verifications, 1);
  assert.equal(instance.messages.length, 0);
  for (const result of [undefined, false, {}, 'true']) {
    const rejected = fixture({}, undefined, async () => result);
    await assert.rejects(rejected.send.verify(), error => {
      assert.equal(error.code, 'MAIL_SUBMISSION_FAILED');
      assert.equal(error.reason, 'submission_failed');
      return true;
    });
    assert.equal(rejected.verifications, 1);
    assert.equal(rejected.messages.length, 0);
  }
});

test('SMTP preflight authentication and timeout failures retain only bounded safe diagnostics', async () => {
  for (const [code, reason] of [['EAUTH', 'authentication_failed'], ['ENOAUTH', 'authentication_failed'], ['ETIMEDOUT', 'timeout']]) {
    const original = Object.assign(new Error(`Private server response ${config.password}`), { code });
    const instance = fixture({}, undefined, async () => { throw original; });
    await assert.rejects(instance.send.verify(), error => {
      assert.equal(error.code, 'MAIL_SUBMISSION_FAILED');
      assert.equal(error.reason, reason);
      assert.equal(error.transportCode, code);
      assert.doesNotMatch(error.stack, /Private server response|unit-test-password/);
      assert.doesNotMatch(JSON.stringify(error), /Private server response|unit-test-password/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(instance.verifications, 1);
    assert.equal(instance.messages.length, 0);
  }
});
