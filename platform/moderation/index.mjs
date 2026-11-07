import {
  decisionFor, defaultModerationPolicy, modelFinding, openAICategories,
} from './policy.mjs';
import { submissionSignals } from './signals.mjs';

export { createModerationPolicy, defaultModerationPolicy } from './policy.mjs';

class ProviderUnavailable extends Error {
  constructor() {
    super('Moderation provider unavailable');
  }
}

function validScore(score) {
  return Number.isFinite(score) && score >= 0 && score <= 1;
}

export function createOpenAIModeration({ apiKey, fetchImpl = fetch, timeoutMs = 7000 } = {}) {
  if (!apiKey?.trim()) throw new TypeError('Missing OpenAI moderation key');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) {
    throw new TypeError('Invalid moderation provider timeout');
  }
  return {
    name: 'openai',
    async classify(text) {
      const response = await fetchImpl('https://api.openai.com/v1/moderations', {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'omni-moderation-latest', input: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new ProviderUnavailable();

      const data = await response.json();
      const result = data?.results?.[0];
      if (typeof result?.flagged !== 'boolean'
        || !openAICategories.every((name) => validScore(result.category_scores?.[name]))) {
        throw new ProviderUnavailable();
      }
      return {
        flagged: result.flagged,
        scores: Object.fromEntries(openAICategories.map((name) => [name, result.category_scores[name]])),
        model: data.model ?? 'omni-moderation-latest',
      };
    },
  };
}

/**
 * A provider receives only the prepared submission text. It returns a flagged
 * boolean and a dictionary of normalized category scores, or throws.
 */
export async function evaluateSubmission(submission, { provider, policy = defaultModerationPolicy } = {}) {
  const signals = submissionSignals(submission, policy);
  const localDecision = decisionFor(signals.findings, policy);

  // Avoid transmitting suspected private material or already blocked submissions.
  if (signals.privateInformation || ['block', 'flag'].includes(localDecision.action)) {
    return localDecision;
  }
  let classified;
  try {
    classified = await provider?.classify(signals.text);
    if (typeof classified?.flagged !== 'boolean' || !classified.scores
      || typeof classified.scores !== 'object' || Array.isArray(classified.scores)
      || !Object.values(classified.scores).every(validScore)) {
      throw new ProviderUnavailable();
    }
  } catch {
    // Do not propagate provider messages. They may contain keys or submitted text.
    throw new ProviderUnavailable();
  }

  const scores = Object.fromEntries(
    Object.entries(classified.scores).filter(([name]) => Object.hasOwn(policy.thresholds, name)),
  );
  const modelFindings = Object.entries(scores)
    .map(([category, score]) => modelFinding(category, score, signals.technical, policy))
    .filter(Boolean);
  // Catch an overall provider flag even if its category did not reach our thresholds.
  if (classified.flagged && !modelFindings.some(({ risk }) => risk !== 'uncertain')) {
    modelFindings.push({ category: 'provider_flag', risk: 'uncertain' });
  }

  const decision = decisionFor([...signals.findings, ...modelFindings], policy, provider.name, scores);
  if (typeof classified.model === 'string' && /^[a-z0-9._-]{1,100}$/iu.test(classified.model)) {
    decision.model = classified.model;
  }
  return decision;
}

function retryDelay(attempts, policy) {
  return Math.min(3600, policy.initialRetrySeconds * (2 ** Math.max(0, attempts - 1)));
}

/**
 * The repository must atomically claim a versioned job, lease it, and apply a
 * decision only if that lease still owns the same submission version.
 */
export async function processModerationJobs({
  repository, provider, policy = defaultModerationPolicy, limit = 10, leaseSeconds = 120,
}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25
    || !Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) {
    throw new TypeError('Invalid moderation job batch');
  }
  const jobs = await repository.claim({ limit, leaseSeconds });
  const outcomes = await Promise.allSettled(jobs.map(async (job) => {
    let decision;
    try {
      decision = await evaluateSubmission(job, { provider, policy });
    } catch (error) {
      if (!(error instanceof ProviderUnavailable)) throw error;
      if (job.attempts < policy.maxAttempts) {
        const changed = await repository.retry(job, retryDelay(job.attempts, policy));
        return changed ? 'retried' : 'stale';
      }
      decision = decisionFor([{ category: 'provider_unavailable', risk: 'elevated' }], policy);
    }
    return await repository.complete(job, decision) ? 'completed' : 'stale';
  }));

  const result = { claimed: jobs.length, completed: 0, retried: 0, stale: 0, failed: 0 };
  for (const outcome of outcomes) {
    result[outcome.status === 'fulfilled' ? outcome.value : 'failed'] += 1;
  }
  return result;
}

export function createModerationRepository({ rpc }) {
  function resolve(job, action, reason, signals = {}, delay = 60) {
    return rpc('pixkit_forum_resolve', {
      p_post: job.id,
      p_version: job.version,
      p_lease: job.lease,
      p_action: action,
      p_reason: reason,
      p_signals: signals,
      p_delay_seconds: delay,
    });
  }
  return {
    async claim({ limit, leaseSeconds }) {
      const jobs = await rpc('pixkit_forum_claim', { p_limit: limit, p_lease_seconds: leaseSeconds });
      return jobs.map(({ signals, ...job }) => ({ ...job, context: signals ?? {} }));
    },
    complete(job, { action, risk, reasons, provider, scores, model }) {
      // Only a generic decision code reaches authors. Moderators get the private signals.
      const reason = {
        publish: 'moderation_approved',
        hold: 'moderation_review',
        block: 'moderation_restricted',
        flag: 'moderation_restricted',
      }[action];
      return resolve(job, action, reason, { risk, reasons, provider, scores, ...(model && { model }) });
    },
    retry(job, delay) {
      return resolve(job, 'retry', 'moderation_pending', {}, delay);
    },
  };
}
