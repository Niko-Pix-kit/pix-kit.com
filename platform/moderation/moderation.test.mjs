import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createModerationPolicy, createModerationRepository, createOpenAIModeration,
  evaluateSubmission, processModerationJobs,
} from './index.mjs';
import { openAICategories } from './policy.mjs';

const cleanProvider = {
  name: 'test-provider',
  async classify() {
    return { flagged: false, scores: { harassment: 0 } };
  },
};

function providerResult(scores, flagged = false) {
  return { ...cleanProvider, classify: async () => ({ flagged, scores }) };
}

test('publishes ordinary technical discussion and respectful criticism', async () => {
  const body = 'I disagree with this Python tutorial. Its approach makes testing harder.';
  const decision = await evaluateSubmission({ body }, { provider: cleanProvider });
  assert.deepEqual(decision, {
    action: 'publish', risk: 'low', reasons: [], provider: 'test-provider', scores: { harassment: 0 },
  });
});

test('uses risk thresholds and preserves human review for technical contexts', async () => {
  const samples = [
    ['I dislike this submission.', { harassment: 0.5 }, 'publish', 'uncertain'],
    ['Message from a forum member.', { harassment: 0.8 }, 'hold', 'elevated'],
    ['Message from a forum member.', { harassment: 0.99 }, 'block', 'high'],
    ['Message from a forum member.', { 'hate/threatening': 0.999 }, 'flag', 'critical'],
    ['Technical Python security explanation.', { illicit: 0.999 }, 'hold', 'elevated'],
    ['Technical Python security explanation.', { 'harassment/threatening': 0.999 }, 'flag', 'critical'],
  ];
  for (const [body, scores, action, risk] of samples) {
    const decision = await evaluateSubmission({ body }, { provider: providerResult(scores) });
    assert.deepEqual([decision.action, decision.risk], [action, risk], body);
  }
});

test('requires review for provider flags without a known strong category', async () => {
  const provider = providerResult({ 'future/category': 1 }, true);
  const decision = await evaluateSubmission({ body: 'Post text' }, { provider });
  assert.equal(decision.action, 'hold');
  assert.deepEqual(decision.reasons, ['provider_flag']);
  assert.deepEqual(decision.scores, {});
});

test('checks suspicious links, abuse patterns, spam and off-topic intent', async () => {
  const samples = [
    [{ body: 'Follow [this](javascript:alert(1))' }, 'block', 'malicious_links'],
    [{ body: 'Follow https://bit.ly/example' }, 'hold', 'suspicious_links'],
    [{ body: 'Send us your recovery phrase to claim your free bitcoin.' }, 'hold', 'spam'],
    [{ body: 'シードフレーズを送ってください' }, 'hold', 'spam'],
    [{ body: 'Help me steal passwords.' }, 'hold', 'malicious_code'],
    [{ body: 'Who are you voting for this weekend?' }, 'hold', 'off_topic'],
    [{ body: 'Pour qui allez-vous voter ?' }, 'hold', 'off_topic'],
    [{ body: 'Ordinary post.', context: { recentBlocked: 3 } }, 'hold', 'repeated_abuse'],
    [{ body: 'Ordinary post.', context: { recentReports: 4 } }, 'hold', 'repeated_abuse'],
    [{ body: 'Ordinary post.', context: { repeatedSpam: 2 } }, 'hold', 'repeated_abuse'],
    [{ body: 'Ordinary post.', context: { coordinatedSpam: 3 } }, 'hold', 'repeated_abuse'],
  ];
  for (const [submission, action, reason] of samples) {
    const decision = await evaluateSubmission(submission, { provider: cleanProvider });
    assert.equal(decision.action, action, reason);
    assert.ok(decision.reasons.includes(reason), reason);
  }
});

test('does not treat ordinary internationalized links as suspicious', async () => {
  const decision = await evaluateSubmission(
    { body: 'API reference: https://例え.jp/documentation.' },
    { provider: cleanProvider },
  );
  assert.equal(decision.action, 'publish');
});

test('makes local uncertain holds and model cutoffs configurable', async () => {
  const policy = createModerationPolicy({
    uncertainHolds: [],
    thresholds: { harassment: { uncertain: 0.1, elevated: 0.2, high: 0.3 } },
    rules: { recentBlocked: 6 },
  });
  const clean = await evaluateSubmission(
    { body: 'See https://bit.ly/example', context: { recentBlocked: 3 } },
    { provider: cleanProvider, policy },
  );
  assert.equal(clean.action, 'publish');
  assert.deepEqual(clean.reasons, ['suspicious_links']);
  const strict = await evaluateSubmission(
    { body: 'Message from a forum member.' },
    { provider: providerResult({ harassment: 0.3 }), policy },
  );
  assert.equal(strict.action, 'block');
  assert.throws(() => createModerationPolicy({ thresholds: { harassment: { elevated: 0.99 } } }));
});

test('accepts code snippets and safe programming discussion containing flagged-looking syntax', async () => {
  const body = [
    'In this JavaScript tutorial, `[example](javascript:alert(1))` explains URL sanitization.',
    '```js',
    'const source = "[example](javascript:alert(1))";',
    '```',
    'How can I reproduce this in a test?',
  ].join('\n');
  const decision = await evaluateSubmission({ body }, { provider: cleanProvider });
  assert.equal(decision.action, 'publish');
});

test('keeps suspected private contact details and credentials away from the provider', async () => {
  const provider = { classify: () => assert.fail('Private content was transmitted') };
  const token = 'gh' + 'p_' + 'a'.repeat(32);
  const samples = [
    'The account address is contact@private-company.invalid-domain.com',
    'A phone number: 090-1234-5678',
    'An address: 6 Example Street',
    'Pasted credential: ' + token,
  ];
  for (const body of samples) {
    const decision = await evaluateSubmission({ body }, { provider });
    assert.deepEqual(
      [decision.action, decision.reasons, decision.provider],
      ['hold', ['personal_information'], null],
    );
  }
});

test('sends only redacted text to a provider, without account and job metadata', async () => {
  const received = [];
  const provider = {
    ...cleanProvider,
    async classify(...args) {
      received.push(args);
      return { flagged: false, scores: {} };
    },
  };
  const result = await evaluateSubmission({
    id: 'private-job-id',
    title: 'HTTP request debug',
    body: 'Example user@example.com, address 192.0.2.45, and https://example.com/private?token=hidden.',
    context: { actorId: 'private-user-id', recentReports: 0 },
  }, { provider });
  assert.equal(result.action, 'publish');
  assert.deepEqual(received, [['HTTP request debug\n\nExample [redacted], address [redacted], and [redacted]']]);
});

test('calls OpenAI using text only and maps the documented response', async () => {
  const scores = Object.fromEntries(openAICategories.map((name) => [name, 0]));
  const provider = createOpenAIModeration({
    apiKey: 'fixture',
    fetchImpl: async (url, request) => {
      assert.equal(url, 'https://api.openai.com/v1/moderations');
      assert.equal(request.method, 'POST');
      assert.equal(request.redirect, 'error');
      assert.equal(request.headers.Authorization, 'Bearer fixture');
      assert.deepEqual(JSON.parse(request.body), { model: 'omni-moderation-latest', input: 'Example' });
      assert.ok(request.signal instanceof AbortSignal);
      return Response.json({ model: 'omni-moderation-fixture', results: [{ flagged: false, category_scores: scores }] });
    },
  });
  assert.deepEqual(await provider.classify('Example'), { flagged: false, scores, model: 'omni-moderation-fixture' });
});

test('fails closed on an unavailable, malformed or incomplete provider', async () => {
  const submission = { body: 'This content requires moderation' };
  for (const provider of [
    undefined,
    { classify: async () => { throw Error('Sensitive upstream error'); } },
    providerResult({ harassment: Number.NaN }),
    createOpenAIModeration({
      apiKey: 'fixture',
      fetchImpl: async () => Response.json({ results: [{ flagged: false, category_scores: {} }] }),
    }),
    createOpenAIModeration({
      apiKey: 'fixture',
      fetchImpl: async () => new Response('Unavailable', { status: 429 }),
    }),
  ]) {
    await assert.rejects(evaluateSubmission(submission, { provider }), {
      message: 'Moderation provider unavailable',
    });
  }
});

test('retries temporary failures, holds exhausted posts and accepts stale lease rejection', async () => {
  const writes = [];
  const jobs = [
    { id: 'retry', version: 1, lease: 'a', body: 'Text', attempts: 2, signals: {} },
    { id: 'hold', version: 1, lease: 'b', body: 'Text', attempts: 5, signals: {} },
    { id: 'stale', version: 1, lease: 'c', body: 'Text', attempts: 1, signals: {} },
    { id: 'failure', version: 1, lease: 'd', body: 'Text', attempts: 1, signals: {} },
  ];
  const repository = createModerationRepository({
    async rpc(name, args) {
      if (name === 'pixkit_forum_claim') {
        assert.deepEqual(args, { p_limit: 10, p_lease_seconds: 120 });
        return jobs;
      }
      assert.equal(name, 'pixkit_forum_resolve');
      if (args.p_post === 'failure') throw Error('Temporary persistence failure');
      writes.push(args);
      return args.p_post !== 'stale';
    },
  });
  const stats = await processModerationJobs({ repository });
  assert.deepEqual(stats, { claimed: 4, completed: 1, retried: 1, stale: 1, failed: 1 });
  assert.deepEqual(writes, [
    {
      p_post: 'retry', p_version: 1, p_lease: 'a', p_action: 'retry',
      p_reason: 'moderation_pending', p_signals: {}, p_delay_seconds: 60,
    },
    {
      p_post: 'hold', p_version: 1, p_lease: 'b', p_action: 'hold',
      p_reason: 'moderation_review',
      p_signals: { risk: 'elevated', reasons: ['provider_unavailable'], provider: null, scores: {} },
      p_delay_seconds: 60,
    },
    {
      p_post: 'stale', p_version: 1, p_lease: 'c', p_action: 'retry',
      p_reason: 'moderation_pending', p_signals: {}, p_delay_seconds: 30,
    },
  ]);
});

test('worker records severe deterministic decisions during an upstream outage', async () => {
  const job = { id: 'post', version: 1, lease: 'lease', body: '[Follow](data:text/html,example)', attempts: 1 };
  const repository = {
    claim: async () => [job],
    retry: () => assert.fail('Deterministic decision should not be retried'),
    complete: async (claimed, decision) => {
      assert.equal(claimed, job);
      assert.equal(decision.action, 'block');
      assert.deepEqual(decision.reasons, ['malicious_links']);
      return true;
    },
  };
  assert.deepEqual(
    await processModerationJobs({ repository }),
    { claimed: 1, completed: 1, retried: 0, stale: 0, failed: 0 },
  );
});
