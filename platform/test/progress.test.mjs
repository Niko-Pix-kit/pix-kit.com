import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { createTestDatabase } from '../database-fixture.mjs';
import { createPlatform } from '../server/app.mjs';
import { HttpError } from '../server/backend.mjs';

const origin = 'https://pixkit.example.test';
const first = '10000000-0000-4000-8000-000000000001';
const second = '10000000-0000-4000-8000-000000000002';
const browserToken = (sub, browser) =>
  'header.' + Buffer.from(JSON.stringify({ sub, exp: 2 ** 31 - 1 })).toString('base64url') + '.' + browser;

test('a second device resumes persisted completion, while another account stays isolated', async () => {
  const database = await createTestDatabase();
  try {
    await database.query('insert into auth.users (id) values ($1), ($2)', [first, second]);
    await database.exec(`
      insert into pixkit_private.courses (id, title, description, published_at)
        values ('example', 'Example course', 'Test course', now());
      insert into pixkit_private.lessons (course_id, id, position, title, body, access, published_at)
        values ('example', 'lesson-one', 1, 'First lesson', 'Fixture text', 'registered', now());
    `);
    const laptop = browserToken(first, 'laptop');
    const phone = browserToken(first, 'phone');
    const other = browserToken(second, 'other');
    const subjects = new Map([[laptop, first], [phone, first], [other, second]]);
    const methods = {
      pixkit_progress: ['select public.pixkit_progress() as result', () => []],
      pixkit_record_progress: [
        'select public.pixkit_record_progress($1, $2, $3, $4) as result',
        (params) => [params.p_course_id, params.p_lesson_id, params.p_completed, params.p_seen_at],
      ],
    };
    const backend = {
      async rpc(name, params, access) {
        const subject = subjects.get(access);
        if (!subject) throw new HttpError(401, 'authentication_failed');
        const [sql, argumentsFor] = methods[name];
        return database.transaction(async (transaction) => {
          await transaction.exec('set local role authenticated');
          await transaction.query("select set_config('request.jwt.claim.sub', $1, true)", [subject]);
          const { rows } = await transaction.query(sql, argumentsFor(params));
          return rows[0].result;
        });
      },
    };
    const handle = createPlatform({ origin, languages: ['en'], backend });
    const progress = origin + '/api/learning/progress';
    const headers = (access) => ({ cookie: '__Host-pixkit-access=' + access });
    const completion = {
      p_course_id: 'example', p_lesson_id: 'lesson-one', p_completed: true,
      p_seen_at: new Date().toISOString(),
    };
    const finish = () => handle(new Request(progress, {
      method: 'POST',
      headers: { ...headers(laptop), origin, 'content-type': 'application/json' },
      body: JSON.stringify(completion),
    }));
    const saved = await finish();
    assert.equal(saved.status, 200);
    const row = await saved.json();
    assert.ok(row.completed_at);
    assert.deepEqual(await (await finish()).json(), row);
    const sameAccount = await handle(new Request(progress, { headers: headers(phone) }));
    assert.deepEqual(await sameAccount.json(), [row]);
    const anotherAccount = await handle(new Request(progress, { headers: headers(other) }));
    assert.deepEqual(await anotherAccount.json(), []);
  } finally {
    await database.close();
  }
});
