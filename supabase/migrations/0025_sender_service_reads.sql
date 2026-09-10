-- ---------------------------------------------------------------------------
-- 0025 — the sender's service-side reads, without an identity gate.
--
-- 0024 granted the sender EXECUTE on the student-facing read RPCs, and the
-- live run then showed why that was not enough: `group_sessions` and
-- `session_attendees` open with `if v_uid is null then raise`, and a service
-- sweep HAS no uid — it is not a member of anything. Bypassing RLS was never
-- the missing piece; the identity gate was.
--
-- The rule the sender works under is that it must not re-derive in TypeScript
-- what the database computes (the tally and threshold are the same numbers the
-- session card renders; a second arithmetic is how the two drift). So the
-- computations stay in SQL and get service-only twins that differ from the
-- student-facing functions in exactly one respect: no `auth.uid()` gate.
--
--   - the tally needs NO twin. `session_agreement` (0016) is a pure helper
--     with no gate at all — 0024's mistake was granting the wrapper, not this.
--     0025 grants it to service_role.
--   - `sender_session_waiting` — the members of a session's group who have not
--     answered, which is who session_needs_one_yes chases. The roster part of
--     `session_attendees` (0016) without the name join the sender does not use
--     and the gate it cannot pass.
--   - `sender_group_common` — `group_common_availability` (0012) with the
--     body copied VERBATIM except the two gate lines: same enrolment join,
--     same 0012 threshold (everyone below four, majority at four or more),
--     same empty-mask answer. If 0012's rule ever changes, this body changes
--     with it — the mirror discipline of invariant 1, in SQL.
--
-- Executable by service_role ONLY — revoked from public, anon and
-- authenticated, the inverse of the student-facing ritual. A student has no
-- call for these; every screen path goes through the gated originals.
-- Forward-only and additive.
-- ---------------------------------------------------------------------------

create or replace function public.sender_session_waiting(p_session_id uuid)
returns table (user_id uuid)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select gm.user_id
  from public.study_sessions s
  join public.group_members gm on gm.group_id = s.group_id
  left join public.session_responses r
         on r.session_id = s.session_id and r.user_id = gm.user_id
  where s.session_id = p_session_id
    and r.user_id is null
  order by gm.user_id;
$$;

create or replace function public.sender_group_common(p_group_id uuid)
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
  v_masks     text[];
  v_total     int;
  v_threshold int;
  v_mask      text;
begin
  -- From here down this is 0012's group_common_availability body verbatim,
  -- minus its auth.uid()/is_group_member gate. Change one, change both.
  select array_agg(uc.availability::text)
  into v_masks
  from public.group_members gm
  join public.groups g        on g.group_id = gm.group_id
  join public.user_courses uc on uc.user_id = gm.user_id
                            and uc.course_id = g.course_id
  where gm.group_id = p_group_id;

  v_total := coalesce(array_length(v_masks, 1), 0);

  if v_total = 0 then
    return query select repeat('0', 28), 0, 0;
    return;
  end if;

  v_threshold := case
    when v_total <= 3 then v_total
    else ceil(v_total::numeric / 2)::int
  end;

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

-- The sender's own callable set. Nothing here is for students: the gated
-- originals keep their 0016/0012/0010 grants exactly as they are.
revoke all on function public.sender_session_waiting(uuid)
  from public, anon, authenticated;
revoke all on function public.sender_group_common(uuid)
  from public, anon, authenticated;
grant execute on function public.sender_session_waiting(uuid) to service_role;
grant execute on function public.sender_group_common(uuid) to service_role;
grant execute on function public.session_agreement(uuid) to service_role;
