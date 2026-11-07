import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mailDiagnostic } from '../server/mail-diagnostic.mjs';

test('mail diagnostics retain only fixed failure categories and bounded numeric status', () => {
  assert.deepEqual(mailDiagnostic({ reason: 'authentication_failed', transportCode: 'EAUTH', exitCode: 111 }), {
    event: 'email_submission_failed', reason: 'authentication_failed', transportCode: 'EAUTH', exitCode: 111,
  });
  assert.deepEqual(mailDiagnostic({ reason: 'private-recipient@example.test', transportCode: 'PRIVATE_CREDENTIAL',
    message: 'private credential and verification token', exitCode: -1 }), {
    event: 'email_submission_failed', reason: 'submission_failed',
  });
  assert.deepEqual(mailDiagnostic(null), { event: 'email_submission_failed', reason: 'submission_failed' });
});
