-- ============================================================================
-- StudySync — Migration 0009: remove "topics" entirely
-- ----------------------------------------------------------------------------
-- Run AFTER 0001–0008. Forward-only: 0001–0008 are already applied to the live
-- DB and `supabase db push` applies NEW files by name — it never rewrites an
-- applied one. So topics come out here, and both a fresh clone (replays
-- 0001→0009) and the live DB (applies only 0009) converge on the same
-- topic-free schema. The old migrations are left untouched on purpose.
--
-- WHY: matching is by course + availability only. Course is the grouping key
-- (you only ever match within a course); availability is the compatibility
-- signal. "Topics" added a third axis the product no longer wants, so the
-- concept is removed everywhere: the scoring lib (mirrored TS), the wire types,
-- the UI, the seed — and here, the schema.
--
-- WHAT THIS DOES, in dependency-safe order:
--   1. Recreate the three topic-carrying RPCs without their topic parameter /
--      logic. Postgres identifies a function by name + argument types, so a
--      `create or replace` with fewer args would leave the old overload in
--      place; each must be `drop function` (exact old signature) then recreated,
--      then re-granted with the new signature.
--   2. Drop the three topic tables, children before parent (all FKs were
--      `on delete cascade`): group_topics → user_course_topics → topics.
--
-- The tables are effectively empty (the app has not been run end-to-end, so no
-- user_course_topics / group_topics rows exist; only seeded `topics` rows), so
-- the drop loses no user data. Idempotent throughout (`if exists`).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1a. create_group — drop the p_topic_ids param and the group_topics seeding.
--     Old: create_group(uuid,uuid,text,uuid,text,boolean,uuid[])
--     New: create_group(uuid,uuid,text,uuid,text,boolean)
-- ---------------------------------------------------------------------------
drop function if exists public.create_group(uuid,uuid,text,uuid,text,boolean,uuid[]);

create or replace function public.create_group(
  p_client_action_id uuid,
  p_group_id         uuid,
  p_group_name       text,
  p_course_id        uuid,
  p_formation_type   text default 'self_organized',
  p_is_discoverable  boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'You must be signed in to create a group.';
  end if;
  if not public.claim_client_action(p_client_action_id, v_uid, 'group.create') then
    return p_group_id; -- replay: the group already exists with this id
  end if;

  if coalesce(length(btrim(p_group_name)), 0) = 0 then
    raise exception 'Give the group a name.';
  end if;
  if p_formation_type not in ('system', 'self_organized') then
    raise exception 'Invalid formation type.';
  end if;

  insert into public.groups (
    group_id, group_name, course_id, formation_type, is_discoverable, created_by
  ) values (
    p_group_id, btrim(p_group_name), p_course_id, p_formation_type,
    coalesce(p_is_discoverable, true), v_uid
  );

  insert into public.group_members (group_id, user_id, role)
  values (p_group_id, v_uid, 'creator');

  return p_group_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1b. discover_groups — the discover screen's list. Drop p_topic_ids, the
--     matched_topics return column + its subquery/filter, and the topic-first
--     ordering. Runs server-side so it can expose safe aggregates (member
--     count) without exposing the member roster. Excludes groups the caller is
--     already in. p_only_open drops full groups. Ordering is now open-then-
--     fullness: joinable groups first, fuller ones ahead (a light nudge toward
--     filling a near-complete group, mirroring the fill bonus in scoring).
--     Old: discover_groups(uuid,uuid[],boolean)
--     New: discover_groups(uuid,boolean)
-- ---------------------------------------------------------------------------
drop function if exists public.discover_groups(uuid,uuid[],boolean);

create or replace function public.discover_groups(
  p_course_id uuid,
  p_only_open boolean default false
)
returns table (
  group_id       uuid,
  group_name     text,
  course_id      uuid,
  status         text,
  member_count   int,
  max_members    int,
  already_requested boolean
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;

  return query
  select
    g.group_id,
    g.group_name,
    g.course_id,
    g.status,
    public.group_member_count(g.group_id) as member_count,
    g.max_members,
    exists (
      select 1 from public.join_requests jr
      where jr.group_id = g.group_id
        and jr.requester_id = v_uid
        and jr.status = 'pending'
    ) as already_requested
  from public.groups g
  where g.course_id = p_course_id
    and g.is_discoverable
    and g.status in ('forming', 'active', 'dormant')
    and not public.is_group_member(g.group_id, v_uid)
    and (
      not p_only_open
      or public.group_member_count(g.group_id) < g.max_members
    )
  order by
    (public.group_member_count(g.group_id) < g.max_members) desc, -- open first
    public.group_member_count(g.group_id) desc                    -- then fuller
  limit 50;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1c. create_system_group — the operator write path for batch matching. Drop
--     p_topic_ids and the group_topics seeding.
--     Old: create_system_group(uuid,text,uuid,uuid[],uuid,uuid[],int)
--     New: create_system_group(uuid,text,uuid,uuid[],uuid,int)
-- ---------------------------------------------------------------------------
drop function if exists
  public.create_system_group(uuid,text,uuid,uuid[],uuid,uuid[],int);

create or replace function public.create_system_group(
  p_group_id     uuid,
  p_group_name   text,
  p_course_id    uuid,
  p_member_ids   uuid[],
  p_creator_id   uuid,
  p_max_members  int default 8
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int := coalesce(array_length(p_member_ids, 1), 0);
begin
  if v_count < 2 then
    raise exception 'A system group needs at least 2 members.';
  end if;
  if p_creator_id is null or not (p_creator_id = any(p_member_ids)) then
    raise exception 'The creator must be one of the members.';
  end if;
  if v_count > p_max_members then
    raise exception 'Member count (%) exceeds max_members (%).', v_count, p_max_members;
  end if;
  if coalesce(length(btrim(p_group_name)), 0) = 0 then
    raise exception 'Give the group a name.';
  end if;

  insert into public.groups (
    group_id, group_name, course_id, formation_type, is_discoverable,
    max_members, created_by
  ) values (
    p_group_id, btrim(p_group_name), p_course_id, 'system', true,
    p_max_members, p_creator_id
  );

  -- One row per member; the creator carries role='creator', the rest 'member'.
  -- on conflict tolerates a duplicate id in the input array.
  insert into public.group_members (group_id, user_id, role)
  select p_group_id, mem.user_id,
         case when mem.user_id = p_creator_id then 'creator' else 'member' end
  from unnest(p_member_ids) as mem(user_id)
  on conflict (group_id, user_id) do nothing;

  return p_group_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1d. Re-issue execution grants for the recreated functions (their old grants
--     referenced the old signatures, which no longer exist). Same posture as
--     0005/0007: student RPCs -> authenticated; create_system_group is
--     operator-only -> service_role.
-- ---------------------------------------------------------------------------
revoke all on function public.create_group(uuid,uuid,text,uuid,text,boolean) from public, anon;
grant execute on function public.create_group(uuid,uuid,text,uuid,text,boolean) to authenticated;

revoke all on function public.discover_groups(uuid,boolean) from public, anon;
grant execute on function public.discover_groups(uuid,boolean) to authenticated;

revoke all on function
  public.create_system_group(uuid, text, uuid, uuid[], uuid, int)
  from public, anon, authenticated;
grant execute on function
  public.create_system_group(uuid, text, uuid, uuid[], uuid, int)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. Drop the topic tables. Children (which FK to topics on delete cascade)
--    first, then the parent. Each drop takes its own RLS policies, grants and
--    indexes with it.
-- ---------------------------------------------------------------------------
drop table if exists public.group_topics;
drop table if exists public.user_course_topics;
drop table if exists public.topics;
