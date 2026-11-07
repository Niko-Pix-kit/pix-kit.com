import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestDatabase } from '../database-fixture.mjs';
import { createModerationRepository, processModerationJobs } from './index.mjs';

async function scalar(db, statement, args) {
  const { rows } = await db.query(statement, args);
  return rows[0].result;
}

test('applies worker decisions through PostgreSQL without exposing pending content or scores', async (t) => {
  const db = await createTestDatabase();
  t.after(() => db.close());

  const author = '30000000-0000-4000-8000-000000000001';
  await db.query('insert into auth.users (id, email) values ($1, $2)', [author, 'worker@example.test']);
  await db.exec('update pixkit_private.forum_settings set writing_open = true; set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [author]);
  const submit = (title, body) => scalar(db,
    "select public.pixkit_forum_submit(gen_random_uuid(), 'python', null, $1, $2) as result",
    [title, body]);
  const clean = await submit('Python question', 'How can I make this function faster?');
  const harmful = await submit('Unsafe link', 'Open [this](javascript:alert(1))');
  const delayed = await submit('Optional recovery', 'The provider is temporarily unavailable.');

  await db.exec("select set_config('request.jwt.claim.sub', '', false); set role anon");
  const topics = () => scalar(db, 'select public.pixkit_forum_topics() as result');
  assert.deepEqual(await topics(), []);

  await db.exec('set role service_role');
  const repository = createModerationRepository({
    rpc(name, args) {
      if (name === 'pixkit_forum_claim') {
        return scalar(db, 'select public.pixkit_forum_claim($1, $2) as result', [args.p_limit, args.p_lease_seconds]);
      }
      assert.equal(name, 'pixkit_forum_resolve');
      return scalar(db, 'select public.pixkit_forum_resolve($1, $2, $3, $4, $5, $6, $7) as result', [
        args.p_post, args.p_version, args.p_lease, args.p_action, args.p_reason, args.p_signals, args.p_delay_seconds,
      ]);
    },
  });
  const classified = [];
  const provider = {
    name: 'fixture',
    async classify(text) {
      classified.push(text);
      if (text.startsWith('Optional recovery')) throw new Error('Fixture provider outage');
      return { flagged: false, scores: { harassment: 0 }, model: 'fixture-model' };
    },
  };
  assert.deepEqual(await processModerationJobs({ repository, provider }), {
    claimed: 3, completed: 2, retried: 1, stale: 0, failed: 0,
  });
  assert.equal(classified.length, 2);
  assert.ok(classified.every((text) => !text.includes('Unsafe link')));

  await db.exec('reset role');
  const { rows } = await db.query('select id, status from pixkit_private.forum_posts');
  assert.deepEqual(Object.fromEntries(rows.map(({ id, status }) => [id, status])), {
    [clean.id]: 'published',
    [harmful.id]: 'blocked',
    [delayed.id]: 'pending',
  });
  const metadata = await scalar(db, 'select signals as result from pixkit_private.forum_jobs where post_id = $1', [clean.id]);
  assert.equal(metadata.model, 'fixture-model');
  assert.deepEqual(metadata.scores, { harassment: 0 });

  await db.exec('set role anon');
  const published = await topics();
  assert.deepEqual(published.map(({ id }) => id), [clean.id]);
  assert.ok(!JSON.stringify(published).includes('fixture-model'));
});
