-- Run after the learning migration. Tests use PostgreSQL roles and the same
-- request claim that PostgREST exposes to auth.uid().
begin;

insert into auth.users (id, email, raw_user_meta_data, is_anonymous) values
    ('10000000-0000-4000-8000-000000000001', 'alice@example.test', '{"name":"Alice","picture":"https://example.test/avatar.png","roles":["admin"],"tier":"premium"}', false),
    ('10000000-0000-4000-8000-000000000002', 'bob@example.test', '{"name":"Bob","picture":"javascript:alert(1)"}', false),
    ('10000000-0000-4000-8000-000000000003', 'staff@example.test', '{"name":"Moderator"}', false),
    ('10000000-0000-4000-8000-000000000004', null, '{}', true),
    ('10000000-0000-4000-8000-000000000005', 'banned@example.test', '{}', false);
update auth.users set banned_until = now() + interval '1 day'
where id = '10000000-0000-4000-8000-000000000005';
insert into auth.identities (user_id, provider, provider_id, identity_data) values
    ('10000000-0000-4000-8000-000000000001', 'google', 'learning-fixture-google', '{"sub":"learning-fixture-google"}');
insert into pixkit_private.account_roles (user_id, role_id) values
    ('10000000-0000-4000-8000-000000000003', 'moderator');

insert into pixkit_private.entitlements (id) values ('course-fixture');
insert into pixkit_private.tier_entitlements (tier_id, entitlement_id) values ('premium', 'course-fixture');
insert into pixkit_private.account_tiers (user_id, tier_id, starts_at, expires_at) values
    ('10000000-0000-4000-8000-000000000002', 'premium', now() - interval '2 days', now() + interval '1 day');
insert into pixkit_private.entitlement_grants
    (user_id, entitlement_id, source, source_reference, starts_at, expires_at, revoked_at) values
    ('10000000-0000-4000-8000-000000000001', 'course-fixture', 'promotion', 'expired',
        now() - interval '2 days', now() - interval '1 day', null),
    ('10000000-0000-4000-8000-000000000001', 'course-fixture', 'promotion', 'revoked',
        now() - interval '2 days', null, now() - interval '1 day'),
    ('10000000-0000-4000-8000-000000000001', 'course-fixture', 'promotion', 'scheduled',
        now() + interval '1 day', null, null);

insert into pixkit_private.courses (id, title, description, published_at) values
    ('fixture', 'Course', 'English description', now()),
    ('draft', 'Draft', 'Unpublished description', null);
insert into pixkit_private.course_translations (course_id, language, title, description) values
    ('fixture', 'fr', 'Cours', 'Description française');
insert into pixkit_private.lessons
    (course_id, id, position, title, body, access, required_entitlement, published_at) values
    ('fixture', 'preview', 1, 'Preview', 'Public preview', 'public', null, now()),
    ('fixture', 'lesson-one', 2, 'Lesson 1', 'Registered content', 'registered', null, now()),
    ('fixture', 'lesson-two', 3, 'Lesson 2', 'More registered content', 'registered', null, now()),
    ('fixture', 'paid', 4, 'Paid lesson', 'Entitled content', 'entitled', 'course-fixture', now()),
    ('fixture', 'unpublished', 5, 'Draft', 'Hidden body', 'public', null, now() + interval '1 day'),
    ('draft', 'preview', 1, 'Preview', 'Unpublished course', 'public', null, now());
insert into pixkit_private.lesson_translations (course_id, lesson_id, language, title, body) values
    ('fixture', 'preview', 'fr', 'Aperçu', 'Aperçu public');

set local role anon;
do $$
declare
    catalog jsonb := public.pixkit_catalog('fr');
begin
    if jsonb_array_length(catalog) <> 1
       or catalog #>> '{0,title}' is distinct from 'Cours'
       or jsonb_array_length(catalog #> '{0,lessons}') <> 4
       or catalog #>> '{0,lessons,0,id}' is distinct from 'preview'
       or catalog #>> '{0,lessons,0,available}' is distinct from 'true'
       or catalog #>> '{0,lessons,1,available}' is distinct from 'false'
       or catalog::text like '%Registered content%' then
        raise exception 'Guest catalog is incorrect';
    end if;
    if public.pixkit_lesson('fixture', 'preview', 'fr') ->> 'body' is distinct from 'Aperçu public'
       or public.pixkit_lesson('fixture', 'preview', 'ja') ->> 'body' is distinct from 'Public preview'
       or public.pixkit_lesson('fixture', 'lesson-one') is not null
       or public.pixkit_lesson('fixture', 'paid') is not null
       or public.pixkit_lesson('fixture', 'unpublished') is not null
       or public.pixkit_lesson('draft', 'preview') is not null then
        raise exception 'Lesson ACL or localization is incorrect for a guest';
    end if;
    if has_function_privilege(current_user, 'public.pixkit_profile()', 'execute')
       or has_function_privilege(current_user, 'public.pixkit_progress()', 'execute')
       or has_function_privilege(current_user, 'public.pixkit_request_account_deletion()', 'execute')
       or has_schema_privilege(current_user, 'pixkit_private', 'usage') then
        raise exception 'Guest has access to a private RPC or schema';
    end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
do $$
declare
    profile jsonb := public.pixkit_profile();
    completed jsonb;
    retried jsonb;
    imported jsonb;
    lesson_seen_at timestamptz := now() - interval '10 minutes';
begin
    if has_schema_privilege(current_user, 'pixkit_private', 'usage') then
        raise exception 'Members must not directly access learning or privilege tables';
    end if;
    if profile ->> 'email' is distinct from 'alice@example.test'
       or profile ->> 'display_name' is distinct from 'Alice'
       or profile ->> 'avatar_url' is distinct from 'https://example.test/avatar.png'
       or profile -> 'providers' is distinct from '["google"]'::jsonb
       or profile -> 'roles' is distinct from '["user"]'::jsonb
       or profile ->> 'tier' is distinct from 'free' then
        raise exception 'Profile must expose only the current user and their legitimate privileges';
    end if;
    profile := public.pixkit_update_profile(' Alice updated ', 'fr');
    if profile ->> 'display_name' is distinct from 'Alice updated'
       or profile ->> 'preferred_language' is distinct from 'fr'
       or profile -> 'roles' is distinct from '["user"]'::jsonb then
        raise exception 'Profile update did not preserve account privileges or return the new values';
    end if;
    begin
        perform public.pixkit_update_profile('Alice', 'not-a-locale');
        raise exception 'Unsupported locale was accepted';
    exception when invalid_parameter_value then null;
    end;

    if public.pixkit_lesson('fixture', 'lesson-one', 'fr') ->> 'body' is distinct from 'Registered content'
       or public.pixkit_lesson('fixture', 'paid') is not null then
        raise exception 'Free member access should exclude expired, revoked and future grants';
    end if;
    begin
        perform public.pixkit_record_progress('fixture', 'paid', true, lesson_seen_at);
        raise exception 'Progress was accepted for a protected lesson';
    exception when insufficient_privilege then null;
    end;
    begin
        perform public.pixkit_record_progress('fixture', 'lesson-one', true, 'infinity');
        raise exception 'An infinite client timestamp was accepted';
    exception when invalid_parameter_value then null;
    end;

    completed := public.pixkit_record_progress('fixture', 'lesson-one', true, lesson_seen_at);
    retried := public.pixkit_record_progress('fixture', 'lesson-one', true, lesson_seen_at);
    if completed is distinct from retried or completed ->> 'completed_at' is null then
        raise exception 'Repeated completion must preserve original timestamps';
    end if;
    retried := public.pixkit_record_progress('fixture', 'lesson-one', false, lesson_seen_at - interval '1 minute');
    if completed is distinct from retried then
        raise exception 'Stale device update overwrote completion or last access';
    end if;

    perform public.pixkit_record_progress('fixture', 'preview', false, lesson_seen_at);
    imported := public.pixkit_import_progress('[
      {"course_id":"fixture","lesson_id":"preview"},
      {"course_id":"fixture","lesson_id":"preview"},
      {"course_id":"fixture","lesson_id":"lesson-one"},
      {"course_id":"fixture","lesson_id":"lesson-two"},
      {"course_id":"fixture","lesson_id":"paid"},
      {"course_id":"fixture","lesson_id":"unpublished"},
      {"course_id":"draft","lesson_id":"preview"},
      {"course_id":"fixture","lesson_id":"unknown"},
      null
    ]'::jsonb);
    if imported is distinct from '{"imported":2,"ignored":7}'::jsonb
       or public.pixkit_import_progress('[{"course_id":"fixture","lesson_id":"lesson-two"}]'::jsonb)
           is distinct from '{"imported":0,"ignored":1}'::jsonb then
        raise exception 'Guest import did not merge authorized completions idempotently';
    end if;
    if jsonb_array_length(public.pixkit_progress()) <> 3
       or public.pixkit_progress() #>> '{1,last_accessed_at}' is not null
       or (public.pixkit_progress() #>> '{2,last_accessed_at}')::timestamptz is distinct from lesson_seen_at
       or public.pixkit_progress() #>> '{0,completed_at}' is distinct from completed ->> 'completed_at' then
        raise exception 'Guest import changed server completion or resume history';
    end if;
end;
$$;

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
do $$
begin
    if public.pixkit_profile() ->> 'email' is distinct from 'bob@example.test'
       or public.pixkit_profile() ->> 'avatar_url' is not null
       or public.pixkit_profile() ->> 'tier' is distinct from 'premium'
       or public.pixkit_profile() -> 'roles' is distinct from '["user"]'::jsonb
       or public.pixkit_progress() is distinct from '[]'::jsonb
       or public.pixkit_lesson('fixture', 'paid') ->> 'body' is distinct from 'Entitled content' then
        raise exception 'Account isolation or Premium entitlement is incorrect';
    end if;
end;
$$;

reset role;
update pixkit_private.account_tiers set expires_at = now() - interval '1 day'
where user_id = '10000000-0000-4000-8000-000000000002';
insert into pixkit_private.entitlement_grants (user_id, entitlement_id, source, source_reference)
values ('10000000-0000-4000-8000-000000000002', 'course-fixture', 'purchase', 'standalone-fixture');

set local role authenticated;
do $$
begin
    if public.pixkit_profile() ->> 'tier' is distinct from 'free'
       or public.pixkit_lesson('fixture', 'paid') ->> 'body' is distinct from 'Entitled content' then
        raise exception 'Independent purchase should outlive a subscription tier';
    end if;
end;
$$;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', true);
do $$
begin
    if public.pixkit_profile() -> 'roles' is distinct from '["user","moderator"]'::jsonb
       or public.pixkit_lesson('fixture', 'paid') is not null then
        raise exception 'A moderation role must not grant a lesson entitlement';
    end if;
end;
$$;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', true);
do $$
begin
    if public.pixkit_profile() is not null
       or public.pixkit_lesson('fixture', 'lesson-one') is not null then
        raise exception 'Anonymous Auth users are not registered members';
    end if;
end;
$$;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000005', true);
do $$
begin
    if public.pixkit_profile() -> 'roles' is distinct from '[]'::jsonb
       or public.pixkit_profile() ->> 'status' is distinct from 'disabled'
       or public.pixkit_lesson('fixture', 'lesson-one') is not null then
        raise exception 'Banned Auth users must not retain registered access';
    end if;
end;
$$;

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
do $$
declare
    deletion jsonb := '{"id":"10000000-0000-4000-8000-000000000001","status":"deleting"}';
    first_request jsonb;
    retry_request jsonb;
begin
    first_request := public.pixkit_request_account_deletion();
    retry_request := public.pixkit_request_account_deletion();
    if first_request is distinct from deletion
       or retry_request is distinct from deletion
       or public.pixkit_profile() ->> 'status' is distinct from 'deleting'
       or public.pixkit_lesson('fixture', 'lesson-one') is not null
       or public.pixkit_lesson('fixture', 'preview') ->> 'body' is distinct from 'Public preview' then
        raise exception 'Deletion must be retryable and immediately revoke registered access';
    end if;
    begin
        perform public.pixkit_progress();
        raise exception 'A deleting account retained progress access';
    exception when insufficient_privilege then null;
    end;
    begin
        perform public.pixkit_record_progress('fixture', 'preview', false, now());
        raise exception 'A deleting account retained progress write access';
    exception when insufficient_privilege then null;
    end;
end;
$$;
reset role;
delete from auth.users where id = '10000000-0000-4000-8000-000000000001';
do $$
begin
    if exists (select 1 from pixkit_private.profiles where user_id = '10000000-0000-4000-8000-000000000001')
       or exists (select 1 from pixkit_private.lesson_progress where user_id = '10000000-0000-4000-8000-000000000001')
       or exists (select 1 from pixkit_private.entitlement_grants where user_id = '10000000-0000-4000-8000-000000000001') then
        raise exception 'Account deletion must remove account-owned data';
    end if;
end;
$$;

rollback;
