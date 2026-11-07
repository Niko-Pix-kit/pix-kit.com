const urls = /(?:https?:\/\/|www\.)[^\s<>{}"'`\]]+/giu;
const unsafeLink = /(?:\]\(\s*<?|\b(?:href|src)\s*=\s*["']?)(?:javascript|vbscript|data|file)\s*:/iu;
const technicalTerms = /\b(?:code|programming|javascript|typescript|python|java|sql|android|compiler|debug|linux|linux kernel|github|software|algorithm|api|server|framework|security|xss|csrf|cve|exploit|bug|reproduce|test|stack trace|tutorial|programmation|logiciel|sécurité)\b|プログラミング|ソフトウェア|エラー|セキュリティ/iu;
const abusiveIntent = /\b(?:help me (?:steal|exfiltrate) (?:someone.s )?(?:passwords?|credentials?|tokens?)|download (?:my|this) (?:ransomware|password stealer)|sell stolen (?:passwords?|credentials?|accounts?))\b/iu;
const offTopic = /\b(?:vote for (?:the |my )?(?:candidate|party)|who (?:are|will) you vot(?:ing|e) for|political debate only|who should win (?:the )?election|pour qui (?:allez-vous|vas-tu) voter)\b|誰に投票しますか|どの政党に投票/iu;
const unsolicitedPromotion = /\b(?:guaranteed (?:profits?|returns?)|send (?:me |us )?(?:your )?(?:seed phrase|recovery phrase)|claim your free (?:bitcoin|airdrop)|double your (?:crypto|bitcoin)|envoyez(?:-nous|-moi)? votre phrase de récupération)\b|シードフレーズを送って|ビットコインを倍に/iu;
const shorteners = new Set(['bit.ly', 'cutt.ly', 'is.gd', 't.co', 'tinyurl.com']);
const emailAddress = /(?<![\p{L}\d._%+-])[\p{L}\d._%+-]{1,64}@(?:[\p{L}\d](?:[\p{L}\d-]{0,61}[\p{L}\d])?\.){1,20}[\p{L}]{2,63}(?![\p{L}\d-])/giu;
const exampleEmail = /@(?:example\.(?:com|net|org)|[\w.-]+\.(?:example|invalid|test))$/iu;
const obviousPersonalInformation = [
  emailAddress,
  /(?<!\w)(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]\d{2,4}[ .-]\d{3,4}(?!\w)/gu,
  /(?<!\w)(?:\+33[ .-]?|0)[1-9](?:[ .-]\d{2}){4}(?!\w)/gu,
  /\b\d{1,6} +(?:[\p{L}.'’-]+ +){1,5}(?:street|road|lane|avenue|drive)\b/giu,
];
const additionalRedactions = [
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu,
  /\b(?:\d[ -]?){12,18}\d\b/gu,
  urls,
];
const credentials = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
  /\b(?:gh[pousr]_[\w]{25,}|github_pat_[\w]{30,}|sk-(?:proj-)?[\w-]{25,}|AKIA[A-Z0-9]{16})\b/gu,
  /\b(?:password|access_token|api[_ -]?key|client_secret)\s*[:=]\s*["']?[\w-]{16,}/giu,
];

function withoutCode(content) {
  let fence = null;
  return content.split('\n').map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = null;
      }
      return '';
    }
    if (marker) {
      fence = marker[1];
      return '';
    }
    return line.replace(/(?<!`)(`{1,8})(?!`)[^`]+\1(?!`)/gu, ' ');
  }).join('\n');
}

function suspiciousUrl(candidate) {
  try {
    const normalized = /^www\./iu.test(candidate) ? `https://${candidate}` : candidate;
    const link = new URL(normalized);
    const authority = normalized.match(/^https?:\/\/([^/?#]+)/iu)?.[1] ?? '';
    const opaqueHostname = authority.split('.').some((label) => /^xn--/iu.test(label));
    return link.username || link.password || link.port
      || shorteners.has(link.hostname) || opaqueHostname
      || /^\d+\.\d+\.\d+\.\d+$|^\[/u.test(link.hostname);
  } catch {
    return true;
  }
}

function redact(content, patterns, ignored = () => false) {
  let matched = false;
  for (const pattern of patterns) {
    content = content.replace(pattern, (value) => {
      if (!ignored(value)) matched = true;
      return '[redacted]';
    });
  }
  return { content, matched };
}

export function submissionSignals({ title = '', body, context = {} }, policy) {
  const content = `${title ? `${title}\n\n` : ''}${body}`.normalize('NFKC');
  const prose = withoutCode(content);
  const technical = technicalTerms.test(prose) || /^ {0,3}(?:`{3,}|~{3,})[a-z][\w+-]* *$/imu.test(content);
  const links = [...prose.matchAll(urls)].map(([link]) => link.replace(/[.,;!?)]+$/u, ''));
  const privateData = redact(content, obviousPersonalInformation, (value) => exampleEmail.test(value));
  const secret = redact(privateData.content, credentials);
  const findings = [];
  const record = (category, risk) => findings.push({ category, risk });

  if (unsafeLink.test(prose)) record('malicious_links', 'high');
  if (links.some(suspiciousUrl)) record('suspicious_links', 'uncertain');
  if (privateData.matched || secret.matched) record('personal_information', 'elevated');
  if (links.length >= policy.rules.manyLinks || unsolicitedPromotion.test(prose)) record('spam', 'elevated');
  if (abusiveIntent.test(prose)) record('malicious_code', 'elevated');
  if (!technical && offTopic.test(prose)) record('off_topic', 'uncertain');
  if (context.recentBlocked >= policy.rules.recentBlocked
    || context.recentReports >= policy.rules.recentReports
    || context.repeatedSpam >= policy.rules.repeatedSpam
    || context.coordinatedSpam >= policy.rules.coordinatedSpam) {
    record('repeated_abuse', 'uncertain');
  }

  return {
    findings,
    technical,
    text: redact(secret.content, additionalRedactions).content,
    privateInformation: privateData.matched || secret.matched,
  };
}
