-- Exercise the actual RPC grants with separate identities and a leased job queue.
begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('20000000-0000-4000-8000-000000000001', 'forum-a@example.test', '{"name":"Community A"}'),
  ('20000000-0000-4000-8000-000000000002', 'forum-b@example.test', '{"name":"Community B"}'),
  ('20000000-0000-4000-8000-000000000003', 'forum-mod@example.test', '{"name":"Moderator"}'),
  ('20000000-0000-4000-8000-000000000004', 'forum-admin@example.test', '{"name":"Administrator"}');
insert into pixkit_private.account_roles (user_id, role_id) values
  ('20000000-0000-4000-8000-000000000003', 'moderator'),
  ('20000000-0000-4000-8000-000000000004', 'admin');

set local role anon;
do $$
begin
  if public.pixkit_forum_settings() ->> 'writing_open' is distinct from 'false'
    or jsonb_array_length(public.pixkit_forum_categories()) <> 9
    or public.pixkit_forum_topics() is distinct from '[]'::jsonb
    or has_schema_privilege(current_user, 'pixkit_private', 'usage')
    or has_function_privilege(current_user, 'public.pixkit_forum_submit(uuid,text,uuid,text,text)', 'execute') then
    raise exception 'The initial guest forum is not read-only';
  end if;
end
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', true);
do $$
begin
  begin
    perform public.pixkit_forum_submit(gen_random_uuid(), 'python', null, 'Closed', 'This should fail');
    raise exception 'Public submission was enabled by default';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.pixkit_forum_queue();
    raise exception 'A regular member accessed the moderation queue';
  exception when insufficient_privilege then
    null;
  end;
  if has_schema_privilege(current_user, 'pixkit_private', 'usage')
    or has_function_privilege(current_user, 'public.pixkit_forum_claim(integer,integer)', 'execute')
    or has_function_privilege(current_user, 'public.pixkit_forum_resolve(uuid,integer,uuid,text,text,jsonb,integer)', 'execute')
    or has_function_privilege(current_user, 'public.pixkit_forum_prune()', 'execute') then
    raise exception 'A regular member has direct private or service privileges';
  end if;
end
$$;

reset role;
update pixkit_private.forum_settings set writing_open = true;

set local role authenticated;
do $$
declare
  request uuid := gen_random_uuid();
  submitted jsonb;
begin
  submitted := public.pixkit_forum_submit(request, 'python', null, '配列 tutorial', 'Initial post');
  if submitted ->> 'status' is distinct from 'pending'
    or public.pixkit_forum_submit(request, 'python', null, '配列 tutorial', 'Initial post') is distinct from submitted
    or public.pixkit_forum_thread((submitted->>'id')::uuid) is not null
    or public.pixkit_forum_activity() #>> '{posts,0,body}' is distinct from 'Initial post' then
    raise exception 'Submission is not pending, idempotent or correctly scoped to its author';
  end if;
  perform set_config('forum.test.topic', submitted->>'id', true);
end
$$;

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
do $$
declare
  topic uuid := current_setting('forum.test.topic')::uuid;
begin
  if public.pixkit_forum_activity()->'posts' is distinct from '[]'::jsonb then
    raise exception 'A member read another member''s pending post';
  end if;
  begin
    perform public.pixkit_forum_edit(topic, 1, 'Unauthorised edit', 'Altered content');
    raise exception 'A member edited someone else''s post';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.pixkit_forum_delete(topic);
    raise exception 'A member deleted someone else''s post';
  exception when insufficient_privilege then
    null;
  end;
end
$$;

set local role service_role;
do $$
declare
  topic uuid := current_setting('forum.test.topic')::uuid;
  claim jsonb := public.pixkit_forum_claim();
  leased uuid := (claim #>> '{0,lease}')::uuid;
begin
  if jsonb_array_length(claim) <> 1
    or claim #>> '{0,id}' is distinct from topic::text
    or claim #>> '{0,attempts}' is distinct from '1'
    or public.pixkit_forum_claim() is distinct from '[]'::jsonb
    or public.pixkit_forum_resolve(topic, 1, gen_random_uuid(), 'publish', 'moderation_passed') then
    raise exception 'Lease claim, attempt count or stale lease handling is incorrect';
  end if;
  if not public.pixkit_forum_resolve(topic, 1, leased, 'publish', 'moderation_passed',
    '{"provider":"test-provider","scores":{"harassment":0.123}}')
    or public.pixkit_forum_resolve(topic, 1, leased, 'block', 'moderation_blocked') then
    raise exception 'The moderation lease could not complete exactly once';
  end if;
end
$$;

set local role anon;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare
  topic uuid := current_setting('forum.test.topic')::uuid;
  thread jsonb := public.pixkit_forum_thread(topic);
  topics jsonb := public.pixkit_forum_topics('python', 'recent', '配列');
begin
  if thread #>> '{topic,body}' is distinct from 'Initial post'
    or thread #>> '{topic,author}' is distinct from 'Community A'
    or thread #>> '{topic,own}' is distinct from 'false'
    or thread::text like '%harassment%'
    or topics #>> '{0,id}' is distinct from topic::text
    or public.pixkit_forum_topics('python', 'top', '%') is distinct from '[]'::jsonb then
    raise exception 'Public forum visibility, privacy or literal search is incorrect';
  end if;
end
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
do $$
declare
  topic uuid := current_setting('forum.test.topic')::uuid;
  reply jsonb;
begin
  perform public.pixkit_forum_vote(topic, 1);
  perform public.pixkit_forum_vote(topic, 1);
  perform public.pixkit_forum_report(topic, 'Check the example');
  perform public.pixkit_forum_report(topic, 'Duplicate reason should not overwrite');
  if public.pixkit_forum_thread(topic) #>> '{topic,score}' is distinct from '1'
    or public.pixkit_forum_thread(topic) #>> '{topic,vote}' is distinct from '1' then
    raise exception 'A repeated vote was not idempotent';
  end if;
  reply := public.pixkit_forum_submit(gen_random_uuid(), null, topic, null, 'A reply awaiting review');
  perform set_config('forum.test.reply', reply->>'id', true);
end
$$;

set local role service_role;
do $$
declare
  reply uuid := current_setting('forum.test.reply')::uuid;
  claim jsonb := public.pixkit_forum_claim();
begin
  if claim #>> '{0,id}' is distinct from reply::text
    or not public.pixkit_forum_resolve(reply, 1, (claim #>> '{0,lease}')::uuid, 'block',
      'moderation_review', '{"reasons":["spam"],"scores":{"spam":0.2}}') then
    raise exception 'The reply was not blocked';
  end if;
end
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000003', true);
do $$
declare
  reply uuid := current_setting('forum.test.reply')::uuid;
  blocked jsonb := public.pixkit_forum_queue('blocked');
begin
  if blocked #>> '{posts,0,id}' is distinct from reply::text
    or blocked ->> 'total' is distinct from '1'
    or public.pixkit_forum_queue('blocked', 50) -> 'posts' is distinct from '[]'::jsonb then
    raise exception 'Moderators cannot inspect an automated block before appeal';
  end if;
end
$$;

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
do $$
declare
  reply uuid := current_setting('forum.test.reply')::uuid;
  activity jsonb;
begin
  perform public.pixkit_forum_appeal(reply, 'This answers a technical question');
  perform public.pixkit_forum_appeal(reply, 'Do not replace the pending appeal');
  activity := public.pixkit_forum_activity();
  if activity #>> '{posts,0,status}' is distinct from 'blocked'
    or activity #>> '{posts,0,reason}' is distinct from 'moderation_review'
    or activity #>> '{posts,0,appeal,reason}' is distinct from 'This answers a technical question'
    or activity::text like '%"scores"%' then
    raise exception 'The author cannot see their restriction and appeal, or sees private signals';
  end if;
end
$$;

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000003', true);
do $$
declare
  topic uuid := current_setting('forum.test.topic')::uuid;
  reply uuid := current_setting('forum.test.reply')::uuid;
  queue jsonb := public.pixkit_forum_queue();
begin
  if jsonb_array_length(queue->'posts') <> 2
    or queue::text not like '%"harassment": 0.123%'
    or queue::text not like '%Check the example%'
    or queue::text like '%Duplicate reason should not overwrite%' then
    raise exception 'Moderation queue does not include restricted signals and unique reports';
  end if;
  perform public.pixkit_forum_review(reply, 1, 'appeal_accept', 'Technical discussion');
  perform public.pixkit_forum_review(topic, 1, 'publish', 'Report reviewed');
  if public.pixkit_forum_queue()->'posts' is distinct from '[]'::jsonb
    or public.pixkit_forum_thread(topic) #>> '{replies,0,depth}' is distinct from '1' then
    raise exception 'The report or appeal was not resolved';
  end if;
end
$$;

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', true);
do $$
declare
  topic uuid := current_setting('forum.test.topic')::uuid;
  edited jsonb;
begin
  edited := public.pixkit_forum_edit(topic, 1, 'Revised tutorial', 'Revised material');
  if edited->>'version' is distinct from '2'
    or edited->>'status' is distinct from 'pending'
    or public.pixkit_forum_thread(topic) is not null
    or public.pixkit_forum_edit(topic, 1, 'Revised tutorial', 'Revised material') is distinct from edited then
    raise exception 'Editing failed to create an idempotent new moderated revision';
  end if;
end
$$;

set local role service_role;
do $$
declare
  topic uuid := current_setting('forum.test.topic')::uuid;
  claim jsonb := public.pixkit_forum_claim();
  lease_id uuid := (claim #>> '{0,lease}')::uuid;
begin
  if claim #>> '{0,id}' is distinct from topic::text
    or claim #>> '{0,version}' is distinct from '2'
    or not public.pixkit_forum_resolve(topic, 2, lease_id, 'retry', 'moderation_pending', '{}', 10)
    or public.pixkit_forum_claim() is distinct from '[]'::jsonb then
    raise exception 'Provider failure did not postpone the current revision';
  end if;
  perform set_config('forum.test.stale_lease', lease_id::text, true);
end
$$;

reset role;
update pixkit_private.forum_jobs
  set available_at = statement_timestamp() - interval '1 second'
  where post_id = current_setting('forum.test.topic')::uuid and version = 2;

set local role service_role;
do $$
declare
  topic uuid := current_setting('forum.test.topic')::uuid;
  claim jsonb := public.pixkit_forum_claim();
  lease_id uuid := (claim #>> '{0,lease}')::uuid;
begin
  if claim #>> '{0,id}' is distinct from topic::text
    or claim #>> '{0,attempts}' is distinct from '2'
    or public.pixkit_forum_resolve(topic, 2, current_setting('forum.test.stale_lease')::uuid,
        'publish', 'moderation_passed')
    or not public.pixkit_forum_resolve(topic, 2, lease_id, 'publish', 'moderation_passed') then
    raise exception 'Retry did not preserve the version and enforce a fresh lease';
  end if;
  perform public.pixkit_forum_prune();
end
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000003', true);
do $$
declare
  member uuid := '20000000-0000-4000-8000-000000000002';
begin
  perform public.pixkit_forum_sanction(member, 'suspend', 'Temporary restriction', 1);
  begin
    perform public.pixkit_forum_sanction(member, 'ban', 'Requires administrator');
    raise exception 'Moderator issued a permanent ban';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.pixkit_forum_sanction('20000000-0000-4000-8000-000000000004', 'suspend', 'Targeting staff', 1);
    raise exception 'Moderator suspended an administrator';
  exception when insufficient_privilege then
    null;
  end;
end
$$;

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
do $$
declare
  topic uuid := current_setting('forum.test.topic')::uuid;
  reply uuid := current_setting('forum.test.reply')::uuid;
begin
  if public.pixkit_forum_activity() #>> '{sanctions,0,action}' is distinct from 'suspend'
    or public.pixkit_forum_activity() #>> '{posts,0,appeal,status}' is distinct from 'accepted' then
    raise exception 'User cannot see their restriction or resolved appeal';
  end if;
  begin
    perform public.pixkit_forum_submit(gen_random_uuid(), 'python', null, 'Suspended', 'Should not publish');
    raise exception 'Suspended member was able to submit';
  exception when insufficient_privilege then
    null;
  end;
  perform public.pixkit_forum_delete(reply);
  if public.pixkit_forum_thread(topic) #>> '{replies,0,deleted}' is distinct from 'true'
    or public.pixkit_forum_thread(topic) #>> '{replies,0,author}' is not null then
    raise exception 'The author could not erase their reply body or author label while suspended';
  end if;
end
$$;

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000004', true);
select public.pixkit_forum_sanction('20000000-0000-4000-8000-000000000002', 'restore', 'Suspension lifted');

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
do $$
begin
  for attempt in 1..5 loop
    perform public.pixkit_forum_submit(gen_random_uuid(), 'python', null, 'Rate limited', 'Test forum throughput');
  end loop;
  begin
    perform public.pixkit_forum_submit(gen_random_uuid(), 'python', null, 'Over the limit', 'Should be rate limited');
    raise exception 'Forum submission rate limit failed';
  exception when sqlstate 'PT429' then
    null;
  end;
end
$$;

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', true);
select set_config('forum.test.unpublished', public.pixkit_forum_submit(gen_random_uuid(), 'python', null,
  'A draft', 'This unpublished content must be erased')->>'id', true);

reset role;
delete from auth.users where id = '20000000-0000-4000-8000-000000000001';
do $$
begin
  if not exists (
    select from pixkit_private.forum_posts where id = current_setting('forum.test.unpublished')::uuid
      and body is null and title = '' and status = 'deleted' and author_id is null
  ) then
    raise exception 'Unpublished material survived account deletion';
  end if;
end
$$;

set local role anon;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare
  thread jsonb := public.pixkit_forum_thread(current_setting('forum.test.topic')::uuid);
begin
  if thread #>> '{topic,author}' is not null
    or thread #>> '{topic,body}' is distinct from 'Revised material' then
    raise exception 'Published discussion was not anonymized and preserved after account deletion';
  end if;
end
$$;

rollback;
