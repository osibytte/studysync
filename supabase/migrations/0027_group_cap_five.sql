-- ============================================================================
-- StudySync — 0027: the group cap comes down to five
-- ----------------------------------------------------------------------------
-- The product cap for a study group is FIVE, not the spec's original soft 8.
-- Three facts change together here:
--
--   1. the CHECK tightens from `between 2 and 50` to `between 2 and 5`, so no
--      path (RPC, dashboard, future feature) can create a group the app cannot
--      reason about;
--   2. the column DEFAULT comes down with it (8 -> 5). create_group (0011)
--      inserts without naming max_members, so the default is the value every
--      self-organised group actually gets;
--   3. create_system_group's p_max_members default follows (8 -> 5). The batch
--      matcher passes the parameter explicitly, but with the CHECK above a
--      stale default of 8 is a value nobody can use — a landmine for the first
--      caller that omits the argument.
--
-- Groups created before this migration may hold max_members = 8; they are
-- pulled down to 5 before the constraint is re-added, so the ALTER cannot fail
-- on existing rows.
--
-- The composition rules for automatic matching (at most one brilliant student
-- per group; strugglers capped at one below five members and two at five) are
-- enforced in the matcher itself — src/lib/matching.ts and its Deno mirror —
-- not in SQL: they bind the matching pool's choices, not the membership table.
-- Manual joins and invitations are deliberately untouched.
-- ============================================================================

update public.groups
   set max_members = 5
 where max_members > 5;

alter table public.groups drop constraint groups_max_members_check;

alter table public.groups
  add constraint groups_max_members_check check (max_members between 2 and 5);

alter table public.groups alter column max_members set default 5;

create or replace function public.create_system_group(
  p_group_id     uuid,
  p_group_name   text,
  p_course_id    uuid,
  p_member_ids   uuid[],
  p_creator_id   uuid,
  p_max_members  int default 5
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count   int  := coalesce(array_length(p_member_ids, 1), 0);
  v_name    text := btrim(p_group_name);
  v_members int;
  v_code    text;
  v_body    text;
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
  if coalesce(length(v_name), 0) = 0 then
    raise exception 'Give the group a name.';
  end if;

  insert into public.groups (
    group_id, group_name, course_id, formation_type, is_discoverable,
    max_members, created_by
  ) values (
    p_group_id, v_name, p_course_id, 'system', true,
    p_max_members, p_creator_id
  );

  -- One row per member; the creator carries role='creator', the rest 'member'.
  -- on conflict tolerates a duplicate id in the input array.
  insert into public.group_members (group_id, user_id, role)
  select p_group_id, mem.user_id,
         case when mem.user_id = p_creator_id then 'creator' else 'member' end
  from unnest(p_member_ids) as mem(user_id)
  on conflict (group_id, user_id) do nothing;

  -- Read the roster back rather than trusting the array: `do nothing` above means a
  -- duplicated id is one member, so this is exactly the people who ended up in the
  -- group and the sentence below counts them correctly.
  select count(*) into v_members
    from public.group_members gm
   where gm.group_id = p_group_id;

  select c.course_code into v_code
    from public.courses c
   where c.course_id = p_course_id;

  v_body := 'You are now in ' || v_name
         || coalesce(' for ' || v_code, '')
         || case when v_members > 1
                 then ' with ' || (v_members - 1) || ' other'
                      || case when v_members = 2 then '' else 's' end
                 else '' end
         || '. Open it to say hello and find a time.';

  -- left() is insurance, not formatting: `body` is checked at 400 characters, and a
  -- failed check here would roll back the group itself. A truncated sentence is a
  -- far better outcome than a matching run that cannot place anybody because one
  -- group name was long.
  insert into public.notifications (
    user_id, group_id, kind, title, body, urgent, dedupe_key
  )
  select gm.user_id,
         p_group_id,
         'group_matched',
         left('You have been matched' || coalesce(' for ' || v_code, ''), 120),
         left(v_body, 400),
         true,
         'group_matched:' || p_group_id
    from public.group_members gm
   where gm.group_id = p_group_id
  on conflict (user_id, dedupe_key) do nothing;

  return p_group_id;
end;
$$;
