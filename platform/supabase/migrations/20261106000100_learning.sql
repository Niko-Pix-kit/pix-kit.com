-- Keep content and personal data outside the API schema. The only user-facing
-- grants in this migration are the RPCs listed at the end.
create schema pixkit_private;
revoke all on schema pixkit_private from public, anon, authenticated, service_role;
alter default privileges in schema pixkit_private revoke execute on functions from public;

create table pixkit_private.languages (
    code text primary key
);

insert into pixkit_private.languages (code) values
    ('en'), ('fr'), ('ja'), ('de'), ('es'), ('it'), ('pt'), ('pt-br'), ('nl'),
    ('pl'), ('ru'), ('uk'), ('zh-cn'), ('zh-tw'), ('ko'), ('ar'), ('hi'), ('id'), ('tr');

create table pixkit_private.profiles (
    user_id uuid primary key references auth.users (id) on delete cascade,
    display_name text not null check (
        char_length(display_name) between 1 and 80
        and display_name !~ '[[:cntrl:]]'
    ),
    preferred_language text not null default 'en' references pixkit_private.languages (code),
    avatar_url text,
    status text not null default 'active' check (status in ('active', 'disabled', 'deleting')),
    created_at timestamptz not null default now(),
    last_activity_at timestamptz not null default now()
);

-- Guest and user are derived from the authenticated account. Elevated roles can
-- only be assigned by a trusted database administrator.
create table pixkit_private.elevated_roles (
    id text primary key check (id ~ '^[a-z][a-z0-9-]{0,63}$' and id not in ('user', 'guest'))
);

insert into pixkit_private.elevated_roles (id) values ('moderator'), ('admin');

create table pixkit_private.account_roles (
    user_id uuid not null references pixkit_private.profiles (user_id) on delete cascade,
    role_id text not null references pixkit_private.elevated_roles (id),
    primary key (user_id, role_id)
);

create table pixkit_private.subscription_tiers (
    id text primary key check (id ~ '^[a-z][a-z0-9-]{0,63}$'),
    label text not null check (char_length(label) between 1 and 80),
    is_member_default boolean not null default false
);

create unique index subscription_tiers_single_member_default
    on pixkit_private.subscription_tiers (is_member_default) where is_member_default;

insert into pixkit_private.subscription_tiers (id, label, is_member_default) values
    ('free', 'Free', true), ('premium', 'Premium', false), ('premium-plus', 'Premium Plus', false);

create table pixkit_private.account_tiers (
    user_id uuid primary key references pixkit_private.profiles (user_id) on delete cascade,
    tier_id text not null references pixkit_private.subscription_tiers (id),
    starts_at timestamptz not null default now(),
    expires_at timestamptz,
    check (expires_at is null or expires_at > starts_at)
);

create table pixkit_private.entitlements (
    id text primary key check (id ~ '^[a-z][a-z0-9-]{0,95}$')
);

create table pixkit_private.tier_entitlements (
    tier_id text not null references pixkit_private.subscription_tiers (id) on delete cascade,
    entitlement_id text not null references pixkit_private.entitlements (id) on delete cascade,
    primary key (tier_id, entitlement_id)
);

create table pixkit_private.entitlement_grants (
    user_id uuid not null references pixkit_private.profiles (user_id) on delete cascade,
    entitlement_id text not null references pixkit_private.entitlements (id) on delete cascade,
    source text not null check (source ~ '^[a-z][a-z0-9-]{0,63}$'),
    source_reference text not null check (char_length(source_reference) between 1 and 256),
    starts_at timestamptz not null default now(),
    expires_at timestamptz,
    revoked_at timestamptz,
    primary key (user_id, entitlement_id, source, source_reference),
    check (expires_at is null or expires_at > starts_at)
);

-- English is canonical; localized URLs and content titles never identify lessons.
create table pixkit_private.courses (
    id text primary key check (char_length(id) <= 96 and id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    title text not null check (char_length(title) between 1 and 160),
    description text not null check (char_length(description) between 1 and 4000),
    published_at timestamptz
);

create table pixkit_private.course_translations (
    course_id text not null references pixkit_private.courses (id) on delete cascade,
    language text not null references pixkit_private.languages (code) check (language <> 'en'),
    title text not null check (char_length(title) between 1 and 160),
    description text not null check (char_length(description) between 1 and 4000),
    primary key (course_id, language)
);

create table pixkit_private.lessons (
    course_id text not null references pixkit_private.courses (id) on delete cascade,
    id text not null check (char_length(id) <= 96 and id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    position integer not null check (position > 0),
    title text not null check (char_length(title) between 1 and 160),
    body text not null check (octet_length(body) between 1 and 250000),
    access text not null default 'registered' check (access in ('public', 'registered', 'entitled')),
    required_entitlement text references pixkit_private.entitlements (id),
    published_at timestamptz,
    primary key (course_id, id),
    unique (course_id, position) deferrable initially immediate,
    check ((access = 'entitled') = (required_entitlement is not null))
);

create table pixkit_private.lesson_translations (
    course_id text not null,
    lesson_id text not null,
    language text not null references pixkit_private.languages (code) check (language <> 'en'),
    title text not null check (char_length(title) between 1 and 160),
    body text not null check (octet_length(body) between 1 and 250000),
    primary key (course_id, lesson_id, language),
    foreign key (course_id, lesson_id) references pixkit_private.lessons (course_id, id) on delete cascade
);

create table pixkit_private.lesson_progress (
    user_id uuid not null references pixkit_private.profiles (user_id) on delete cascade,
    course_id text not null,
    lesson_id text not null,
    completed_at timestamptz,
    last_accessed_at timestamptz,
    primary key (user_id, course_id, lesson_id),
    foreign key (course_id, lesson_id) references pixkit_private.lessons (course_id, id) on delete restrict,
    check (completed_at is not null or last_accessed_at is not null)
);

create index lesson_progress_lesson on pixkit_private.lesson_progress (course_id, lesson_id);

alter table pixkit_private.languages enable row level security;
alter table pixkit_private.profiles enable row level security;
alter table pixkit_private.elevated_roles enable row level security;
alter table pixkit_private.account_roles enable row level security;
alter table pixkit_private.subscription_tiers enable row level security;
alter table pixkit_private.account_tiers enable row level security;
alter table pixkit_private.entitlements enable row level security;
alter table pixkit_private.tier_entitlements enable row level security;
alter table pixkit_private.entitlement_grants enable row level security;
alter table pixkit_private.courses enable row level security;
alter table pixkit_private.course_translations enable row level security;
alter table pixkit_private.lessons enable row level security;
alter table pixkit_private.lesson_translations enable row level security;
alter table pixkit_private.lesson_progress enable row level security;

revoke all on all tables in schema pixkit_private from public, anon, authenticated, service_role;

create function pixkit_private.seed_display_name(p_metadata jsonb)
returns text
language sql immutable
set search_path = ''
as $$
    select coalesce(
        nullif(left(btrim(regexp_replace(coalesce(
            nullif(p_metadata ->> 'full_name', ''),
            p_metadata ->> 'name',
            ''
        ), '[[:cntrl:]]', '', 'g')), 80), ''),
        'Member'
    );
$$;

create function pixkit_private.seed_avatar_url(p_metadata jsonb)
returns text
language sql immutable
set search_path = ''
as $$
    select avatar.url
    from (select coalesce(p_metadata ->> 'avatar_url', p_metadata ->> 'picture') as url) as avatar
    where char_length(avatar.url) <= 2048 and avatar.url ~ '^https://[^[:space:][:cntrl:]]+$';
$$;

create function pixkit_private.create_profile()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
    insert into pixkit_private.profiles (user_id, display_name, avatar_url, created_at, last_activity_at)
    values (
        new.id, pixkit_private.seed_display_name(new.raw_user_meta_data),
        pixkit_private.seed_avatar_url(new.raw_user_meta_data),
        coalesce(new.created_at, statement_timestamp()),
        coalesce(new.last_sign_in_at, new.created_at, statement_timestamp())
    );
    return new;
end;
$$;

create trigger pixkit_auth_user_created
after insert on auth.users
for each row execute function pixkit_private.create_profile();

insert into pixkit_private.profiles (user_id, display_name, avatar_url, created_at, last_activity_at)
select
    u.id, pixkit_private.seed_display_name(u.raw_user_meta_data),
    pixkit_private.seed_avatar_url(u.raw_user_meta_data),
    coalesce(u.created_at, statement_timestamp()),
    coalesce(u.last_sign_in_at, u.created_at, statement_timestamp())
from auth.users as u
on conflict (user_id) do nothing;

create function pixkit_private.is_active_user()
returns boolean
language sql stable
set search_path = ''
as $$
    select exists (
        select 1
        from pixkit_private.profiles as p
        join auth.users as u on u.id = p.user_id
        where p.user_id = auth.uid()
          and p.status = 'active'
          and not u.is_anonymous
          and u.deleted_at is null
          and (u.banned_until is null or u.banned_until <= statement_timestamp())
    );
$$;

create function pixkit_private.has_role(p_role text)
returns boolean
language sql stable
set search_path = ''
as $$
    select case
        when p_role = 'guest' then auth.uid() is null
        when p_role = 'user' then pixkit_private.is_active_user()
        else pixkit_private.is_active_user() and exists (
            select 1 from pixkit_private.account_roles as r
            where r.user_id = auth.uid() and r.role_id = p_role
        )
    end;
$$;

-- Serialize an account's writes with the transition to deleting. The
-- authentication and profile restrictions are checked while holding the lock.
create function pixkit_private.lock_active_user()
returns uuid
language plpgsql
set search_path = ''
as $$
declare
    user_id_value uuid := auth.uid();
begin
    perform 1 from pixkit_private.profiles where user_id = user_id_value for update;
    if not pixkit_private.is_active_user() then
        raise exception using errcode = '42501', message = 'An active account is required';
    end if;
    return user_id_value;
end;
$$;

create function pixkit_private.current_tier()
returns text
language sql stable
set search_path = ''
as $$
    select coalesce(
        (select a.tier_id from pixkit_private.account_tiers as a
         where a.user_id = auth.uid()
           and a.starts_at <= statement_timestamp()
           and (a.expires_at is null or a.expires_at > statement_timestamp())),
        (select t.id from pixkit_private.subscription_tiers as t where t.is_member_default)
    );
$$;

create function pixkit_private.can_read_lesson(p_access text, p_entitlement text)
returns boolean
language sql stable
set search_path = ''
as $$
    select case p_access
        when 'public' then true
        when 'registered' then pixkit_private.is_active_user()
        when 'entitled' then pixkit_private.is_active_user() and (
            exists (
                select 1 from pixkit_private.tier_entitlements as t
                where t.tier_id = pixkit_private.current_tier() and t.entitlement_id = p_entitlement
            ) or exists (
                select 1 from pixkit_private.entitlement_grants as g
                where g.user_id = auth.uid() and g.entitlement_id = p_entitlement
                  and g.starts_at <= statement_timestamp()
                  and (g.expires_at is null or g.expires_at > statement_timestamp())
                  and g.revoked_at is null
            )
        )
        else false
    end;
$$;

create function public.pixkit_profile()
returns jsonb
language sql stable security definer
set search_path = ''
as $$
    select jsonb_build_object(
        'id', p.user_id, 'display_name', p.display_name, 'email', u.email,
        'providers', coalesce(
            (select jsonb_agg(distinct i.provider order by i.provider)
             from auth.identities as i where i.user_id = p.user_id), '[]'::jsonb
        ),
        'created_at', p.created_at,
        'last_activity_at', greatest(p.last_activity_at, u.last_sign_in_at),
        'preferred_language', p.preferred_language, 'avatar_url', p.avatar_url,
        'status', case
            when p.status = 'active' and not pixkit_private.is_active_user() then 'disabled'
            else p.status
        end,
        'roles', case when pixkit_private.is_active_user() then jsonb_build_array('user') || coalesce(
            (select jsonb_agg(r.role_id order by r.role_id) from pixkit_private.account_roles as r
             where r.user_id = p.user_id), '[]'::jsonb
        ) else '[]'::jsonb end,
        'tier', case when pixkit_private.is_active_user() then pixkit_private.current_tier() end
    )
    from pixkit_private.profiles as p
    join auth.users as u on u.id = p.user_id
    where p.user_id = auth.uid() and not u.is_anonymous and u.deleted_at is null;
$$;

create function public.pixkit_update_profile(p_display_name text, p_preferred_language text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
    display_name_value text := btrim(p_display_name);
    user_id_value uuid := pixkit_private.lock_active_user();
begin
    if display_name_value is null or char_length(display_name_value) not between 1 and 80
       or display_name_value ~ '[[:cntrl:]]'
       or not exists (select 1 from pixkit_private.languages where code = p_preferred_language) then
        raise exception using errcode = '22023', message = 'Invalid profile';
    end if;

    update pixkit_private.profiles
    set display_name = display_name_value, preferred_language = p_preferred_language,
        last_activity_at = greatest(last_activity_at, statement_timestamp())
    where user_id = user_id_value;
    return public.pixkit_profile();
end;
$$;

-- The account becomes inactive before the server calls the Auth Admin API.
-- A failed upstream deletion can be retried without reactivating the account.
create function public.pixkit_request_account_deletion()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
    deleting_user_id uuid;
begin
    update pixkit_private.profiles as p set status = 'deleting'
    from auth.users as u
    where p.user_id = auth.uid() and u.id = p.user_id and not u.is_anonymous and u.deleted_at is null
    returning p.user_id into deleting_user_id;
    if not found then
        raise exception using errcode = '42501', message = 'A registered account is required';
    end if;
    return jsonb_build_object('id', deleting_user_id, 'status', 'deleting');
end;
$$;

create function public.pixkit_catalog(p_locale text default 'en')
returns jsonb
language sql stable security definer
set search_path = ''
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id,
        'title', coalesce(ct.title, c.title),
        'description', coalesce(ct.description, c.description),
        'lessons', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', l.id,
                'title', coalesce(lt.title, l.title),
                'position', l.position,
                'access', l.access,
                'available', pixkit_private.can_read_lesson(l.access, l.required_entitlement)
            ) order by l.position)
            from pixkit_private.lessons as l
            left join pixkit_private.lesson_translations as lt
                on lt.course_id = l.course_id and lt.lesson_id = l.id and lt.language = p_locale
            where l.course_id = c.id and l.published_at <= statement_timestamp()
        ), '[]'::jsonb)
    ) order by c.id), '[]'::jsonb)
    from pixkit_private.courses as c
    left join pixkit_private.course_translations as ct on ct.course_id = c.id and ct.language = p_locale
    where c.published_at <= statement_timestamp();
$$;

create function public.pixkit_lesson(p_course_id text, p_lesson_id text, p_locale text default 'en')
returns jsonb
language sql stable security definer
set search_path = ''
as $$
    select jsonb_build_object(
        'id', l.id, 'course_id', l.course_id, 'title', coalesce(lt.title, l.title),
        'body', coalesce(lt.body, l.body), 'access', l.access
    )
    from pixkit_private.lessons as l
    join pixkit_private.courses as c on c.id = l.course_id
    left join pixkit_private.lesson_translations as lt
        on lt.course_id = l.course_id and lt.lesson_id = l.id and lt.language = p_locale
    where l.course_id = p_course_id and l.id = p_lesson_id
      and l.published_at <= statement_timestamp() and c.published_at <= statement_timestamp()
      and pixkit_private.can_read_lesson(l.access, l.required_entitlement);
$$;

create function public.pixkit_progress()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
    if not pixkit_private.is_active_user() then
        raise exception using errcode = '42501', message = 'An active account is required';
    end if;

    return (
        select coalesce(jsonb_agg(jsonb_build_object(
            'course_id', p.course_id, 'lesson_id', p.lesson_id, 'completed_at', p.completed_at,
            'last_accessed_at', p.last_accessed_at
        ) order by p.course_id, p.lesson_id), '[]'::jsonb)
        from pixkit_private.lesson_progress as p where p.user_id = auth.uid()
    );
end;
$$;

create function public.pixkit_record_progress(
    p_course_id text, p_lesson_id text, p_completed boolean, p_seen_at timestamptz
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
    progress pixkit_private.lesson_progress;
    user_id_value uuid := pixkit_private.lock_active_user();
begin
    if p_completed is null or p_seen_at is null or not isfinite(p_seen_at)
       or p_seen_at > statement_timestamp() + interval '2 minutes' then
        raise exception using errcode = '22023', message = 'Invalid progress update';
    end if;
    if not exists (
        select 1 from pixkit_private.lessons as l
        join pixkit_private.courses as c on c.id = l.course_id
        where l.course_id = p_course_id and l.id = p_lesson_id
          and l.published_at <= statement_timestamp() and c.published_at <= statement_timestamp()
          and pixkit_private.can_read_lesson(l.access, l.required_entitlement)
    ) then
        raise exception using errcode = '42501', message = 'This lesson is unavailable';
    end if;

    insert into pixkit_private.lesson_progress as current_progress
        (user_id, course_id, lesson_id, completed_at, last_accessed_at)
    values (
        user_id_value, p_course_id, p_lesson_id,
        case when p_completed then statement_timestamp() end, p_seen_at
    )
    on conflict (user_id, course_id, lesson_id) do update
        set completed_at = coalesce(current_progress.completed_at, excluded.completed_at),
            last_accessed_at = greatest(current_progress.last_accessed_at, excluded.last_accessed_at)
    returning * into progress;

    update pixkit_private.profiles
    set last_activity_at = greatest(last_activity_at, least(p_seen_at, statement_timestamp()))
    where user_id = user_id_value;

    return jsonb_build_object(
        'course_id', progress.course_id, 'lesson_id', progress.lesson_id,
        'completed_at', progress.completed_at, 'last_accessed_at', progress.last_accessed_at
    );
end;
$$;

create function public.pixkit_import_progress(p_completed jsonb)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
    submitted integer;
    imported integer;
    user_id_value uuid := pixkit_private.lock_active_user();
begin
    if jsonb_typeof(p_completed) is distinct from 'array' or pg_column_size(p_completed) > 65536 then
        raise exception using errcode = '22023', message = 'Invalid progress import';
    end if;
    submitted := jsonb_array_length(p_completed);
    if submitted > 200 then
        raise exception using errcode = '22023', message = 'Progress import is limited to 200 entries';
    end if;

    insert into pixkit_private.lesson_progress as current_progress (user_id, course_id, lesson_id, completed_at)
    select user_id_value, l.course_id, l.id, statement_timestamp()
    from pixkit_private.lessons as l
    join pixkit_private.courses as c on c.id = l.course_id
    join (
        select distinct entry ->> 'course_id' as course_id, entry ->> 'lesson_id' as lesson_id
        from jsonb_array_elements(p_completed) as entries(entry)
        where jsonb_typeof(entry -> 'course_id') = 'string'
          and jsonb_typeof(entry -> 'lesson_id') = 'string'
    ) as incoming on incoming.course_id = l.course_id and incoming.lesson_id = l.id
    where l.published_at <= statement_timestamp() and c.published_at <= statement_timestamp()
      and pixkit_private.can_read_lesson(l.access, l.required_entitlement)
    order by l.course_id, l.id
    on conflict (user_id, course_id, lesson_id) do update
        set completed_at = excluded.completed_at
        where current_progress.completed_at is null;
    get diagnostics imported = row_count;

    if imported > 0 then
        update pixkit_private.profiles
        set last_activity_at = greatest(last_activity_at, statement_timestamp())
        where user_id = user_id_value;
    end if;

    return jsonb_build_object('imported', imported, 'ignored', submitted - imported);
end;
$$;

revoke all on all functions in schema pixkit_private from public, anon, authenticated, service_role;
revoke all on function
    public.pixkit_profile(),
    public.pixkit_update_profile(text, text),
    public.pixkit_request_account_deletion(),
    public.pixkit_catalog(text),
    public.pixkit_lesson(text, text, text),
    public.pixkit_progress(),
    public.pixkit_record_progress(text, text, boolean, timestamptz),
    public.pixkit_import_progress(jsonb)
from public, anon, authenticated, service_role;

grant execute on function
    public.pixkit_catalog(text),
    public.pixkit_lesson(text, text, text)
to anon, authenticated;

grant execute on function
    public.pixkit_profile(),
    public.pixkit_update_profile(text, text),
    public.pixkit_request_account_deletion(),
    public.pixkit_progress(),
    public.pixkit_record_progress(text, text, boolean, timestamptz),
    public.pixkit_import_progress(jsonb)
to authenticated;
