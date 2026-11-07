const reasons = new Set([
  'authentication_failed', 'tls_failed', 'timeout', 'connection_failed',
  'recipient_rejected', 'submission_failed', 'permission_denied', 'queue_unavailable',
]);
const codes = new Set([
  'EAUTH', 'ENOAUTH', 'ETIMEDOUT', 'ECONNECTION', 'ECONNREFUSED', 'ECONNRESET', 'ESOCKET',
  'EDNS', 'ENOTFOUND', 'ETLS', 'EREQUIRETLS', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'EENVELOPE', 'EMESSAGE', 'ENOENT', 'EACCES', 'ABORT_ERR',
]);

/** Operational diagnostics contain only fixed categories, never message or credential data. */
export function mailDiagnostic(error) {
  const result = { event: 'email_submission_failed', reason: reasons.has(error?.reason) ? error.reason : 'submission_failed' };
  if (codes.has(error?.transportCode)) result.transportCode = error.transportCode;
  if (Number.isInteger(error?.exitCode) && error.exitCode >= 0 && error.exitCode <= 255) result.exitCode = error.exitCode;
  return result;
}
