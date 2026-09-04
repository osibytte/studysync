-- ============================================================================
-- StudySync — Stage 2: Group Formation
-- Migration 0007: admin-initiated batch (system) matching
-- ----------------------------------------------------------------------------
-- Run AFTER 0004–0006. Additive and idempotent (add column if not exists,
-- create or replace), so it applies cleanly whether or not the earlier Stage 2
-- migrations have already been pushed.
--
-- WHAT THIS ADDS, and why:
--   Pathway One's find-group Edge Function is pull-based and read-only — one
--   student asks, and it *suggests*. This migration supports the opposite pole:
--   an operator triggers group *formation* over a whole course's pool of
--   students waiting to be system-matched, once enough have enrolled.
--
--   1. user_courses.matching_pref — a per-course signal of how a student wants
--      to be grouped. Defaults to 'system' (in the pool); 'self_organized'
--      removes them from batch matching. This is what "the self-matching
--      students are not among" is built on.
--   2. set_matching_pref() — the student's own control to flip that preference.
--   3. create_system_group() — the OPERATOR write path: atomically create a
--      system-formed group and its members. Unlike the Pathway Two RPCs it has
--      no auth.uid() gate and no client-action ledger, because batch runs are
--      online and service-role-triggered, not offline replays. EXECUTE is
--      revoked from anon/authenticated and granted only to service_role, so the
--      only caller is the run-batch-matching Edge Function (which holds the key).
--
-- The batcher itself (pool read, compatibility partitioning, group naming) lives
-- in the run-batch-matching Edge Function so it can reuse the mirrored TypeScript
-- scoring; this migration is only the schema and the write surface it calls.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Per-course matching preference.
--
-- Default 'system': a freshly enrolled student is in the batch-matching pool
-- with no extra step, which is what lets an operator gather "a good number" and
-- match them. A student who would rather organise their own group sets
-- 'self_organized' (via set_matching_pref) and is excluded from batch matching.
--
-- Note: a student already in a group on a course is excluded from that course's
-- pool regardless of this flag (the Edge Function filters them out by
-- membership). The flag's specific job is to exclude someone who INTENDS to
-- self-organise but has not formed a group yet.
-- ---------------------------------------------------------------------------
alter table public.user_courses
  add column if not exists matching_pref text not null default 'system'
    check (matching_pref in ('system', 'self_organized'));

comment on column public.user_courses.matching_pref is
  'How the student wants grouping for this course: system (in the batch pool, default) or self_organized (excluded).';

-- Carries the batch pool scan: "students on this course wanting system matching".
create index if not exists user_courses_pool_idx
  on public.user_courses (course_id)
  where matching_pref = 'system';

-- ---------------------------------------------------------------------------
-- set_matching_pref — the student sets their own preference for a course.
--
-- Carries a p_client_action_id (like the Pathway Two RPCs) so it can ride the
-- offline outbox later: the setting is last-write-wins and the id de-dupes a
-- replayed write. A no-op if the caller isn't enrolled in the course.
-- ---------------------------------------------------------------------------
create or replace function public.set_matching_pref(
  p_client_action_id uuid,
  p_course_id        uuid,
  p_pref             text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not public.claim_client_action(p_client_action_id, v_uid, 'matching.pref') then
    return; -- replay
  end if;
  if p_pref not in ('system', 'self_organized') then
    raise exception 'Invalid matching preference.';
  end if;

  update public.user_courses
    set matching_pref = p_pref
    where user_id = v_uid and course_id = p_course_id;
  -- Not enrolled -> zero rows updated, a harmless no-op rather than an error.
end;
$$;

-- ---------------------------------------------------------------------------
-- create_system_group — the operator write path for batch matching.
--
-- Mirrors create_group's multi-row atomic shape (group + members + topics) but
-- for a system-formed group with a caller-supplied member set. It deliberately
-- omits the auth.uid() check and the client-action ledger that the student RPCs
-- carry: this is invoked by the run-batch-matching Edge Function with the
-- service_role key, online, and re-running is naturally near-idempotent (already
-- grouped students drop out of the next pool). EXECUTE is locked to service_role
-- at the bottom of this file.
--
-- created_by / role='creator' go to p_creator_id (the group's seed). The
-- membership trigger from 0005 still governs later leave / disband / transfer.
-- ---------------------------------------------------------------------------
create or replace function public.create_system_group(
  p_group_id     uuid,
  p_group_name   text,
  p_course_id    uuid,
  p_member_ids   uuid[],
  p_creator_id   uuid,
  p_topic_ids    uuid[] default null,
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

  -- Seed the group's topics, ignoring any that don't belong to its course.
  if p_topic_ids is not null and array_length(p_topic_ids, 1) is not null then
    insert into public.group_topics (group_id, topic_id)
    select p_group_id, t.topic_id
    from public.topics t
    where t.topic_id = any(p_topic_ids) and t.course_id = p_course_id
    on conflict do nothing;
  end if;

  return p_group_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Execution grants.
--   * set_matching_pref is a normal student action -> authenticated.
--   * create_system_group is operator-only -> service_role. Revoking from
--     authenticated is the real control that stops a student minting groups they
--     aren't a member of; the function has no auth.uid() gate of its own.
-- ---------------------------------------------------------------------------
revoke all on function public.set_matching_pref(uuid, uuid, text) from public, anon;
grant execute on function public.set_matching_pref(uuid, uuid, text) to authenticated;

revoke all on function
  public.create_system_group(uuid, text, uuid, uuid[], uuid, uuid[], int)
  from public, anon, authenticated;
grant execute on function
  public.create_system_group(uuid, text, uuid, uuid[], uuid, uuid[], int)
  to service_role;
