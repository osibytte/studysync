-- ============================================================================
-- StudySync — Stage 2: Group Formation
-- Migration 0010: read RPCs the client UI needs
-- ----------------------------------------------------------------------------
-- Run AFTER 0001–0009. Forward-only and additive: four new SECURITY DEFINER
-- read functions, no schema changes, no data touched.
--
-- WHY THESE EXIST — the name-resolution gap.
--
-- Stage 1's RLS on public.users is own-row only (`users_select_own`), which is
-- the right default: a student must not be able to enumerate the student body.
-- Stage 2's policies then let a member read `group_members` (user ids + roles)
-- and their own `invitations` / `join_requests` rows — but NOT the *names*
-- behind those ids. So with 0004–0009 alone the client can learn that a group
-- has four members and that someone invited it, and can render neither.
--
-- Widening the users policy would fix the screens and break the privacy posture.
-- Instead these RPCs follow the precedent already set by `search_students`
-- (0005): SECURITY DEFINER, `stable`, gated on an explicit membership check, and
-- returning **name and department only — never email, never a raw availability
-- mask**. Each function exposes names for rows the caller can already see, and
-- nothing more.
--
--   group_members_detail    the roster for a group you belong to
--   group_common_availability  when that group tends to be free (aggregate)
--   my_invitations          your pending invites, with group + inviter named
--   group_join_requests     pending requests to a group you belong to
--
-- All four are read-only, so none of them carries a p_client_action_id: the
-- offline ledger exists to de-duplicate replayed *writes*.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- group_members_detail — the roster behind group_members, with names.
--
-- Gated on membership, matching the group_members SELECT policy exactly: this
-- adds names to rows the caller could already read, it does not widen which
-- rows are visible. A non-member browsing a discoverable group still sees only
-- the aggregate count from discover_groups.
--
-- Ordered creator-first, then by join time, which is the order the group detail
-- screen renders.
-- ---------------------------------------------------------------------------
create or replace function public.group_members_detail(p_group_id uuid)
returns table (
  user_id    uuid,
  full_name  text,
  department text,
  role       text,
  joined_at  timestamptz
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
  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are not a member of this group.';
  end if;

  return query
  select gm.user_id, u.full_name, u.department, gm.role, gm.joined_at
  from public.group_members gm
  join public.users u on u.user_id = gm.user_id
  where gm.group_id = p_group_id
  order by (gm.role = 'creator') desc, gm.joined_at;
end;
$$;

comment on function public.group_members_detail is
  'Roster (name + department only) for a group the caller belongs to.';

-- ---------------------------------------------------------------------------
-- group_common_availability — the group's shared free time as a 28-char mask.
--
-- Returns an AGGREGATE rather than each member's grid on purpose. Members do
-- need to know when the group can meet, but that is answerable without handing
-- every member everyone else's weekly schedule, so the per-member masks stay
-- server-side and only the overlap comes out.
--
-- Majority rule, mirroring groupCommonAvailability() in src/lib/availability.ts:
-- a slot is common when at least ceil(n/2) members are free in it. Strict
-- intersection would let one busy member collapse a large group's grid to
-- empty. **Change one, change the other** — the client renders this mask with
-- decodeAvailability(), so the two definitions must agree.
--
-- The denominator counts members *enrolled in the group's course* (the join
-- drops anyone without a user_courses row for it). In practice that is every
-- member, since a group only ever forms within one course.
--
-- Text, not bit(28): the client's availability helpers read a '0'/'1' string
-- whose character position is the bit index (day*4 + slot), and bit(28)::text
-- is exactly that string.
-- ---------------------------------------------------------------------------
create or replace function public.group_common_availability(p_group_id uuid)
returns text
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_mask text;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are not a member of this group.';
  end if;

  with masks as (
    select uc.availability::text as mask
    from public.group_members gm
    join public.groups g        on g.group_id = gm.group_id
    join public.user_courses uc on uc.user_id = gm.user_id
                              and uc.course_id = g.course_id
    where gm.group_id = p_group_id
  ),
  -- One row per slot: how many members are free in it, and the group size.
  -- `total` is constant across the 28 rows; carrying it here keeps the
  -- majority threshold in the same expression as the count it compares to.
  tally as (
    select s.i,
           count(*) filter (where substring(m.mask from s.i for 1) = '1') as free,
           (select count(*) from masks) as total
    from generate_series(1, 28) as s(i)
    cross join masks m
    group by s.i
  )
  select string_agg(
           case when t.free >= ceil(t.total::numeric / 2) then '1' else '0' end,
           '' order by t.i
         )
  into v_mask
  from tally t;

  -- No members enrolled in the course -> `masks` is empty, the cross join
  -- yields nothing, and string_agg returns null. The empty mask is the right
  -- answer there (and matches the TS helper, which returns an empty grid);
  -- computing it as a majority would divide by a zero-member group.
  return coalesce(v_mask, repeat('0', 28));
end;
$$;

comment on function public.group_common_availability is
  'Majority-rule shared availability (28-char mask) for a group the caller belongs to.';

-- ---------------------------------------------------------------------------
-- my_invitations — the invitee's inbox.
--
-- The rows are already readable (invitations_select allows invitee_id =
-- auth.uid()); what the client cannot get is the group name, the course, or who
-- sent it. Note the group name in particular: a NON-discoverable group is
-- invisible to a non-member under the groups SELECT policy, so an invite to a
-- private group would otherwise render as a nameless card.
--
-- Capacity comes along so the card can say "3 of 8" and so an invite to a group
-- that filled up while the invite sat unread can be shown as full rather than
-- failing on tap.
-- ---------------------------------------------------------------------------
create or replace function public.my_invitations()
returns table (
  invitation_id uuid,
  group_id      uuid,
  group_name    text,
  course_id     uuid,
  course_code   text,
  course_title  text,
  inviter_id    uuid,
  inviter_name  text,
  member_count  int,
  max_members   int,
  group_status  text,
  created_at    timestamptz
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
    i.invitation_id,
    g.group_id,
    g.group_name,
    c.course_id,
    c.course_code,
    c.course_title,
    i.inviter_id,
    inviter.full_name as inviter_name,
    public.group_member_count(g.group_id) as member_count,
    g.max_members,
    g.status as group_status,
    i.created_at
  from public.invitations i
  join public.groups g      on g.group_id = i.group_id
  join public.courses c     on c.course_id = g.course_id
  join public.users inviter on inviter.user_id = i.inviter_id
  where i.invitee_id = v_uid
    and i.status = 'pending'
    and g.status not in ('archived', 'disbanded')
  order by i.created_at desc;
end;
$$;

comment on function public.my_invitations is
  'The caller''s pending invitations, with group, course and inviter name resolved.';

-- ---------------------------------------------------------------------------
-- group_join_requests — pending requests to a group, with requester names.
--
-- Gated on membership rather than creator, matching the join_requests SELECT
-- policy: any member can already read these rows, so any member may see who is
-- asking. *Responding* stays creator-only — that check lives in
-- respond_join_request (0005), which is the write path.
-- ---------------------------------------------------------------------------
create or replace function public.group_join_requests(p_group_id uuid)
returns table (
  request_id   uuid,
  requester_id uuid,
  full_name    text,
  department   text,
  created_at   timestamptz
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
  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are not a member of this group.';
  end if;

  return query
  select jr.request_id, jr.requester_id, u.full_name, u.department, jr.created_at
  from public.join_requests jr
  join public.users u on u.user_id = jr.requester_id
  where jr.group_id = p_group_id
    and jr.status = 'pending'
  order by jr.created_at;
end;
$$;

comment on function public.group_join_requests is
  'Pending join requests (requester name + department) for a group the caller belongs to.';

-- ---------------------------------------------------------------------------
-- Execution grants. All four are student-facing reads: authenticated only, and
-- explicitly revoked from anon/public so an unauthenticated key cannot probe
-- them (each also raises on a null auth.uid(), belt and braces).
-- ---------------------------------------------------------------------------
revoke all on function public.group_members_detail(uuid) from public, anon;
grant execute on function public.group_members_detail(uuid) to authenticated;

revoke all on function public.group_common_availability(uuid) from public, anon;
grant execute on function public.group_common_availability(uuid) to authenticated;

revoke all on function public.my_invitations() from public, anon;
grant execute on function public.my_invitations() to authenticated;

revoke all on function public.group_join_requests(uuid) from public, anon;
grant execute on function public.group_join_requests(uuid) to authenticated;
