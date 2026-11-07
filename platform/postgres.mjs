import { createTestDatabase, runSqlDirectory } from './database-fixture.mjs';

const database = await createTestDatabase();
try {
  console.log('PASS versioned migrations');
  for (const file of await runSqlDirectory(database, 'tests')) console.log(`PASS tests/${file}`);
} finally {
  await database.close();
}
