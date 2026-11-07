-- PixKit Community. Requires the account migration and its private authorization helpers.
create table pixkit_private.forum_settings (
  singleton boolean primary key default true check (singleton),
  writing_open boolean not null default false
);
insert into pixkit_private.forum_settings default values;

create table pixkit_private.forum_categories (
  slug text primary key check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null,
  description text not null default '',
  position integer not null,
  active boolean not null default true
);
insert into pixkit_private.forum_categories (slug, title, position) values
  ('general-programming', 'General Programming', 10),
  ('python', 'Python', 20),
  ('javascript', 'JavaScript', 30),
  ('android', 'Android Development', 40),
  ('artificial-intelligence', 'Artificial Intelligence', 50),
  ('beginner-questions', 'Beginner Questions', 60),
  ('projects', 'Projects and Showcase', 70),
  ('pixkit-tutorials', 'PixKit Tutorials', 80),
  ('feedback', 'Feedback and Suggestions', 90);

create table pixkit_private.forum_posts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  author_id uuid references auth.users on delete set null,
  category text not null references pixkit_private.forum_categories,
  topic_id uuid references pixkit_private.forum_posts,
  parent_id uuid references pixkit_private.forum_posts,
  depth smallint not null default 0 check (depth between 0 and 4),
  title text,
  body text,
  version integer not null default 1 check (version > 0),
  status text not null default 'pending' check (
    status in ('pending', 'published', 'held', 'blocked', 'flagged', 'hidden', 'deleted')
  ),
  reason text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (author_id, request_id),
  check (
    (depth = 0 and topic_id is null and parent_id is null and title is not null)
    or (depth > 0 and topic_id is not null and parent_id is not null and title is null)
  ),
  check ((status = 'deleted') = (body is null))
);

create index forum_public_topics_idx on pixkit_private.forum_posts (created_at desc, id)
  where status = 'published' and depth = 0;
create index forum_topic_replies_idx on pixkit_private.forum_posts (topic_id, created_at, id)
  where status in ('published', 'deleted');
create index forum_post_time_idx on pixkit_private.forum_posts (created_at desc);
create index forum_parent_idx on pixkit_private.forum_posts (parent_id);
create index forum_author_idx on pixkit_private.forum_posts (author_id, updated_at desc);
create index forum_review_idx on pixkit_private.forum_posts (created_at, id)
  where status in ('pending', 'held', 'flagged');

create table pixkit_private.forum_votes (
  post_id uuid not null references pixkit_private.forum_posts on delete cascade,
  voter_id uuid not null references auth.users on delete cascade,
  value smallint not null check (value in (-1, 1)),
  primary key (post_id, voter_id)
);

create table pixkit_private.forum_reports (
  post_id uuid not null references pixkit_private.forum_posts on delete cascade,
  version integer not null,
  reporter_id uuid not null references auth.users on delete cascade,
  reason text not null,
  created_at timestamptz not null default statement_timestamp(),
  resolved_at timestamptz,
  primary key (post_id, version, reporter_id)
);
create index forum_open_reports_idx on pixkit_private.forum_reports (post_id)
  where resolved_at is null;

create table pixkit_private.forum_appeals (
  post_id uuid not null references pixkit_private.forum_posts on delete cascade,
  version integer not null,
  author_id uuid not null references auth.users on delete cascade,
  reason text not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'denied', 'superseded')),
  response text,
  created_at timestamptz not null default statement_timestamp(),
  resolved_at timestamptz,
  primary key (post_id, version)
);
create index forum_open_appeals_idx on pixkit_private.forum_appeals (post_id)
  where status = 'pending';

create table pixkit_private.forum_sanctions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  actor_id uuid references auth.users on delete set null,
  action text not null check (action in ('warn', 'suspend', 'ban', 'restore')),
  reason text not null,
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz,
  check ((action = 'suspend') = (expires_at is not null))
);
create index forum_sanctions_user_idx on pixkit_private.forum_sanctions (user_id, id desc);

create table pixkit_private.forum_jobs (
  post_id uuid not null references pixkit_private.forum_posts on delete cascade,
  version integer not null,
  available_at timestamptz not null default statement_timestamp(),
  lease uuid,
  lease_until timestamptz,
  attempts integer not null default 0,
  completed_at timestamptz,
  signals jsonb not null default '{}'::jsonb,
  primary key (post_id, version),
  check ((lease is null) = (lease_until is null))
);
create index forum_jobs_ready_idx on pixkit_private.forum_jobs (available_at, post_id)
  where completed_at is null;

create table pixkit_private.forum_history (
  id bigint generated always as identity primary key,
  post_id uuid references pixkit_private.forum_posts on delete set null,
  user_id uuid references auth.users on delete set null,
  actor_id uuid references auth.users on delete set null,
  action text not null,
  reason text,
  created_at timestamptz not null default statement_timestamp()
);
create index forum_history_author_idx on pixkit_private.forum_history (user_id, created_at desc);
create index forum_history_time_idx on pixkit_private.forum_history (created_at desc, id desc);

create table pixkit_private.forum_limits (
  user_id uuid not null references auth.users on delete cascade,
  operation text not null,
  created_at timestamptz not null default statement_timestamp()
);
create index forum_limits_user_idx on pixkit_private.forum_limits (user_id, operation, created_at desc);
create index forum_limits_retention_idx on pixkit_private.forum_limits (created_at);

alter table pixkit_private.forum_settings enable row level security;
alter table pixkit_private.forum_categories enable row level security;
alter table pixkit_private.forum_posts enable row level security;
alter table pixkit_private.forum_votes enable row level security;
alter table pixkit_private.forum_reports enable row level security;
alter table pixkit_private.forum_appeals enable row level security;
alter table pixkit_private.forum_sanctions enable row level security;
alter table pixkit_private.forum_jobs enable row level security;
alter table pixkit_private.forum_history enable row level security;
alter table pixkit_private.forum_limits enable row level security;

revoke all on
  pixkit_private.forum_settings, pixkit_private.forum_categories,
  pixkit_private.forum_posts, pixkit_private.forum_votes, pixkit_private.forum_reports,
  pixkit_private.forum_appeals, pixkit_private.forum_sanctions, pixkit_private.forum_jobs,
  pixkit_private.forum_history, pixkit_private.forum_limits
from public, anon, authenticated, service_role;

-- Preserve the conversation tree while removing unpublished content when its
-- author deletes their account. The foreign key already anonymizes published posts.
create function pixkit_private.forum_forget_unpublished_post()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.body := null;
  new.title := case when new.depth = 0 then '' end;
  new.version := new.version + 1;
  new.status := 'deleted';
  new.reason := null;
  new.updated_at := statement_timestamp();
  return new;
end
$$;

create trigger forum_forget_unpublished_post
before update of author_id on pixkit_private.forum_posts
for each row when (
  old.author_id is not null and new.author_id is null and old.status not in ('published', 'deleted')
) execute function pixkit_private.forum_forget_unpublished_post();

create function pixkit_private.forum_current_sanction(p_user uuid)
returns text language sql stable set search_path = '' as $$
  select case when s.expires_at <= statement_timestamp() then null else s.action end
  from pixkit_private.forum_sanctions s
  where s.user_id = p_user and s.action in ('suspend', 'ban', 'restore')
  order by s.id desc limit 1
$$;

create function pixkit_private.forum_member(p_writing boolean default false)
returns uuid language plpgsql set search_path = '' as $$
declare
  member uuid := auth.uid();
begin
  if member is null or not pixkit_private.is_active_user() then
    raise insufficient_privilege using message = 'An active account is required.';
  end if;
  if p_writing then
    member := pixkit_private.lock_active_user();
    if not exists (select from pixkit_private.forum_settings where singleton and writing_open) then
      raise insufficient_privilege using message = 'Forum posting is closed.';
    end if;
    -- The same member lock protects against a concurrent moderation sanction.
    perform pg_advisory_xact_lock(hashtextextended(member::text, 827510));
    if pixkit_private.forum_current_sanction(member) in ('suspend', 'ban') then
      raise insufficient_privilege using message = 'Forum posting is restricted.';
    end if;
  end if;
  return member;
end
$$;

create function pixkit_private.forum_staff()
returns uuid language plpgsql set search_path = '' as $$
declare
  staff uuid := pixkit_private.forum_member();
begin
  if not (pixkit_private.has_role('moderator') or pixkit_private.has_role('admin')) then
    raise insufficient_privilege using message = 'A moderation role is required.';
  end if;
  return staff;
end
$$;

create function pixkit_private.forum_rate(p_user uuid, p_operation text, p_max integer,
  p_window interval, p_daily integer default null)
returns void language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 827510));
  if (select count(*) from pixkit_private.forum_limits
      where user_id = p_user and operation = p_operation
        and created_at > statement_timestamp() - p_window) >= p_max
    or (p_daily is not null and (select count(*) from pixkit_private.forum_limits
      where user_id = p_user and operation = p_operation
        and created_at > statement_timestamp() - interval '1 day') >= p_daily) then
    raise sqlstate 'PT429' using message = 'Forum rate limit reached.';
  end if;
  insert into pixkit_private.forum_limits (user_id, operation) values (p_user, p_operation);
end
$$;

create function pixkit_private.forum_text(p_value text, p_max integer, p_required boolean default true)
returns text language plpgsql immutable set search_path = '' as $$
begin
  p_value := nullif(btrim(replace(p_value, E'\r\n', E'\n'), E' \n\r\t'), '');
  if (p_required and p_value is null) or char_length(p_value) > p_max
     or translate(p_value, E'\n\t', '') ~ '[[:cntrl:]]' then
    raise invalid_parameter_value using message = 'Invalid forum text.';
  end if;
  return p_value;
end
$$;

create function pixkit_private.forum_can_view(p_post uuid)
returns boolean language sql stable set search_path = '' as $$
  with recursive chain as (
    select id, parent_id, depth, status from pixkit_private.forum_posts where id = p_post
    union all
    select ancestor.id, ancestor.parent_id, ancestor.depth, ancestor.status
    from pixkit_private.forum_posts ancestor join chain child on ancestor.id = child.parent_id
    where ancestor.depth = child.depth - 1
  )
  select coalesce(bool_and(case when id = p_post or depth = 0 then status = 'published'
      else status in ('published', 'deleted') end), false)
    and coalesce(bool_or(depth = 0), false)
  from chain
$$;

create function pixkit_private.forum_card(p_post pixkit_private.forum_posts)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_post.id, 'category', p_post.category, 'parent', p_post.parent_id,
    'title', p_post.title, 'body', p_post.body,
    'author', case when p_post.status <> 'deleted' then author.display_name end,
    'created_at', p_post.created_at, 'version', p_post.version,
    'own', p_post.status <> 'deleted' and coalesce(p_post.author_id = auth.uid(), false),
    'depth', p_post.depth, 'deleted', p_post.status = 'deleted',
    'score', coalesce((select sum(v.value) from pixkit_private.forum_votes v
      where v.post_id = p_post.id), 0),
    'vote', coalesce((select v.value from pixkit_private.forum_votes v
      where v.post_id = p_post.id and v.voter_id = auth.uid()), 0)
  )
  from (values (1)) dummy
  left join pixkit_private.profiles author on author.user_id = p_post.author_id
$$;

create function pixkit_private.forum_audit(p_post uuid, p_user uuid, p_actor uuid,
  p_action text, p_reason text default null)
returns void language sql set search_path = '' as $$
  insert into pixkit_private.forum_history (post_id, user_id, actor_id, action, reason)
  values (p_post, p_user, p_actor, p_action, p_reason)
$$;

create function public.pixkit_forum_settings()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('writing_open', coalesce(
    (select writing_open from pixkit_private.forum_settings where singleton), false))
$$;

create function public.pixkit_forum_categories()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', slug, 'title', title, 'description', description
  ) order by position, slug), '[]'::jsonb)
  from pixkit_private.forum_categories where active
$$;

create function public.pixkit_forum_topics(p_category text default null, p_sort text default 'recent',
  p_search text default null, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if p_sort is null or p_sort not in ('recent', 'top', 'discussed')
    or coalesce(p_offset, -1) not between 0 and 10000 or char_length(p_search) > 120 then
    raise invalid_parameter_value using message = 'Invalid forum search or sort.';
  end if;
  p_search := nullif(btrim(p_search), '');
  return (
    select coalesce(jsonb_agg(items.card order by items.rank desc, items.created_at desc, items.id), '[]'::jsonb)
    from (
      select p.id, p.created_at, case p_sort
        when 'top' then stats.score when 'discussed' then stats.comment_count else 0 end as rank,
        jsonb_build_object('id', p.id, 'category', p.category, 'title', p.title, 'author', a.display_name,
          'created_at', p.created_at, 'score', stats.score, 'comment_count', stats.comment_count) as card
      from pixkit_private.forum_posts p
      left join pixkit_private.profiles a on a.user_id = p.author_id
      cross join lateral (
        select coalesce((select sum(v.value) from pixkit_private.forum_votes v where v.post_id = p.id), 0) as score,
          (select count(*) from pixkit_private.forum_posts r
            where r.topic_id = p.id and r.status = 'published' and pixkit_private.forum_can_view(r.id)) as comment_count
      ) stats
      where p.depth = 0 and p.status = 'published'
        and (p_category is null or p.category = p_category)
        and (p_search is null or position(lower(p_search) in lower(p.title || ' ' || p.body)) > 0)
      order by rank desc, p.created_at desc, p.id
      limit 50 offset p_offset
    ) items
  );
end
$$;

create function public.pixkit_forum_thread(p_topic uuid, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  topic pixkit_private.forum_posts;
begin
  if coalesce(p_offset, -1) not between 0 and 10000 then
    raise invalid_parameter_value using message = 'Invalid forum page.';
  end if;
  select * into topic from pixkit_private.forum_posts
    where id = p_topic and depth = 0 and status = 'published';
  if not found then return null; end if;
  return (
    with recursive visible as (
      select r.* from pixkit_private.forum_posts r
      where r.parent_id = p_topic and r.status in ('published', 'deleted')
      union all
      select r.* from pixkit_private.forum_posts r join visible parent on r.parent_id = parent.id
      where r.topic_id = p_topic and r.status in ('published', 'deleted') and r.depth = parent.depth + 1
    ),
    total as (select count(*) as replies, count(*) filter (where status = 'published') as comments from visible),
    page as (select * from visible order by created_at, id limit 200 offset p_offset)
    select jsonb_build_object(
      'topic', pixkit_private.forum_card(topic) || jsonb_build_object('comment_count', total.comments),
      'replies', coalesce((
        select jsonb_agg(pixkit_private.forum_card(p) order by p.created_at, p.id) from page p
      ), '[]'::jsonb),
      'reply_count', total.replies,
      'writing_open', public.pixkit_forum_settings()->'writing_open'
    ) from total
  );
end
$$;

create function public.pixkit_forum_submit(p_request uuid, p_category text, p_parent uuid,
  p_title text, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  member uuid := pixkit_private.forum_member(true);
  parent pixkit_private.forum_posts;
  post pixkit_private.forum_posts;
begin
  if p_request is null then
    raise invalid_parameter_value using message = 'A request ID is required.';
  end if;
  select * into post from pixkit_private.forum_posts where author_id = member and request_id = p_request;
  if not found then
    perform pixkit_private.forum_rate(member, 'write', 6, interval '1 minute', 60);
    p_body := pixkit_private.forum_text(p_body, 10000);
    if p_parent is null then
      p_title := pixkit_private.forum_text(p_title, 180);
      if not exists (select from pixkit_private.forum_categories where slug = p_category and active) then
        raise invalid_parameter_value using message = 'Unknown forum category.';
      end if;
      insert into pixkit_private.forum_posts (request_id, author_id, category, title, body)
        values (p_request, member, p_category, p_title, p_body) returning * into post;
    else
      select * into parent from pixkit_private.forum_posts where id = p_parent for share;
      if not found or not pixkit_private.forum_can_view(p_parent) or parent.depth >= 4 then
        raise invalid_parameter_value using message = 'The reply parent is unavailable.';
      end if;
      insert into pixkit_private.forum_posts (request_id, author_id, category, topic_id, parent_id, depth, body)
        values (p_request, member, parent.category, coalesce(parent.topic_id, parent.id),
          parent.id, parent.depth + 1, p_body) returning * into post;
    end if;
    insert into pixkit_private.forum_jobs (post_id, version) values (post.id, post.version);
    perform pixkit_private.forum_audit(post.id, member, member, 'submitted');
  end if;
  return jsonb_build_object('id', post.id, 'version', post.version, 'status', post.status);
end
$$;

create function public.pixkit_forum_edit(p_post uuid, p_version integer, p_title text, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  member uuid := pixkit_private.forum_member(true);
  post pixkit_private.forum_posts;
begin
  select * into post from pixkit_private.forum_posts where id = p_post and author_id = member for update;
  if not found or post.status in ('deleted', 'hidden') then
    raise insufficient_privilege using message = 'The post cannot be edited.';
  end if;
  p_body := pixkit_private.forum_text(p_body, 10000);
  p_title := case when post.depth = 0 then pixkit_private.forum_text(p_title, 180) end;
  if post.version = p_version + 1 and post.body = p_body and post.title is not distinct from p_title then
    return jsonb_build_object('id', post.id, 'version', post.version, 'status', post.status);
  end if;
  if p_version is distinct from post.version then
    raise sqlstate 'PT409' using message = 'The post has changed.';
  end if;
  perform pixkit_private.forum_rate(member, 'write', 6, interval '1 minute', 60);
  update pixkit_private.forum_appeals
    set status = 'superseded', resolved_at = statement_timestamp()
    where post_id = p_post and version = post.version and status = 'pending';
  update pixkit_private.forum_reports set resolved_at = statement_timestamp()
    where post_id = p_post and version = post.version and resolved_at is null;
  update pixkit_private.forum_posts set title = p_title, body = p_body, version = version + 1,
    status = 'pending', reason = null, updated_at = statement_timestamp()
    where id = p_post returning * into post;
  insert into pixkit_private.forum_jobs (post_id, version) values (post.id, post.version);
  perform pixkit_private.forum_audit(post.id, member, member, 'edited');
  return jsonb_build_object('id', post.id, 'version', post.version, 'status', post.status);
end
$$;

create function public.pixkit_forum_delete(p_post uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  member uuid := pixkit_private.forum_member();
  post pixkit_private.forum_posts;
begin
  select * into post from pixkit_private.forum_posts where id = p_post and author_id = member for update;
  if not found then
    raise insufficient_privilege using message = 'The post cannot be deleted.';
  end if;
  if post.status <> 'deleted' then
    update pixkit_private.forum_appeals set status = 'superseded', resolved_at = statement_timestamp()
      where post_id = p_post and status = 'pending';
    update pixkit_private.forum_reports set resolved_at = statement_timestamp()
      where post_id = p_post and resolved_at is null;
    update pixkit_private.forum_posts set body = null, title = case when depth = 0 then '' end,
      version = version + 1, status = 'deleted', reason = null, updated_at = statement_timestamp()
      where id = p_post returning * into post;
    perform pixkit_private.forum_audit(post.id, member, member, 'deleted');
  end if;
  return jsonb_build_object('id', post.id, 'version', post.version, 'status', post.status);
end
$$;

create function public.pixkit_forum_vote(p_post uuid, p_value integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  member uuid := pixkit_private.forum_member(true);
begin
  if p_value is null or p_value not in (-1, 0, 1) or not pixkit_private.forum_can_view(p_post) then
    raise invalid_parameter_value using message = 'Invalid forum vote.';
  end if;
  if p_value is distinct from coalesce((
    select v.value from pixkit_private.forum_votes v where v.post_id = p_post and v.voter_id = member
  ), 0) then
    perform pixkit_private.forum_rate(member, 'vote', 120, interval '1 hour');
    if p_value = 0 then
      delete from pixkit_private.forum_votes where post_id = p_post and voter_id = member;
    else
      insert into pixkit_private.forum_votes (post_id, voter_id, value)
        values (p_post, member, p_value)
        on conflict (post_id, voter_id) do update set value = excluded.value;
    end if;
  end if;
  return jsonb_build_object('ok', true);
end
$$;

create function public.pixkit_forum_report(p_post uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  member uuid := pixkit_private.forum_member();
  post pixkit_private.forum_posts;
begin
  perform pg_advisory_xact_lock(hashtextextended(member::text, 827510));
  select * into post from pixkit_private.forum_posts where id = p_post for share;
  if not found or not pixkit_private.forum_can_view(p_post) then
    raise invalid_parameter_value using message = 'The reported post is unavailable.';
  end if;
  if not exists (select from pixkit_private.forum_reports
    where post_id = p_post and version = post.version and reporter_id = member) then
    perform pixkit_private.forum_rate(member, 'report', 10, interval '1 hour');
    p_reason := pixkit_private.forum_text(p_reason, 300);
    insert into pixkit_private.forum_reports (post_id, version, reporter_id, reason)
      values (p_post, post.version, member, p_reason);
    perform pixkit_private.forum_audit(p_post, post.author_id, member, 'reported');
  end if;
  return jsonb_build_object('ok', true);
end
$$;

create function public.pixkit_forum_appeal(p_post uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  member uuid := pixkit_private.forum_member();
  post pixkit_private.forum_posts;
begin
  perform pg_advisory_xact_lock(hashtextextended(member::text, 827510));
  select * into post from pixkit_private.forum_posts where id = p_post and author_id = member for share;
  if not found or post.status not in ('held', 'blocked', 'flagged', 'hidden') then
    raise insufficient_privilege using message = 'The decision cannot be appealed.';
  end if;
  if not exists (select from pixkit_private.forum_appeals where post_id = p_post and version = post.version) then
    perform pixkit_private.forum_rate(member, 'appeal', 5, interval '1 day');
    p_reason := pixkit_private.forum_text(p_reason, 300);
    insert into pixkit_private.forum_appeals (post_id, version, author_id, reason)
      values (p_post, post.version, member, p_reason);
    perform pixkit_private.forum_audit(p_post, member, member, 'appealed');
  end if;
  return jsonb_build_object('ok', true);
end
$$;

create function public.pixkit_forum_activity()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  member uuid := pixkit_private.forum_member();
begin
  return jsonb_build_object(
    'posts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'topic', coalesce(p.topic_id, p.id), 'parent', p.parent_id, 'title', p.title,
        'body', p.body, 'version', p.version, 'status', p.status, 'reason', p.reason, 'created_at', p.created_at,
        'appeal', (select jsonb_build_object('reason', a.reason, 'status', a.status, 'response', a.response)
          from pixkit_private.forum_appeals a where a.post_id = p.id and a.version = p.version)
      ) order by p.updated_at desc, p.id)
      from (select * from pixkit_private.forum_posts
        where author_id = member and status <> 'deleted' order by updated_at desc, id limit 100) p
    ), '[]'::jsonb),
    'sanctions', coalesce((
      select jsonb_agg(jsonb_build_object('action', s.action, 'reason', s.reason,
        'created_at', s.created_at, 'expires_at', s.expires_at) order by s.id desc)
      from (select * from pixkit_private.forum_sanctions where user_id = member order by id desc limit 100) s
    ), '[]'::jsonb)
  );
end
$$;

create function public.pixkit_forum_queue(p_status text default null, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform pixkit_private.forum_staff();
  if coalesce(p_offset, -1) not between 0 and 10000 or (p_status is not null and p_status not in (
    'all', 'pending', 'held', 'blocked', 'flagged', 'hidden', 'published'
  )) then
    raise invalid_parameter_value using message = 'Invalid moderation queue filter.';
  end if;
  return (
    with matching as materialized (
      select q.id, q.created_at, case q.status when 'flagged' then 0 when 'pending' then 2 else 1 end as priority
      from pixkit_private.forum_posts q
      where q.status <> 'deleted' and (p_status in ('all', q.status) or (p_status is null and (
        q.status in ('pending', 'held', 'flagged')
        or exists (select from pixkit_private.forum_reports r where r.post_id = q.id and r.resolved_at is null)
        or exists (select from pixkit_private.forum_appeals a where a.post_id = q.id and a.status = 'pending')
      )))
    ),
    page as (select * from matching order by priority, created_at, id limit 50 offset p_offset)
    select jsonb_build_object(
      'posts', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', p.id, 'topic', coalesce(p.topic_id, p.id), 'parent', p.parent_id, 'title', p.title, 'body', p.body,
          'version', p.version, 'status', p.status, 'author', u.display_name, 'user', p.author_id,
          'reason', p.reason, 'signals', j.signals, 'created_at', p.created_at,
          'reports', coalesce((select jsonb_agg(jsonb_build_object(
            'reason', r.reason, 'created_at', r.created_at, 'version', r.version
          ) order by r.created_at) from (select * from pixkit_private.forum_reports
            where post_id = p.id and resolved_at is null order by created_at limit 20) r), '[]'::jsonb),
          'appeal', (select jsonb_build_object('reason', a.reason, 'status', a.status, 'response', a.response)
            from pixkit_private.forum_appeals a where a.post_id = p.id and a.version = p.version)
        ) order by page.priority, page.created_at, page.id)
        from page join pixkit_private.forum_posts p on p.id = page.id
        left join pixkit_private.profiles u on u.user_id = p.author_id
        left join pixkit_private.forum_jobs j on j.post_id = p.id and j.version = p.version
      ), '[]'::jsonb),
      'history', coalesce((
        select jsonb_agg(jsonb_build_object('post', h.post_id, 'user', h.user_id, 'actor', h.actor_id,
          'action', h.action, 'reason', h.reason, 'created_at', h.created_at) order by h.id desc)
        from (select * from pixkit_private.forum_history order by id desc limit 100) h
      ), '[]'::jsonb),
      'total', (select count(*) from matching)
    )
  );
end
$$;

create function public.pixkit_forum_review(p_post uuid, p_version integer, p_action text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  staff uuid := pixkit_private.forum_staff();
  post pixkit_private.forum_posts;
  next_status text;
begin
  p_reason := pixkit_private.forum_text(p_reason, 300);
  next_status := case p_action
    when 'publish' then 'published' when 'hold' then 'held' when 'block' then 'blocked'
    when 'flag' then 'flagged' when 'hide' then 'hidden' when 'appeal_accept' then 'published'
  end;
  if next_status is null and p_action is distinct from 'appeal_deny' then
    raise invalid_parameter_value using message = 'Invalid review action.';
  end if;
  select * into post from pixkit_private.forum_posts where id = p_post for update;
  if not found or post.status = 'deleted' or p_version is distinct from post.version then
    raise sqlstate 'PT409' using message = 'The post has changed.';
  end if;
  if staff = post.author_id and not pixkit_private.has_role('admin') then
    raise insufficient_privilege using message = 'Staff cannot moderate their own posts.';
  end if;
  if next_status = 'published' and post.author_id is null and post.status <> 'published' then
    raise invalid_parameter_value using message = 'The account for this unpublished post was deleted.';
  end if;
  if p_action in ('appeal_accept', 'appeal_deny') then
    update pixkit_private.forum_appeals
      set status = case p_action when 'appeal_accept' then 'accepted' else 'denied' end,
        response = p_reason, resolved_at = statement_timestamp()
      where post_id = p_post and version = p_version and status = 'pending';
    if not found then
      raise sqlstate 'PT409' using message = 'The appeal is no longer pending.';
    end if;
  elsif next_status = 'published' then
    update pixkit_private.forum_appeals set status = 'accepted', response = p_reason,
      resolved_at = statement_timestamp()
      where post_id = p_post and version = p_version and status = 'pending';
  end if;
  if next_status is not null then
    update pixkit_private.forum_posts set status = next_status, reason = p_reason,
      updated_at = statement_timestamp() where id = p_post;
    update pixkit_private.forum_jobs set completed_at = statement_timestamp(), lease = null, lease_until = null
      where post_id = p_post and version = p_version and completed_at is null;
    update pixkit_private.forum_reports set resolved_at = statement_timestamp()
      where post_id = p_post and resolved_at is null;
  end if;
  perform pixkit_private.forum_audit(p_post, post.author_id, staff, p_action, p_reason);
  return jsonb_build_object('ok', true);
end
$$;

create function public.pixkit_forum_sanction(p_user uuid, p_action text, p_reason text, p_days integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  staff uuid := pixkit_private.forum_staff();
  administrator boolean := pixkit_private.has_role('admin');
  current_action text;
  expiration timestamptz;
begin
  p_reason := pixkit_private.forum_text(p_reason, 300);
  if p_action is null or p_action not in ('warn', 'suspend', 'ban', 'restore')
    or (p_action = 'suspend' and coalesce(p_days, 0) not between 1 and 365) then
    raise invalid_parameter_value using message = 'Invalid forum sanction.';
  end if;
  if p_user is null or p_user = staff
    or (not administrator and (p_action in ('ban', 'restore') or exists (
      select from pixkit_private.account_roles
      where user_id = p_user and role_id in ('moderator', 'admin')
    ))) then
    raise insufficient_privilege using message = 'The account cannot be sanctioned by this moderator.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 827510));
  current_action := pixkit_private.forum_current_sanction(p_user);
  if current_action = 'ban' and p_action = 'suspend' then
    raise invalid_parameter_value using message = 'Restore the banned account before applying a suspension.';
  end if;
  if p_action = 'suspend' then
    expiration := statement_timestamp() + make_interval(days => p_days);
  end if;
  insert into pixkit_private.forum_sanctions (user_id, actor_id, action, reason, expires_at)
    values (p_user, staff, p_action, p_reason, expiration);
  perform pixkit_private.forum_audit(null, p_user, staff, p_action, p_reason);
  return jsonb_build_object('ok', true);
end
$$;

create function public.pixkit_forum_claim(p_limit integer default 10, p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  claims jsonb;
begin
  if coalesce(p_limit, 0) not between 1 and 50 or coalesce(p_lease_seconds, 0) not between 5 and 900 then
    raise invalid_parameter_value using message = 'Invalid moderation job claim.';
  end if;
  with ready as (
      select j.post_id, j.version from pixkit_private.forum_jobs j
      join pixkit_private.forum_posts p on p.id = j.post_id and p.version = j.version
      where p.status = 'pending' and p.author_id is not null and j.completed_at is null
        and j.available_at <= statement_timestamp()
        and (j.lease_until is null or j.lease_until <= statement_timestamp())
      order by j.available_at, j.post_id limit p_limit for update of j skip locked
    ),
    claimed as (
      update pixkit_private.forum_jobs j set lease = gen_random_uuid(),
        lease_until = statement_timestamp() + make_interval(secs => p_lease_seconds), attempts = j.attempts + 1
      from ready where j.post_id = ready.post_id and j.version = ready.version
      returning j.post_id, j.version, j.lease, j.attempts
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'version', c.version, 'lease', c.lease, 'title', p.title, 'body', p.body, 'attempts', c.attempts,
      'signals', jsonb_build_object(
        'recentBlocked', (select count(*) from pixkit_private.forum_history h
          where h.user_id = p.author_id and h.action in ('auto_block', 'auto_flag', 'block', 'flag')
            and h.created_at > statement_timestamp() - interval '7 days'),
        'recentReports', (select count(distinct h.actor_id) from pixkit_private.forum_history h
          where h.user_id = p.author_id and h.action = 'reported' and h.actor_id is not null
            and h.created_at > statement_timestamp() - interval '7 days'),
        'repeatedSpam', (select count(distinct prior.id) from pixkit_private.forum_posts prior
          join pixkit_private.forum_jobs previous on previous.post_id = prior.id
          where prior.author_id = p.author_id and previous.signals->'reasons' ? 'spam'
            and previous.completed_at > statement_timestamp() - interval '1 day'),
        'coordinatedSpam', (select count(distinct other.author_id) from pixkit_private.forum_posts other
          where other.author_id <> p.author_id and other.status <> 'deleted'
            and other.created_at > statement_timestamp() - interval '10 minutes'
            and char_length(p.body) >= 25 and lower(other.body) = lower(p.body)
            and lower(coalesce(other.title, '')) = lower(coalesce(p.title, '')))
      )
    ) order by p.id), '[]'::jsonb)
    into claims
    from claimed c join pixkit_private.forum_posts p on p.id = c.post_id;
  return claims;
end
$$;

create function public.pixkit_forum_resolve(p_post uuid, p_version integer, p_lease uuid,
  p_action text, p_reason text, p_signals jsonb default '{}'::jsonb, p_delay_seconds integer default 60)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  post pixkit_private.forum_posts;
  job pixkit_private.forum_jobs;
  next_status text;
begin
  if p_action is null or p_action not in ('publish', 'hold', 'block', 'flag', 'retry')
    or p_lease is null or p_signals is null or jsonb_typeof(p_signals) <> 'object'
    or octet_length(p_signals::text) > 8192
    or (p_action = 'retry' and coalesce(p_delay_seconds, 0) not between 1 and 3600) then
    raise invalid_parameter_value using message = 'Invalid moderation job result.';
  end if;
  p_reason := pixkit_private.forum_text(p_reason, 300);
  select * into post from pixkit_private.forum_posts where id = p_post for update;
  if not found or post.status <> 'pending' or post.version is distinct from p_version or post.author_id is null then
    return false;
  end if;
  select * into job from pixkit_private.forum_jobs where post_id = p_post and version = p_version
    and lease = p_lease and lease_until > statement_timestamp() and completed_at is null for update;
  if not found then return false; end if;
  if p_action = 'retry' and job.attempts < 20 then
    update pixkit_private.forum_jobs set lease = null, lease_until = null,
      available_at = statement_timestamp() + make_interval(secs => p_delay_seconds)
      where post_id = p_post and version = p_version;
    return true;
  end if;
  if p_action = 'retry' then
    p_action := 'hold';
    p_reason := 'moderation_review';
    p_signals := jsonb_build_object('risk', 'elevated', 'reasons', jsonb_build_array('provider_unavailable'),
      'provider', null, 'scores', '{}'::jsonb);
  end if;
  next_status := case p_action
    when 'publish' then 'published' when 'hold' then 'held' when 'block' then 'blocked' when 'flag' then 'flagged' end;
  update pixkit_private.forum_posts set status = next_status, reason = p_reason,
    updated_at = statement_timestamp() where id = p_post;
  update pixkit_private.forum_jobs set completed_at = statement_timestamp(), signals = p_signals,
    lease = null, lease_until = null where post_id = p_post and version = p_version;
  perform pixkit_private.forum_audit(p_post, post.author_id, null, 'auto_' || p_action, p_reason);
  return true;
end
$$;

-- Schedule this server-only function daily. Pending reviews and open appeals are kept for resolution.
create function public.pixkit_forum_prune()
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from pixkit_private.forum_limits where created_at < statement_timestamp() - interval '2 days';
  delete from pixkit_private.forum_jobs j using pixkit_private.forum_posts p where j.post_id = p.id
    and ((p.version <> j.version or p.author_id is null) and j.available_at < statement_timestamp() - interval '30 days'
      or (p.status = 'published' and j.completed_at < statement_timestamp() - interval '90 days'));
  delete from pixkit_private.forum_reports where resolved_at < statement_timestamp() - interval '180 days';
  delete from pixkit_private.forum_appeals where resolved_at < statement_timestamp() - interval '180 days';
  delete from pixkit_private.forum_history where created_at < statement_timestamp() - interval '180 days';
  delete from pixkit_private.forum_sanctions s where created_at < statement_timestamp() - interval '180 days'
    and (s.action = 'warn' or exists (select from pixkit_private.forum_sanctions newer
      where newer.user_id = s.user_id and newer.id > s.id and newer.action in ('suspend', 'ban', 'restore')));
end
$$;

revoke all on function public.pixkit_forum_settings(), public.pixkit_forum_categories(),
  public.pixkit_forum_topics(text, text, text, integer), public.pixkit_forum_thread(uuid, integer),
  public.pixkit_forum_submit(uuid, text, uuid, text, text), public.pixkit_forum_edit(uuid, integer, text, text),
  public.pixkit_forum_delete(uuid), public.pixkit_forum_vote(uuid, integer), public.pixkit_forum_report(uuid, text),
  public.pixkit_forum_appeal(uuid, text), public.pixkit_forum_activity(), public.pixkit_forum_queue(text, integer),
  public.pixkit_forum_review(uuid, integer, text, text), public.pixkit_forum_sanction(uuid, text, text, integer),
  public.pixkit_forum_claim(integer, integer),
  public.pixkit_forum_resolve(uuid, integer, uuid, text, text, jsonb, integer), public.pixkit_forum_prune()
from public, anon, authenticated, service_role;

grant execute on function public.pixkit_forum_settings(), public.pixkit_forum_categories(),
  public.pixkit_forum_topics(text, text, text, integer), public.pixkit_forum_thread(uuid, integer)
to anon, authenticated;
grant execute on function public.pixkit_forum_submit(uuid, text, uuid, text, text),
  public.pixkit_forum_edit(uuid, integer, text, text), public.pixkit_forum_delete(uuid),
  public.pixkit_forum_vote(uuid, integer), public.pixkit_forum_report(uuid, text), public.pixkit_forum_appeal(uuid, text),
  public.pixkit_forum_activity(), public.pixkit_forum_queue(text, integer), public.pixkit_forum_review(uuid, integer, text, text),
  public.pixkit_forum_sanction(uuid, text, text, integer)
to authenticated;
grant execute on function public.pixkit_forum_claim(integer, integer),
  public.pixkit_forum_resolve(uuid, integer, uuid, text, text, jsonb, integer), public.pixkit_forum_prune()
to service_role;
