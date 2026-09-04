-- ============================================================================
-- StudySync — Stage 2: Group Formation
-- Migration 0005: RLS, security-definer helpers, membership trigger, and the
-- RPCs that are the only write path for group data.
-- ----------------------------------------------------------------------------
-- Run AFTER 0004.
--
-- ARCHITECTURE (DECISION 2026-09-04): all writes to group tables go through
-- the SECURITY DEFINER functions below, not through direct client INSERT/
-- UPDATE/DELETE. RLS on these tables is read-only (SELECT policies only).
--
-- Why this differs from Stage 1's direct-write-with-RLS approach:
--   * Group mutations span multiple rows atomically (create a group AND its
--     creator membership; approve a request AND insert the member). A partial
--     write here corrupts the group model. Functions are transactional.
--   * The invariants are cross-user and rule-heavy (roles, the 8-member cap,
--     creator-transfer-on-leave, disband-on-empty, no self-invite). Encoding
--     those in RLS `with check` clauses would be fragile and unreadable.
--   * The security NFR says group management must be enforced server-side, not
--     in client logic. One audited function surface is easier to trust than a
--     scatter of policies plus hopeful client code.
--
-- Each mutating function takes p_client_action_id and records it in
-- applied_client_actions inside its own transaction. A replayed offline write
-- (same id) is a no-op. This closes the gap in Stage 1's client-side ledger,
-- where the ledger insert and the write were two separate calls and a lost
-- response between them could drop or double a write.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Membership helpers.
--
-- SECURITY DEFINER + STABLE. Definer rights are the whole point: a policy on
-- group_members that itself queried group_members would recurse forever (the
-- trap flagged in Stage 1's RLS file). Because these run as the owner they
-- bypass RLS, so the policy can call them without re-entering the policy.
-- search_path is pinned to defeat search-path hijacking.
-- ---------------------------------------------------------------------------
create or replace function public.is_group_member(p_group uuid, p_user uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group and user_id = p_user
  );
$$;

create or replace function public.is_group_creator(p_group uuid, p_user uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group and user_id = p_user and role = 'creator'
  );
$$;

create or replace function public.group_member_count(p_group uuid)
returns int
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select count(*)::int from public.group_members where group_id = p_group;
$$;

-- ---------------------------------------------------------------------------
-- Idempotency claim. Returns true if this action id is newly recorded (caller
-- should proceed), false if it was already applied (caller should no-op).
--
-- The INSERT and the domain writes that follow it live in the same function
-- transaction, so they commit or roll back together. A failed action rolls
-- back its own claim and can be retried; a succeeded one is permanently
-- recorded alongside its effect.
-- ---------------------------------------------------------------------------
create or replace function public.claim_client_action(
  p_id uuid, p_user uuid, p_type text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.applied_client_actions (client_action_id, user_id, action_type)
  values (p_id, p_user, p_type)
  on conflict (client_action_id) do nothing;
  return found; -- true = inserted now; false = already existed
end;
$$;

-- ---------------------------------------------------------------------------
-- Membership integrity trigger.
--
-- Keeps two invariants true no matter how a membership row leaves — the
-- leave_group / remove_member RPCs, or an ON DELETE CASCADE from account
-- deletion:
--   1. If the group is now empty, it is disbanded (never an orphan record).
--   2. If the departed member was the creator and others remain, the
--      longest-standing remaining member is promoted, so a group is never
--      left with nobody able to manage it.
-- ---------------------------------------------------------------------------
create or replace function public.handle_group_member_removed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_remaining  int;
  v_new_creator uuid;
begin
  select count(*) into v_remaining
  from public.group_members
  where group_id = old.group_id;

  if v_remaining = 0 then
    update public.groups
      set status = 'disbanded'
      where group_id = old.group_id and status <> 'disbanded';
    return old;
  end if;

  if old.role = 'creator' then
    -- Longest-standing member wins; member_id breaks a same-timestamp tie
    -- deterministically.
    select user_id into v_new_creator
    from public.group_members
    where group_id = old.group_id
    order by joined_at asc, member_id asc
    limit 1;

    update public.group_members
      set role = 'creator'
      where group_id = old.group_id and user_id = v_new_creator;
  end if;

  return old;
end;
$$;

drop trigger if exists group_members_on_removed on public.group_members;
create trigger group_members_on_removed
  after delete on public.group_members
  for each row execute function public.handle_group_member_removed();

-- ============================================================================
-- Row Level Security — SELECT policies only. No client write policies; writes
-- go through the SECURITY DEFINER RPCs further down.
-- ============================================================================

-- Groups: visible to members, and to anyone if the group is discoverable and
-- still live. Archived/disbanded groups are only visible to their own members.
alter table public.groups enable row level security;

drop policy if exists groups_select_member_or_discoverable on public.groups;
create policy groups_select_member_or_discoverable
  on public.groups
  for select
  to authenticated
  using (
    public.is_group_member(group_id, auth.uid())
    or (is_discoverable and status in ('forming', 'active', 'dormant'))
  );

-- Group members: the roster is visible only to members of that group. A
-- non-member browsing a discoverable group sees the group card (via the policy
-- above) and an aggregate count (via discover_groups), never the member list.
alter table public.group_members enable row level security;

drop policy if exists group_members_select_member on public.group_members;
create policy group_members_select_member
  on public.group_members
  for select
  to authenticated
  using (public.is_group_member(group_id, auth.uid()));

-- Group topics: readable whenever the parent group is readable — members
-- always, and non-members when the group is discoverable (so the discover
-- screen can show what a group is about).
alter table public.group_topics enable row level security;

drop policy if exists group_topics_select on public.group_topics;
create policy group_topics_select
  on public.group_topics
  for select
  to authenticated
  using (
    exists (
      select 1 from public.groups g
      where g.group_id = group_topics.group_id
        and (
          public.is_group_member(g.group_id, auth.uid())
          or (g.is_discoverable and g.status in ('forming', 'active', 'dormant'))
        )
    )
  );

-- Invitations: the invitee sees their own; the inviter sees what they sent;
-- members of the group see its pending invites.
alter table public.invitations enable row level security;

drop policy if exists invitations_select on public.invitations;
create policy invitations_select
  on public.invitations
  for select
  to authenticated
  using (
    invitee_id = auth.uid()
    or inviter_id = auth.uid()
    or public.is_group_member(group_id, auth.uid())
  );

-- Join requests: the requester sees their own; members of the group see
-- incoming requests to approve.
alter table public.join_requests enable row level security;

drop policy if exists join_requests_select on public.join_requests;
create policy join_requests_select
  on public.join_requests
  for select
  to authenticated
  using (
    requester_id = auth.uid()
    or public.is_group_member(group_id, auth.uid())
  );

-- ============================================================================
-- RPCs — the write surface. All SECURITY DEFINER, all check auth.uid() and the
-- relevant role/capacity/lifecycle rules explicitly.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- create_group — self-organized or system-seeded. The caller becomes creator.
--
-- p_group_id is generated on the CLIENT and passed in, so an optimistic local
-- group and the server row share one id (no temp-id reconciliation), and a
-- replay is a clean no-op returning the same id.
-- ---------------------------------------------------------------------------
create or replace function public.create_group(
  p_client_action_id uuid,
  p_group_id         uuid,
  p_group_name       text,
  p_course_id        uuid,
  p_formation_type   text default 'self_organized',
  p_is_discoverable  boolean default true,
  p_topic_ids        uuid[] default null
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
-- send_invitation — direct invite (Pathway Two).
-- Creator may always invite; a plain member may invite only to a DISCOVERABLE
-- group (per the spec's member powers).
-- ---------------------------------------------------------------------------
create or replace function public.send_invitation(
  p_client_action_id uuid,
  p_group_id         uuid,
  p_invitee_id       uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_discoverable boolean;
  v_invitation_id uuid;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not public.claim_client_action(p_client_action_id, v_uid, 'invite.send') then
    return null; -- replay
  end if;

  if v_uid = p_invitee_id then
    raise exception 'You cannot invite yourself.';
  end if;

  select status, is_discoverable into v_status, v_discoverable
  from public.groups where group_id = p_group_id;
  if not found then raise exception 'That group no longer exists.'; end if;
  if v_status in ('archived', 'disbanded') then
    raise exception 'This group is no longer active.';
  end if;

  if not public.is_group_creator(p_group_id, v_uid)
     and not (public.is_group_member(p_group_id, v_uid) and v_discoverable) then
    raise exception 'You do not have permission to invite to this group.';
  end if;

  if public.is_group_member(p_group_id, p_invitee_id) then
    raise exception 'That student is already in the group.';
  end if;

  -- The partial unique index enforces one pending invite per (group, invitee);
  -- a duplicate surfaces as 23505, which the client maps to a friendly message.
  insert into public.invitations (group_id, inviter_id, invitee_id)
  values (p_group_id, v_uid, p_invitee_id)
  returning invitation_id into v_invitation_id;

  return v_invitation_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- respond_invitation — the invitee accepts or declines their own invite.
-- Accepting enforces the member cap and inserts the membership.
-- ---------------------------------------------------------------------------
create or replace function public.respond_invitation(
  p_client_action_id uuid,
  p_invitation_id    uuid,
  p_accept           boolean
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_group uuid;
  v_status text;
  v_group_status text;
  v_max int;
  v_count int;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not public.claim_client_action(p_client_action_id, v_uid, 'invite.respond') then
    return null; -- replay
  end if;

  select group_id, status into v_group, v_status
  from public.invitations
  where invitation_id = p_invitation_id and invitee_id = v_uid
  for update;
  if not found then raise exception 'That invitation no longer exists.'; end if;
  if v_status <> 'pending' then
    return v_status; -- already responded; idempotent
  end if;

  if not p_accept then
    update public.invitations
      set status = 'declined', responded_at = now()
      where invitation_id = p_invitation_id;
    return 'declined';
  end if;

  -- Accepting.
  select status, max_members into v_group_status, v_max
  from public.groups where group_id = v_group for update;
  if v_group_status in ('archived', 'disbanded') then
    raise exception 'This group is no longer active.';
  end if;

  select count(*) into v_count from public.group_members where group_id = v_group;
  if v_count >= v_max then
    raise exception 'This group is full.';
  end if;

  insert into public.group_members (group_id, user_id, role)
  values (v_group, v_uid, 'member')
  on conflict (group_id, user_id) do nothing;

  update public.invitations
    set status = 'accepted', responded_at = now()
    where invitation_id = p_invitation_id;

  -- Formation activity — keeps a filling group from being swept dormant, but
  -- does NOT flip it to 'active' (that is a real interaction, Stage 3+).
  update public.groups set last_activity_at = now() where group_id = v_group;

  return 'accepted';
end;
$$;

-- ---------------------------------------------------------------------------
-- request_to_join — a student asks to join a discoverable group.
-- ---------------------------------------------------------------------------
create or replace function public.request_to_join(
  p_client_action_id uuid,
  p_group_id         uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_discoverable boolean;
  v_max int;
  v_count int;
  v_request_id uuid;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not public.claim_client_action(p_client_action_id, v_uid, 'request.send') then
    return null; -- replay
  end if;

  select status, is_discoverable, max_members
    into v_status, v_discoverable, v_max
  from public.groups where group_id = p_group_id;
  if not found then raise exception 'That group no longer exists.'; end if;
  if not v_discoverable or v_status in ('archived', 'disbanded') then
    raise exception 'This group is not open to join requests.';
  end if;
  if public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are already in this group.';
  end if;

  select count(*) into v_count from public.group_members where group_id = p_group_id;
  if v_count >= v_max then
    raise exception 'This group is full.';
  end if;

  insert into public.join_requests (group_id, requester_id)
  values (p_group_id, v_uid)
  returning request_id into v_request_id;

  return v_request_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- respond_join_request — approve or decline an incoming request.
--
-- SPEC NOTE (flagged 2026-09-04): the spec is inconsistent about who may do
-- this. Pathway Two prose says "creator/member approves or declines"; the
-- roles table lists "approve/decline join requests" as a CREATOR power and
-- does not grant it to members. Following the roles table as the authoritative
-- one: creator only. Easy to widen to is_group_member later if the team
-- decides members should share this.
-- ---------------------------------------------------------------------------
create or replace function public.respond_join_request(
  p_client_action_id uuid,
  p_request_id       uuid,
  p_approve          boolean
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_group uuid;
  v_requester uuid;
  v_status text;
  v_group_status text;
  v_max int;
  v_count int;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not public.claim_client_action(p_client_action_id, v_uid, 'request.respond') then
    return null; -- replay
  end if;

  select group_id, requester_id, status
    into v_group, v_requester, v_status
  from public.join_requests
  where request_id = p_request_id
  for update;
  if not found then raise exception 'That request no longer exists.'; end if;

  if not public.is_group_creator(v_group, v_uid) then
    raise exception 'Only the group creator can respond to join requests.';
  end if;
  if v_status <> 'pending' then
    return v_status; -- already handled; idempotent
  end if;

  if not p_approve then
    update public.join_requests
      set status = 'declined', responded_by = v_uid, responded_at = now()
      where request_id = p_request_id;
    return 'declined';
  end if;

  select status, max_members into v_group_status, v_max
  from public.groups where group_id = v_group for update;
  if v_group_status in ('archived', 'disbanded') then
    raise exception 'This group is no longer active.';
  end if;

  select count(*) into v_count from public.group_members where group_id = v_group;
  if v_count >= v_max then
    raise exception 'This group is full.';
  end if;

  insert into public.group_members (group_id, user_id, role)
  values (v_group, v_requester, 'member')
  on conflict (group_id, user_id) do nothing;

  update public.join_requests
    set status = 'approved', responded_by = v_uid, responded_at = now()
    where request_id = p_request_id;

  update public.groups set last_activity_at = now() where group_id = v_group;

  return 'approved';
end;
$$;

-- ---------------------------------------------------------------------------
-- leave_group — the caller leaves. The membership trigger handles creator
-- transfer and disband-on-empty, so this just removes the row.
-- ---------------------------------------------------------------------------
create or replace function public.leave_group(
  p_client_action_id uuid,
  p_group_id         uuid
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
  if not public.claim_client_action(p_client_action_id, v_uid, 'group.leave') then
    return; -- replay
  end if;

  delete from public.group_members
  where group_id = p_group_id and user_id = v_uid;
  -- If the caller was not a member, the delete affects nothing; that is a fine
  -- no-op (they are already "not in the group").
end;
$$;

-- ---------------------------------------------------------------------------
-- remove_member — creator removes someone else. Creators leave via leave_group
-- (which transfers their role); they cannot remove themselves here.
-- ---------------------------------------------------------------------------
create or replace function public.remove_member(
  p_client_action_id uuid,
  p_group_id         uuid,
  p_target_user_id   uuid
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
  if not public.claim_client_action(p_client_action_id, v_uid, 'member.remove') then
    return; -- replay
  end if;

  if not public.is_group_creator(p_group_id, v_uid) then
    raise exception 'Only the group creator can remove members.';
  end if;
  if v_uid = p_target_user_id then
    raise exception 'Use Leave group to remove yourself.';
  end if;

  delete from public.group_members
  where group_id = p_group_id and user_id = p_target_user_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Creator-only group edits: rename, discoverability, archive.
-- ---------------------------------------------------------------------------
create or replace function public.rename_group(
  p_client_action_id uuid,
  p_group_id         uuid,
  p_group_name       text
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
  if not public.claim_client_action(p_client_action_id, v_uid, 'group.update') then
    return;
  end if;
  if not public.is_group_creator(p_group_id, v_uid) then
    raise exception 'Only the group creator can rename the group.';
  end if;
  if coalesce(length(btrim(p_group_name)), 0) = 0 then
    raise exception 'Give the group a name.';
  end if;
  update public.groups set group_name = btrim(p_group_name) where group_id = p_group_id;
end;
$$;

create or replace function public.set_group_discoverable(
  p_client_action_id uuid,
  p_group_id         uuid,
  p_is_discoverable  boolean
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
  if not public.claim_client_action(p_client_action_id, v_uid, 'group.update') then
    return;
  end if;
  if not public.is_group_creator(p_group_id, v_uid) then
    raise exception 'Only the group creator can change this.';
  end if;
  update public.groups set is_discoverable = p_is_discoverable where group_id = p_group_id;
end;
$$;

create or replace function public.archive_group(
  p_client_action_id uuid,
  p_group_id         uuid
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
  if not public.claim_client_action(p_client_action_id, v_uid, 'group.update') then
    return;
  end if;
  if not public.is_group_creator(p_group_id, v_uid) then
    raise exception 'Only the group creator can archive the group.';
  end if;
  update public.groups set status = 'archived'
    where group_id = p_group_id and status not in ('disbanded');
end;
$$;

-- ---------------------------------------------------------------------------
-- search_students — find a specific student to invite, without loosening the
-- own-row-only RLS on public.users.
--
-- Privacy posture: returns only name and department (never email), only for
-- students enrolled in the same course, only to a member of the target group,
-- and never anyone already in the group or the caller themselves.
-- ---------------------------------------------------------------------------
create or replace function public.search_students(
  p_query     text,
  p_course_id uuid,
  p_group_id  uuid
)
returns table (user_id uuid, full_name text, department text)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You must be a member of the group to invite people.';
  end if;

  return query
  select u.user_id, u.full_name, u.department
  from public.users u
  join public.user_courses uc
    on uc.user_id = u.user_id and uc.course_id = p_course_id
  where u.user_id <> v_uid
    and not public.is_group_member(p_group_id, u.user_id)
    and (
      coalesce(btrim(p_query), '') = ''
      or u.full_name ilike '%' || p_query || '%'
    )
  order by u.full_name
  limit 20;
end;
$$;

-- ---------------------------------------------------------------------------
-- discover_groups — the discover screen's list. Runs server-side so it can
-- expose safe aggregates (member count) and topic overlap without exposing the
-- member roster, and so capacity/topic filtering is one query.
--
-- Excludes groups the caller is already in. When p_topic_ids is non-empty,
-- returns only groups sharing at least one of those topics (spec: discovery
-- filterable by topic). p_only_open drops full groups.
-- ---------------------------------------------------------------------------
create or replace function public.discover_groups(
  p_course_id uuid,
  p_topic_ids uuid[] default null,
  p_only_open boolean default false
)
returns table (
  group_id       uuid,
  group_name     text,
  course_id      uuid,
  status         text,
  member_count   int,
  max_members    int,
  matched_topics int,
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
    (
      select count(*)::int
      from public.group_topics gt
      where gt.group_id = g.group_id
        and p_topic_ids is not null
        and gt.topic_id = any(p_topic_ids)
    ) as matched_topics,
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
      p_topic_ids is null
      or array_length(p_topic_ids, 1) is null
      or exists (
        select 1 from public.group_topics gt
        where gt.group_id = g.group_id and gt.topic_id = any(p_topic_ids)
      )
    )
    and (
      not p_only_open
      or public.group_member_count(g.group_id) < g.max_members
    )
  order by matched_topics desc, member_count desc
  limit 50;
end;
$$;

-- ---------------------------------------------------------------------------
-- Execution grants. SECURITY DEFINER functions default to EXECUTE for public,
-- which would let the anon role call them; every one already rejects a null
-- auth.uid(), but we revoke from anon and grant to authenticated to be explicit
-- rather than relying on that inner check alone.
-- ---------------------------------------------------------------------------
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'create_group(uuid,uuid,text,uuid,text,boolean,uuid[])',
    'send_invitation(uuid,uuid,uuid)',
    'respond_invitation(uuid,uuid,boolean)',
    'request_to_join(uuid,uuid)',
    'respond_join_request(uuid,uuid,boolean)',
    'leave_group(uuid,uuid)',
    'remove_member(uuid,uuid,uuid)',
    'rename_group(uuid,uuid,text)',
    'set_group_discoverable(uuid,uuid,boolean)',
    'archive_group(uuid,uuid)',
    'search_students(text,uuid,uuid)',
    'discover_groups(uuid,uuid[],boolean)'
  ]
  loop
    execute format('revoke all on function public.%s from public, anon;', fn);
    execute format('grant execute on function public.%s to authenticated;', fn);
  end loop;
end;
$$;
