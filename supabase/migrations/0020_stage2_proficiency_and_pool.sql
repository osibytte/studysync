-- ============================================================================
-- 0020_stage2_proficiency_and_pool.sql
--
-- Three changes the owner asked for on 2026-09-05, and they are one change:
--
--   1. A student rates how well they understand each course they pick, and that
--      rating changes who they are grouped with.
--   2. Being system-matched becomes something a student APPLIES for inside a
--      registration period an admin opens — not something that happens to them
--      by default. Once they have applied for a course, they wait.
--   3. A picked course means "I want a study group for this one". Nothing else.
--
-- WHY IT IS ONE CHANGE. (2) turns the pool from a default into an act, which
-- makes `matching_pref` — an opt-OUT of a default — a column with no job left;
-- and an application is only worth making if it carries what matching needs,
-- which is (1). (3) is what makes (1) answerable: "how are you finding it" only
-- has a meaning if the list is courses you want help with rather than your whole
-- timetable.
--
-- WHAT THE WINDOW DOES AND DOES NOT GATE, in the owner's words: "the
-- registration window only matters to students that want the system to match
-- them". So it gates exactly one action — `request_matching` below. Browsing
-- discoverable groups, asking to join one, being invited, creating your own, and
-- the find-group suggestions all work identically whether a window is open,
-- closed, or has never existed. A closed window is not a closed app.
--
-- Forward-only, and it DROPS things: `user_courses.matching_pref` and
-- `set_matching_pref()`. See §3 for why retiring beats keeping both.
--
-- IT ALSO REACHES INTO STAGE 5, which a Stage 2 migration has no business doing
-- unless the reason is the feature itself. It is: the flow above ends on a matching
-- run the student is not present for, so §8 adds a 'group_matched' notification kind
-- and rewrites `create_system_group` to write those rows inside the same transaction
-- that creates the group. Without it "they can only wait" has no ending.
--
-- ORDER OF APPLICATION MATTERS ONCE. `run-batch-matching` (deployed) filters the
-- pool on `matching_pref = 'system'`, which this migration removes. Redeploy that
-- function from this branch when you apply this — HANDOFF §7 records it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §1. Proficiency — the student's own answer, not a mark.
--
-- Three bands, chosen over 1-5 on 2026-09-05: struggling / getting by / fairly
-- confident. A self-rating on a five-point scale clusters on the middle and the
-- extra precision is noise, whereas three bands are answerable in one tap
-- without agonising — which matters because this is asked during onboarding, when
-- every extra decision is somewhere a student stops.
--
-- NULLABLE, and the null means "never said" rather than "average". Every row
-- written before today has one, and a `default 2` would have quietly put words in
-- those students' mouths. The scorer treats an unknown as the middle band so
-- ranking degrades to schedule-only rather than breaking; the CHECK in §2 is what
-- makes a rating compulsory at the point it actually matters, which is applying.
--
-- smallint rather than an enum or text: it is ordered, and the mixing rule in
-- src/lib/matching.ts subtracts one band from another. `1 = struggling` so the
-- number rises with confidence, which is the direction every reader assumes.
-- The labels live in src/lib/groupRules.ts (PROFICIENCY_LABEL) — change one,
-- change both, the rule this project has run on since the availability bitmask.
-- ---------------------------------------------------------------------------
alter table public.user_courses
  add column if not exists proficiency smallint
    check (proficiency is null or proficiency between 1 and 3);

comment on column public.user_courses.proficiency is
  'The student''s own rating of how well they understand this course: 1 struggling, 2 getting by, 3 fairly confident. Null means they have not said. Required before applying to be matched (see the user_courses_applied_ready check).';

-- ---------------------------------------------------------------------------
-- §2. applied_at — the pool, as one timestamped fact.
--
-- Null means not in the pool. Not-null means "I have asked the system to place me
-- on this course, and I am waiting". One column, because there is only one fact
-- here: wanting to be matched and having asked to be matched are the same event
-- now that nothing puts a student in the pool on their behalf.
--
-- A TIMESTAMP RATHER THAN A BOOLEAN, for the reason `read_at` and `last_read_at`
-- are timestamps: "since when" is a question somebody asks the moment a run is
-- late ("I applied a week ago"), and a boolean cannot answer it afterwards.
--
-- BEING MATCHED IS NOT STORED HERE. `run-batch-matching`'s pool has always been
-- "wants matching MINUS anyone already in a group on this course", and group
-- membership is where that lives — deriving it keeps one source of truth instead
-- of a status column that can disagree with the roster. The consequence is worth
-- stating plainly: a student who leaves their system-formed group is back in the
-- pool for the next run, still holding the application they made. That is the
-- behaviour we want (they need a group again) rather than an oversight.
-- ---------------------------------------------------------------------------
alter table public.user_courses
  add column if not exists applied_at timestamptz;

comment on column public.user_courses.applied_at is
  'When the student asked the system to match them on this course. Null = not in the pool. Set only by request_matching(); authenticated has no column privilege on it.';

-- An applied enrolment always carries what matching needs.
--
-- A table CHECK rather than a guard inside request_matching, even though that
-- function checks the same two things with better error messages: the function is
-- one caller and this is an invariant. It also closes the update path — a student
-- CAN edit their rating and availability after applying (see §4, and that is
-- deliberate: the run reads live rows, so a correction can only improve the
-- match), and without this they could apply, then blank the rating, and sit in the
-- pool as a row the scorer has nothing to say about.
--
-- `position('1' in availability::text)` is how a bit(28) is asked "any slot at
-- all" — the cast renders it as 28 characters of '0'/'1', matching the client's
-- own 28-char string form (src/lib/availability.ts).
alter table public.user_courses
  drop constraint if exists user_courses_applied_ready;

alter table public.user_courses
  add constraint user_courses_applied_ready check (
    applied_at is null
    or (proficiency is not null and position('1' in availability::text) > 0)
  );

-- The pool scan: "who is waiting on this course". Replaces 0007's
-- user_courses_pool_idx, which was partial on matching_pref and goes with it.
create index if not exists user_courses_applied_idx
  on public.user_courses (course_id)
  where applied_at is not null;

-- ---------------------------------------------------------------------------
-- §3. Retire matching_pref, rather than keep it beside applied_at.
--
-- 0007 gave it one job: excluding a student from a pool they were in BY DEFAULT.
-- With §2 there is no default to be excluded from — not having applied is the
-- resting state — so 'self_organized' and a null `applied_at` are now the same
-- fact stated twice. Keeping both would put two controls for one thing in front of
-- the student ("Match me automatically" next to "Apply to be matched") and leave a
-- pool query that has to satisfy both, which is exactly the two-facts-that-looked-
-- alike drift this schema has been bitten by before (0012's threshold; the scorer
-- that shared a name with an RPC applying a different rule).
--
-- NOTHING IS BACKFILLED, and that is the point. Every existing row says
-- 'system' — the column default, not a choice anybody made — so translating it
-- into `applied_at = now()` would enrol the entire user base in a pool none of
-- them asked for, which is the exact behaviour the owner asked us to remove.
-- Everyone starts un-applied and applies for themselves.
--
-- The screen, the outbox action, the label tables and the type go with it in the
-- same commit; `git show` on this migration is the whole story.
-- ---------------------------------------------------------------------------
drop index if exists public.user_courses_pool_idx;

drop function if exists public.set_matching_pref(uuid, uuid, text);

alter table public.user_courses
  drop column if exists matching_pref;

-- ---------------------------------------------------------------------------
-- §4. Column privileges, so `applied_at` is not client-writable.
--
-- 0002 gives `user_courses` own-row policies for all four commands and the client
-- writes the table directly (enrolling, and saving availability). A policy checks
-- WHICH ROWS, never WHICH COLUMNS — so with a table-level UPDATE grant a student
-- could `update user_courses set applied_at = now()` on their own row and be in the
-- pool with the registration window shut and no rating. Column-level grants are
-- the only thing that stops that, and they are declarative rather than a trigger
-- that has to guess who the caller is.
--
-- `revoke` first, then grant exactly the two columns a student writes. This is the
-- corrected form of the two-line ritual: Supabase's stock default privileges grant
-- ALL on new public tables, not the four verbs 0008 names, so revoking a verb list
-- leaves privileges behind (0019's own comment got this wrong — see HANDOFF
-- invariant 3).
--
--   insert: user_id, course_id, availability, proficiency  (enrolling, and the
--           outbox's course.add, which carries availability)
--   update: availability, proficiency                       (both editable later)
--
-- SECURITY DEFINER functions are unaffected — they run as the owner — so
-- request_matching below is the only path to applied_at.
-- ---------------------------------------------------------------------------
revoke insert, update on public.user_courses from authenticated;

grant insert (user_id, course_id, availability, proficiency)
  on public.user_courses to authenticated;

grant update (availability, proficiency)
  on public.user_courses to authenticated;

-- ---------------------------------------------------------------------------
-- §5. No back-door withdrawal.
--
-- The owner's rule, verbatim: "after they signify for system to make them, they
-- can only wait for system to match them for that particular course." There is
-- therefore no withdraw RPC — but a student could achieve one by removing the
-- course and adding it again, since DELETE on their own enrolment is theirs (0002).
-- This trigger is what makes the rule true rather than merely intended.
--
-- Narrow on purpose. It refuses a delete only while the application is still
-- OUTSTANDING: applied, and not yet placed in a group on that course. Once a run
-- has placed them the application has been honoured and the row is theirs again.
-- A trigger rather than a policy because a policy would silently delete zero rows,
-- and "nothing happened" is the one response a student cannot act on; P0001 with a
-- sentence reaches them through friendlyError() like every other Stage 2 refusal.
-- ---------------------------------------------------------------------------
create or replace function public.user_courses_block_applied_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.applied_at is not null
     and not exists (
       select 1
         from public.group_members gm
         join public.groups g on g.group_id = gm.group_id
        where gm.user_id = old.user_id
          and g.course_id = old.course_id
     )
  then
    raise exception
      'You have applied to be matched on this course, so it cannot be removed until the matching run has placed you.';
  end if;
  return old;
end;
$$;

drop trigger if exists user_courses_block_applied_delete on public.user_courses;
create trigger user_courses_block_applied_delete
  before delete on public.user_courses
  for each row execute function public.user_courses_block_applied_delete();

-- ---------------------------------------------------------------------------
-- §6. The registration period.
--
-- One window for everybody, chosen on 2026-09-05 over per-course rounds: the
-- admin opens sign-up, students pick courses and apply per course inside it, and
-- matching still runs one course at a time exactly as it does today.
--
-- A TABLE OF WINDOWS, not a singleton settings row. The client has to say
-- "applications open on the 3rd" when the window is shut, which needs the NEXT
-- window to exist as a row; and a term with two intakes is two rows rather than an
-- edit that loses the first one.
--
-- The exclusion constraint stops two windows overlapping, which is what lets
-- "the open window" and "the next window" be single rows rather than a policy
-- decision. It needs no extension: gist indexes tstzrange out of the box (it is
-- btree_gist that would be needed to add a scalar column to the same index).
--
-- WHO WRITES: service_role only, through the two admin functions below. "Admin" in
-- this project is whoever holds the service key — there is deliberately no admin
-- role in the schema (see run-batch-matching's header), and this table does not
-- introduce one. Every authenticated student can READ every window: it is a
-- published deadline, and a student who cannot see it cannot plan around it.
-- ---------------------------------------------------------------------------
create table if not exists public.matching_windows (
  window_id uuid primary key default gen_random_uuid(),

  -- What to call it on screen: "Semester 1 intake". Shown to students, so it is
  -- checked for length rather than left to whatever a curl body contained.
  label text not null check (length(trim(label)) between 1 and 80),

  opens_at  timestamptz not null,
  closes_at timestamptz not null,

  created_at timestamptz not null default now(),

  constraint matching_windows_order check (closes_at > opens_at),
  constraint matching_windows_no_overlap
    exclude using gist (tstzrange(opens_at, closes_at) with &&)
);

comment on table public.matching_windows is
  'Registration periods for system matching. Gates request_matching() and nothing else — browsing, join requests, invitations and self-organised groups ignore it entirely.';

-- "Is one open now", and "which is next" — the only two questions asked of it.
create index if not exists matching_windows_opens_idx
  on public.matching_windows (opens_at);

alter table public.matching_windows enable row level security;

drop policy if exists matching_windows_select_all on public.matching_windows;
create policy matching_windows_select_all
  on public.matching_windows
  for select
  to authenticated
  using (true);

-- The corrected ritual: revoke everything the stock default privileges handed out,
-- then grant back the one verb the policy above is written for.
revoke all on public.matching_windows from authenticated, anon;
grant select on public.matching_windows to authenticated;
grant all on public.matching_windows to service_role;

-- The two admin calls. There is no admin screen and no admin role: whoever holds
-- the service key runs these from the Supabase SQL editor or a curl, the same
-- posture run-batch-matching has had since 0007.
--
-- WHY RPCS AT ALL, WHEN service_role ALREADY HOLDS `grant all`. Two reasons, and
-- neither is access control. The overlap constraint raises 23P01 — "conflicting
-- key value violates exclusion constraint" — which does not tell an admin what to
-- do about it; and "close the window early" is not expressible as an UPDATE
-- without first working out which row is open, so defining that once stops two
-- curls disagreeing about it.
--
-- CLOSING A WINDOW EARLY WITHDRAWS NOBODY. Applications already made keep their
-- applied_at and stay in the pool for the next run: the window gates the ACT of
-- applying, never the application. §7 is where that is enforced; this is only the
-- note that shutting the door does not empty the room.
create or replace function public.open_matching_window(
  p_label     text,
  p_opens_at  timestamptz default now(),
  p_closes_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_closes timestamptz := coalesce(p_closes_at, p_opens_at + interval '7 days');
  v_id     uuid;
begin
  if coalesce(length(btrim(p_label)), 0) = 0 then
    raise exception 'Give the registration period a label students will recognise.';
  end if;
  if v_closes <= p_opens_at then
    raise exception 'A registration period has to close after it opens.';
  end if;

  begin
    insert into public.matching_windows (label, opens_at, closes_at)
    values (btrim(p_label), p_opens_at, v_closes)
    returning window_id into v_id;
  exception when exclusion_violation then
    raise exception 'That period overlaps a registration window that already exists. Move it, or close the other one first.';
  end;

  return v_id;
end;
$$;

create or replace function public.close_matching_window_now()
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_closes timestamptz;
begin
  -- greatest() guards the closes_at > opens_at check in the one case that can
  -- reach it: a window opened this very instant.
  update public.matching_windows w
     set closes_at = greatest(now(), w.opens_at + interval '1 second')
   where w.opens_at  <= now()
     and w.closes_at >  now()
  returning w.closes_at into v_closes;

  if v_closes is null then
    raise exception 'No registration period is open right now.';
  end if;
  return v_closes;
end;
$$;

-- What the client renders, and the reason it is a function rather than the two
-- selects the policy above already allows: the answer depends on `now()`, and the
-- only clock the client has is the device's. A phone whose clock is a day out would
-- grey out the Apply button through an open window with no way for the student to
-- discover why. So the server hands back its own `now()` beside the window, and the
-- screen compares two instants it was given rather than one of them against the
-- device.
--
-- One row, always: the open window if there is one, else the next one to open, else
-- nulls with `server_now` still filled in. `security invoker`, so the SELECT policy
-- is what authorises the read — this needs no privilege the caller lacks. Every
-- column reference is table-qualified on purpose: the RETURNS TABLE names are
-- output parameters, and an unqualified `opens_at` in the body would be ambiguous.
create or replace function public.matching_window_state()
returns table (
  server_now timestamptz,
  is_open    boolean,
  window_id  uuid,
  label      text,
  opens_at   timestamptz,
  closes_at  timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with picked as (
    select w.window_id, w.label, w.opens_at, w.closes_at
      from public.matching_windows w
     where w.closes_at > now()
     -- An open window sorts before every future one. Overlaps are impossible, so
     -- `opens_at <= now()` is true of at most one row.
     order by (w.opens_at <= now()) desc, w.opens_at
     limit 1
  )
  select now(),
         coalesce(p.opens_at <= now(), false),
         p.window_id, p.label, p.opens_at, p.closes_at
    from (select 1) as one
    left join picked p on true;
$$;

revoke all on function public.open_matching_window(text, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function public.close_matching_window_now() from public, anon, authenticated;
revoke all on function public.matching_window_state()     from public, anon;

grant execute on function public.open_matching_window(text, timestamptz, timestamptz)
  to service_role;
grant execute on function public.close_matching_window_now() to service_role;
grant execute on function public.matching_window_state()     to authenticated;

-- ---------------------------------------------------------------------------
-- §7. request_matching — the one act the window gates.
--
-- The owner's sentence, and the whole contract: "after they signify for system to
-- make them, they can only wait for sytem to match them for that particular
-- course." So this function sets `applied_at` and there is deliberately no
-- `withdraw_matching` beside it; §5's trigger is what stops the same thing being
-- achieved by removing the course and adding it back.
--
-- IDEMPOTENT, AND IT RETURNS EARLY — before the window is even looked at. A second
-- tap, a retried request whose response was lost, or the screen reloading after the
-- window shut all return the original `applied_at` rather than an error, because
-- every one of them is a student who has already done the thing they are being
-- refused for. The check order below is chosen for the message a student ends up
-- reading, not for cheapness.
--
-- ONLINE ONLY. Every other student write in this app has a `client_action_id` and
-- an outbox replay behind it (0005's ledger); this one has neither, and that is a
-- decision rather than an omission. An application is a claim on a place in a pool
-- that a matching run can consume, so replaying one three days later — inside a
-- window that has since closed, possibly after the run it was meant for — puts a
-- student in a group formed by a round they were never part of. Failing now, with
-- the network error the student can see, is the smaller harm; the tap is one tap to
-- repeat, and it is idempotent when they do.
--
-- Being matched is not written here either (see §2): the run creates the group, and
-- membership is what says they were placed.
-- ---------------------------------------------------------------------------
create or replace function public.request_matching(p_course_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_row     public.user_courses;
  v_open_id uuid;
  v_applied timestamptz;
begin
  if v_uid is null then
    raise exception 'You must be signed in to apply to be matched.';
  end if;

  -- `for update` so two taps in flight at once serialise: the second waits, then
  -- sees applied_at set and takes the idempotent return below.
  select uc.* into v_row
    from public.user_courses uc
   where uc.user_id = v_uid
     and uc.course_id = p_course_id
   for update;

  if not found then
    raise exception 'Add this course to your list before applying to be matched.';
  end if;

  if v_row.applied_at is not null then
    return v_row.applied_at;
  end if;

  if exists (
    select 1
      from public.group_members gm
      join public.groups g on g.group_id = gm.group_id
     where gm.user_id = v_uid
       and g.course_id = p_course_id
  ) then
    raise exception 'You are already in a study group for this course.';
  end if;

  -- The window is checked BEFORE the rating and the availability, because it is the
  -- one refusal a student cannot act on: telling somebody to rate a course when
  -- applications are shut sends them to fix something that will not help.
  select w.window_id into v_open_id
    from public.matching_windows w
   where w.opens_at  <= now()
     and w.closes_at >  now()
   limit 1;

  if v_open_id is null then
    -- No date in this sentence on purpose. The next window's opens_at is a UTC
    -- instant and nothing in this schema has ever stored a student's timezone, so
    -- only the device can name the day; the screen has it from
    -- matching_window_state() and says it there. This message exists for the race
    -- where the window shut between the screen loading and the tap.
    raise exception 'Applications to be matched are closed right now. You can still browse groups for this course, ask to join one, or start your own.';
  end if;

  if v_row.proficiency is null then
    raise exception 'Say how you are finding this course before applying to be matched.';
  end if;

  if position('1' in v_row.availability::text) = 0 then
    raise exception 'Set your weekly availability before applying to be matched.';
  end if;

  update public.user_courses uc
     set applied_at = now()
   where uc.user_course_id = v_row.user_course_id
  returning uc.applied_at into v_applied;

  return v_applied;
end;
$$;

comment on function public.request_matching(uuid) is
  'Puts the caller in the matching pool for one course. Requires an open registration window, a proficiency rating and some availability. Idempotent; there is no withdrawal.';

revoke all on function public.request_matching(uuid) from public, anon;
grant execute on function public.request_matching(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- §8. Telling them, which is the only ending this flow has.
--
-- "They can only wait for system to match them" describes a student with nothing
-- left to do and no way to find out when it is done. Every other Stage 2 pathway
-- ends in something they can see happening — a request they sent, an invitation
-- they answered, a group they made. This one ends somewhere else entirely, on a
-- run they are not present for, so without a notification the feature is a form
-- that swallows a tap.
--
-- 'group_matched' is therefore a new notification kind. Widening a CHECK is one
-- `alter table` and 0017 has already done it once to messages_kind_shape, which is
-- the precedent 0019's own comment on `kind` points at.
--
-- The list below must stay identical to `NotificationKind` in src/types/database.ts
-- minus whatever `NOTIFICATION_LOCAL` marks local ('session_reminder', which is
-- scheduled on the device and can never be a row here). A test derives one from the
-- other and fails on drift — that mirror is why this list is spelled out in full
-- rather than added to with an `alter`-append nobody can read.
-- ---------------------------------------------------------------------------
alter table public.notifications
  drop constraint if exists notifications_kind_check;

alter table public.notifications
  add constraint notifications_kind_check check (kind in (
    'message_activity',
    'file_shared',
    'session_proposed',
    'session_confirmed',
    'session_cancelled',
    'invitation',
    'session_needs_one_yes',
    'group_free_slot',
    'group_quiet',
    'invitation_unanswered',
    'group_matched'
  ));

-- create_system_group, replaced so that placing a student and telling them are one
-- transaction.
--
-- SAME SIGNATURE as 0009's, so `create or replace` keeps the service_role-only
-- EXECUTE grant and no re-issue is needed. The body is 0009's with one select and
-- one insert added at the end.
--
-- ATOMIC, and that is why the copy is composed HERE rather than in
-- notificationRules.ts with the other ten kinds. The alternative — let
-- run-batch-matching write the rows after this returns — leaves a run that dies in
-- between having grouped students who are never told, and nothing would ever retry
-- it: they are in a group now, so the next run's pool excludes them and no code
-- goes looking for a notification it failed to send. Passing the words in as
-- parameters would keep them in TypeScript, but notificationRules.ts is not
-- mirrored into Deno the way matching.ts is, so the Edge Function would have to
-- restate them — a second spelling of the same sentence, which is the thing that
-- arrangement exists to prevent. The cost paid instead is that 'group_matched' is
-- the one kind whose words live in SQL: notificationRules.ts still owns its label,
-- its urgency and its cooldown, and its NotificationSubject union deliberately has
-- no arm for it.
--
-- URGENT — exempt from daily_cap under 0019's rule, whose bar is that missing it
-- costs something real. This one does: the student has been waiting since they
-- applied, possibly for weeks, and the group's first conversation happens whether
-- or not anybody told them. It cannot flood either, because the dedupe key is the
-- group id: once per student per group, forever. No nudge rule is bent here; being
-- placed is not a nudge.
--
-- A NOTE FOR STEP 6. This is the first `notifications` row written by the database
-- rather than by the sender, so nothing pushes it yet — the student finds it in the
-- in-app inbox next time they open the app. When the Expo Push sender lands it has
-- to learn to push urgent rows it did not itself compose, instead of only what its
-- own scan turns up. HANDOFF §8 carries that.
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




