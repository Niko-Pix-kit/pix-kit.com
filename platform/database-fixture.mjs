import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// PostgreSQL WASM runs the real migrations. The shim models only the Auth
// roles, relations and JWT subject that Supabase injects.
const bootstrap = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb not null default '{}',
    created_at timestamptz default now(),
    last_sign_in_at timestamptz,
    deleted_at timestamptz,
    banned_until timestamptz,
    is_anonymous boolean not null default false
  );
  create table auth.identities (
    user_id uuid not null references auth.users(id) on delete cascade,
    provider text not null,
    provider_id text not null,
    identity_data jsonb not null,
    primary key (provider, provider_id)
  );
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub'
    )::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role'
    )
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
`;
export async function runSqlDirectory(database, directory) {
  const folder = new URL(`./supabase/${directory}/`, import.meta.url);
  const files = (await readdir(folder)).filter((file) => file.endsWith('.sql')).sort();
  if (!files.length) throw new Error(`No SQL files found in ${directory}`);
  for (const file of files) {
    try {
      await database.exec(await readFile(new URL(file, folder), 'utf8'));
    } catch (error) {
      throw new Error(`${directory}/${file}: ${error.message}`, { cause: error });
    }
  }
  return files;
}

export async function createTestDatabase() {
  const database = await PGlite.create();
  try {
    await database.exec(bootstrap);
    await runSqlDirectory(database, 'migrations');
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}
