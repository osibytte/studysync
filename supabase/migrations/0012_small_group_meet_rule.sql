-- ============================================================================
-- 0012_small_group_meet_rule.sql
--
-- "When you can all meet" now means ALL of you while the group is small.
--
-- 0010 defined group_common_availability as a majority: a slot is shared when
-- `free >= ceil(n/2)`. That is the right rule for a group of six — insisting on
-- unanimity would let one busy member collapse the grid to empty — but it is
-- the wrong rule at the bottom of the range, where ceil(2/2) = 1 makes the
-- result a UNION. Measured live on 2026-09-05 with two members free at
--
--   1100110011001100110000000000
--   1100000011000000110011110000
--
-- the function returned 1100110011001100110011110000: every slot EITHER of them
-- could make, presented under a heading that promises both can. Every group
-- passes through n = 1, 2 and 3 on its way to six, so this is the state most
-- new groups are in when they first look at the screen.
--
-- The rule is now:
--
--   n <= 3   ->  threshold = n           (everyone; the answer is exact)
--   n >= 4   ->  threshold = ceil(n/2)   (unchanged majority)
--
-- The step at n = 4 (3-of-3 becomes 2-of-4) is deliberate and is the point of
-- the change: below four members "when can we all meet" has a real answer, so
-- the app gives that answer instead of a looser one.
--
-- The function now also RETURNS the numbers it used — the member count it
-- counted and the threshold it applied — so the screen can say which rule is in
-- force ("all 3 members", "at least 3 of 5") instead of hard-coding a phrase
-- that only matches one branch. That is why this is a drop-and-recreate rather
-- than a create-or-replace: the return type changes, so grants are re-issued
-- below.
--
-- NOT changed: groupCommonAvailability() in src/lib/availability.ts and its
-- mirror in supabase/functions/_shared/availability.ts, which stay on the plain
-- majority. That copy is not this display; it builds the representative grid
-- find-group scores a requester against, and it is asking a different question
-- — "how well would you fit in here", not "when do we all meet". Making a small
-- group's grid an intersection there would score most young groups 0 on
-- schedule overlap and bury the groups that most need members. The two rules
-- are allowed to differ; each is documented at the other's expense.
--
-- Forward-only and additive in the usual sense: no table touched, no data
-- migrated, and the mask is still a 28-character '0'/'1' string whose character
-- position is the bit index (day * 4 + slot).
-- ============================================================================

-- The return type changes, so the 0010 definition has to go first. Nothing
-- depends on it in the database (no view, no other function) — only the client,
-- through src/lib/groups.ts, which changes in the same commit.
drop function if exists public.group_common_availability(uuid);

create function public.group_common_availability(p_group_id uuid)
returns table (
  common_mask     text,
  members_counted int,
  meet_threshold  int
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_masks     text[];
  v_total     int;
  v_threshold int;
  v_mask      text;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are not a member of this group.';
  end if;

  -- Members *enrolled in the group's course*: the join drops anyone without a
  -- user_courses row for it. Since 0011 no new member can be in that state, but
  -- an existing one can still drop the course, and someone who is no longer on
  -- the course should not be counted as unavailable in every slot. Returning
  -- the count keeps the screen honest about who was actually counted.
  select array_agg(uc.availability::text)
  into v_masks
  from public.group_members gm
  join public.groups g        on g.group_id = gm.group_id
  join public.user_courses uc on uc.user_id = gm.user_id
                            and uc.course_id = g.course_id
  where gm.group_id = p_group_id;

  v_total := coalesce(array_length(v_masks, 1), 0);

  -- Nobody to count. An empty mask is the right answer — computing a threshold
  -- from a zero-member group would divide by nothing — and 0/0 tells the client
  -- to say so rather than claim "no slot works for everyone".
  if v_total = 0 then
    return query select repeat('0', 28), 0, 0;
    return;
  end if;

  v_threshold := case
    when v_total <= 3 then v_total
    else ceil(v_total::numeric / 2)::int
  end;

  -- One row per slot: how many of the counted members are free in it.
  select string_agg(
           case when t.free >= v_threshold then '1' else '0' end,
           '' order by t.i
         )
  into v_mask
  from (
    select s.i,
           count(*) filter (where substring(u.mask from s.i for 1) = '1') as free
    from generate_series(1, 28) as s(i)
    cross join unnest(v_masks) as u(mask)
    group by s.i
  ) t;

  return query select coalesce(v_mask, repeat('0', 28)), v_total, v_threshold;
end;
$$;

comment on function public.group_common_availability is
  'Shared availability (28-char mask) for a group the caller belongs to, with the member count and threshold used: everyone below four members, majority at four or more.';

-- Re-issue what the drop took away. Student-facing read: authenticated only,
-- explicitly revoked from anon/public so an unauthenticated key cannot probe
-- group membership through it.
revoke all on function public.group_common_availability(uuid) from public, anon;
grant execute on function public.group_common_availability(uuid) to authenticated;
