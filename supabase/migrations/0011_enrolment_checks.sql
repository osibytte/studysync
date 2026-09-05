-- ============================================================================
-- StudySync — Stage 2: Group Formation
-- Migration 0011: nobody joins a group for a course they are not taking
-- ----------------------------------------------------------------------------
-- Run AFTER 0001–0010. Forward-only: one new helper and five replaced function
-- bodies. No schema changes, no data touched.
--
-- WHY. Driving the Stage 2 RPCs against the live database on 2026-09-05 turned
-- up a hole the client cannot reach but the API can: none of the paths that
-- create a group membership checked that the student is enrolled in the group's
-- course. A student taking only BIO 201 was able to create a group on CSC 201,
-- list that course's groups, and ask to join one.
--
-- It is not a cosmetic problem. Availability is stored per enrolment
-- (`user_courses.availability`), so a member with no `user_courses` row for the
-- group's course has no availability *for that group* at all — and
-- `group_common_availability` still counts them in its majority tally. The
-- observed result was an all-zero mask: one non-enrolled member is enough to
-- drag "when you can all meet" away from the students who really are on the
-- course. Matching reads the same aggregate, so it carries into the scores.
--
-- WHAT IS GATED. Every path that inserts into `group_members`:
--
--   create_group          the creator joins their own group
--   respond_join_request  approval adds the requester
--   respond_invitation    accepting adds yourself
--
-- and the two paths that *promise* one of those, so the refusal lands while the
-- student can still act on it instead of at the far end:
--
--   request_to_join       you could not be approved, so do not let you ask
--   send_invitation       they could not accept, so do not let you offer
--
-- Enrolment is checked at the moment of the insert, not only when the request or
-- invitation was created: `course.remove` exists, so a student can drop a course
-- between asking and being approved.
--
-- WHAT IS NOT GATED, deliberately: `discover_groups`. It returns what a group
-- already publishes to its course, and 0004's
-- `groups_select_member_or_discoverable` policy lets any authenticated student
-- select discoverable groups straight from the table — so gating the RPC would
-- close nothing the table policy leaves open, while a non-enrolled browser can
-- no longer act on what they see. If group listings should be enrolment-only,
-- that belongs in the RLS policy as its own decision.
--
-- Every message here is user-facing: friendlyError() passes a P0001 message
-- through to the screen unchanged, and "Your courses" is what the app calls the
-- screen that fixes it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The enrolment predicate, in the idiom of is_group_member / is_group_creator
-- (0005): SECURITY DEFINER so it can read `user_courses` without tripping that
-- table's own-row RLS, `stable` so the planner may cache it within a statement.
-- ---------------------------------------------------------------------------
create or replace function public.is_enrolled(
  p_user_id   uuid,
  p_course_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.user_courses
    where user_id = p_user_id and course_id = p_course_id
  );
$$;

revoke all on function public.is_enrolled(uuid, uuid) from public, anon;
grant execute on function public.is_enrolled(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- create_group — the creator becomes a member, so the creator must be enrolled.
-- Body is 0009's, plus the check. The claim comes first, as everywhere else: a
-- raise below rolls the whole transaction back, ledger row included, so the
-- student can fix the problem and retry with a fresh action id.
-- ---------------------------------------------------------------------------
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
  if not public.is_enrolled(v_uid, p_course_id) then
    raise exception 'You are not taking this course. Add it under Your courses first.';
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
-- request_to_join — an approval would insert the membership, so refuse the ask
-- rather than leaving the creator holding a request that cannot be honoured.
-- Body is 0005's, plus the group's course_id in the lookup and the check.
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
  v_course uuid;
  v_request_id uuid;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not public.claim_client_action(p_client_action_id, v_uid, 'request.send') then
    return null; -- replay
  end if;

  select status, is_discoverable, max_members, course_id
    into v_status, v_discoverable, v_max, v_course
  from public.groups where group_id = p_group_id;
  if not found then raise exception 'That group no longer exists.'; end if;
  if not v_discoverable or v_status in ('archived', 'disbanded') then
    raise exception 'This group is not open to join requests.';
  end if;
  if public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are already in this group.';
  end if;
  if not public.is_enrolled(v_uid, v_course) then
    raise exception 'You are not taking this course. Add it under Your courses first.';
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
-- send_invitation — the invitee could not accept, so do not let the invite be
-- offered. `search_students` (0005) only ever finds students on the course, so
-- the UI cannot reach this; a direct API caller can.
-- Body is 0005's, plus course_id in the lookup and the check.
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
  v_course uuid;
  v_invitation_id uuid;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;

  if not public.claim_client_action(p_client_action_id, v_uid, 'invite.send') then
    return null; -- replay
  end if;

  if v_uid = p_invitee_id then
    raise exception 'You cannot invite yourself.';
  end if;

  select status, is_discoverable, course_id
    into v_status, v_discoverable, v_course
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
  if not public.is_enrolled(p_invitee_id, v_course) then
    raise exception 'That student is not taking this course.';
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
-- respond_invitation — accepting inserts the membership. Checked here and not
-- only in send_invitation because a student can drop the course in between.
-- Declining stays unconditional: leaving a stale invitation pending forever
-- would be worse than letting a non-enrolled student say no.
-- Body is 0005's, plus course_id in the group lookup and the check.
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
  v_course uuid;
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
  select status, max_members, course_id into v_group_status, v_max, v_course
  from public.groups where group_id = v_group for update;
  if v_group_status in ('archived', 'disbanded') then
    raise exception 'This group is no longer active.';
  end if;
  if not public.is_enrolled(v_uid, v_course) then
    raise exception 'You are no longer taking this course. Add it back under Your courses to join.';
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
-- respond_join_request — approval inserts the requester's membership, so the
-- requester is the one who has to be enrolled. Checked here as well as in
-- request_to_join for the same reason: they may have dropped the course while
-- the request sat waiting. Declining stays unconditional.
-- Body is 0005's, plus course_id in the group lookup and the check.
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
  v_course uuid;
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

  select status, max_members, course_id into v_group_status, v_max, v_course
  from public.groups where group_id = v_group for update;
  if v_group_status in ('archived', 'disbanded') then
    raise exception 'This group is no longer active.';
  end if;
  if not public.is_enrolled(v_requester, v_course) then
    raise exception 'That student is no longer taking this course.';
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
-- Grants. `create or replace function` keeps the existing ACL, so these are
-- belt and braces — but this project has already lost a debugging session to a
-- missing grant (see 0008), so every migration states the privileges it means
-- the functions to have rather than assuming an inherited default.
-- ---------------------------------------------------------------------------
revoke all on function public.create_group(uuid, uuid, text, uuid, text, boolean) from public, anon;
grant execute on function public.create_group(uuid, uuid, text, uuid, text, boolean) to authenticated;

revoke all on function public.request_to_join(uuid, uuid) from public, anon;
grant execute on function public.request_to_join(uuid, uuid) to authenticated;

revoke all on function public.send_invitation(uuid, uuid, uuid) from public, anon;
grant execute on function public.send_invitation(uuid, uuid, uuid) to authenticated;

revoke all on function public.respond_invitation(uuid, uuid, boolean) from public, anon;
grant execute on function public.respond_invitation(uuid, uuid, boolean) to authenticated;

revoke all on function public.respond_join_request(uuid, uuid, boolean) from public, anon;
grant execute on function public.respond_join_request(uuid, uuid, boolean) to authenticated;
