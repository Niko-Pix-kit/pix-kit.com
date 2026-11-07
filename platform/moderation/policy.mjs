const actions = Object.freeze({
  low: 'publish',
  uncertain: 'publish',
  elevated: 'hold',
  high: 'block',
  critical: 'flag',
});

const riskLevels = Object.freeze(Object.keys(actions));

const defaults = {
  harassment: { uncertain: 0.45, elevated: 0.72, high: 0.98 },
  'harassment/threatening': { uncertain: 0.35, elevated: 0.6, high: 0.91, critical: 0.99 },
  hate: { uncertain: 0.4, elevated: 0.65, high: 0.95 },
  'hate/threatening': { uncertain: 0.35, elevated: 0.6, high: 0.91, critical: 0.99 },
  sexual: { uncertain: 0.45, elevated: 0.7, high: 0.95 },
  'sexual/minors': { uncertain: 0.25, elevated: 0.5, high: 0.85, critical: 0.97 },
  illicit: { uncertain: 0.5, elevated: 0.75, high: 0.98 },
  'illicit/violent': { uncertain: 0.4, elevated: 0.7, high: 0.95, critical: 0.995 },
  violence: { uncertain: 0.5, elevated: 0.8, high: 0.98 },
  'violence/graphic': { uncertain: 0.5, elevated: 0.75, high: 0.97 },
  'self-harm': { uncertain: 0.45, elevated: 0.75 },
  'self-harm/intent': { uncertain: 0.4, elevated: 0.65 },
  'self-harm/instructions': { uncertain: 0.4, elevated: 0.7, high: 0.98 },
};

export const openAICategories = Object.freeze(Object.keys(defaults));

const defaultRules = {
  manyLinks: 7,
  recentBlocked: 3,
  recentReports: 4,
  repeatedSpam: 2,
  coordinatedSpam: 3,
};

const defaultUncertainHolds = [
  'harassment/threatening', 'hate/threatening', 'sexual/minors', 'illicit/violent',
  'suspicious_links', 'off_topic', 'malicious_code', 'repeated_abuse', 'provider_flag',
];

function requireInteger(name, value, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`Invalid moderation policy setting: ${name}`);
  }
}

export function createModerationPolicy({
  thresholds = {},
  uncertainHolds = defaultUncertainHolds,
  rules = {},
  maxAttempts = 5,
  initialRetrySeconds = 30,
} = {}) {
  requireInteger('maxAttempts', maxAttempts, 20);
  requireInteger('initialRetrySeconds', initialRetrySeconds, 3600);
  const configuredRules = { ...defaultRules, ...rules };
  for (const [name, value] of Object.entries(configuredRules)) {
    requireInteger(name, value, 100);
  }

  const categories = Object.fromEntries(
    [...new Set([...openAICategories, ...Object.keys(thresholds)])].map((name) => {
      const limits = { ...defaults[name], ...thresholds[name] };
      let last = -1;
      for (const level of riskLevels.slice(1)) {
        if (limits[level] === undefined) continue;
        if (!Number.isFinite(limits[level]) || limits[level] <= last || limits[level] < 0 || limits[level] > 1) {
          throw new TypeError(`Invalid moderation threshold: ${name}/${level}`);
        }
        last = limits[level];
      }
      return [name, Object.freeze(limits)];
    }),
  );

  return Object.freeze({
    thresholds: Object.freeze(categories),
    uncertainHolds: Object.freeze([...uncertainHolds]),
    rules: Object.freeze(configuredRules),
    maxAttempts,
    initialRetrySeconds,
  });
}

export const defaultModerationPolicy = createModerationPolicy();

export function modelFinding(category, score, technical, policy) {
  const thresholds = policy.thresholds[category];
  let risk = 'low';
  for (const level of riskLevels.slice(1)) {
    if (score >= thresholds?.[level]) risk = level;
  }
  if (risk === 'low') return null;
  // References to exploits or violence in technical explanations warrant human context
  // when the classifier is confident. Threat and exploitation categories retain their policy.
  if (technical && ['illicit', 'violence'].includes(category) && risk === 'high') {
    risk = 'elevated';
  }
  return { category, risk };
}

export function decisionFor(findings, policy, provider = null, scores = {}) {
  const ordered = [...findings].sort(
    (left, right) => riskLevels.indexOf(right.risk) - riskLevels.indexOf(left.risk),
  );
  const risk = ordered[0]?.risk ?? 'low';
  const uncertainHold = risk === 'uncertain'
    && ordered.some(({ category }) => policy.uncertainHolds.includes(category));
  return {
    action: uncertainHold ? 'hold' : actions[risk],
    risk,
    reasons: [...new Set(ordered.map(({ category }) => category))],
    provider,
    scores,
  };
}
