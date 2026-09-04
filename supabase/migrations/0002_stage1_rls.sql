-- ============================================================================
-- StudySync — Stage 1: Accounts & Profiles
-- Migration 0002: Row Level Security
-- ----------------------------------------------------------------------------
-- Run AFTER 0001.
--
-- Principle: deny by default, then grant the narrowest workable policy.
-- Enabling RLS without adding a policy blocks all access, so every table
-- below gets both the enable and its policies in the same migration.
--
-- Stage 1 posture is deliberately tight: a student can read and write ONLY
-- their own profile rows. Nobody can read anyone else's profile from the
-- client. Matching (Stage 2) needs to read across students, and it will do
-- that inside an Edge Function using the service-role key, which bypasses
-- RLS. That keeps cross-student reads on the server where they belong
-- instead of loosening these policies to make the client's job easier.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Courses — public read, no client write.
--
-- Every authenticated student needs the full course list to pick from, so
-- this is intentionally readable by all authenticated users. There is no
-- insert/update/delete policy, which means the client cannot write here at
-- all; seeding happens via SQL or the service-role key.
-- ---------------------------------------------------------------------------
alter table public.courses enable row level security;

drop policy if exists courses_select_authenticated on public.courses;
create policy courses_select_authenticated
  on public.courses
  for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- Topics — public read, no client write. Same reasoning as courses.
-- ---------------------------------------------------------------------------
alter table public.topics enable row level security;

drop policy if exists topics_select_authenticated on public.topics;
create policy topics_select_authenticated
  on public.topics
  for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- Users — a student sees and edits only their own row.
--
-- No insert policy: rows are created by the on_auth_user_created trigger,
-- which is security definer and therefore not subject to these policies.
-- Leaving insert unpolicied means a client cannot forge a profile row for
-- another uuid.
--
-- No delete policy either: account deletion cascades from auth.users, so
-- there is no reason to let the client delete profile rows directly.
-- ---------------------------------------------------------------------------
alter table public.users enable row level security;

drop policy if exists users_select_own on public.users;
create policy users_select_own
  on public.users
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists users_update_own on public.users;
create policy users_update_own
  on public.users
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- UserCourses — full CRUD, own rows only.
--
-- `with check` on insert is what stops a student inserting an enrolment row
-- under someone else's user_id. `using` on update/delete stops them touching
-- rows that already belong to someone else. Both clauses are needed on
-- update: `using` picks which rows are visible to the update, `with check`
-- validates the row after the change.
-- ---------------------------------------------------------------------------
alter table public.user_courses enable row level security;

drop policy if exists user_courses_select_own on public.user_courses;
create policy user_courses_select_own
  on public.user_courses
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists user_courses_insert_own on public.user_courses;
create policy user_courses_insert_own
  on public.user_courses
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists user_courses_update_own on public.user_courses;
create policy user_courses_update_own
  on public.user_courses
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists user_courses_delete_own on public.user_courses;
create policy user_courses_delete_own
  on public.user_courses
  for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- UserCourseTopics — ownership is indirect, via user_courses.
--
-- This table has no user_id of its own, so the policy has to hop through
-- user_courses to establish ownership. That subquery reads a DIFFERENT table
-- than the one being policed, so it does not recurse.
--
-- (Contrast with GroupMembers in Stage 2, where the natural policy would
-- query the same table it protects and recurse infinitely. That one needs a
-- security definer helper. This one does not.)
-- ---------------------------------------------------------------------------
alter table public.user_course_topics enable row level security;

drop policy if exists uct_select_own on public.user_course_topics;
create policy uct_select_own
  on public.user_course_topics
  for select
  to authenticated
  using (
    exists (
      select 1 from public.user_courses uc
      where uc.user_course_id = user_course_topics.user_course_id
        and uc.user_id = auth.uid()
    )
  );

drop policy if exists uct_insert_own on public.user_course_topics;
create policy uct_insert_own
  on public.user_course_topics
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.user_courses uc
      where uc.user_course_id = user_course_topics.user_course_id
        and uc.user_id = auth.uid()
    )
  );

drop policy if exists uct_delete_own on public.user_course_topics;
create policy uct_delete_own
  on public.user_course_topics
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.user_courses uc
      where uc.user_course_id = user_course_topics.user_course_id
        and uc.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Device push tokens — own rows only.
--
-- A token identifies a physical device, so leaking one would let someone
-- push arbitrary notifications to another student's phone. Kept as tight as
-- the profile itself.
-- ---------------------------------------------------------------------------
alter table public.device_push_tokens enable row level security;

drop policy if exists push_tokens_select_own on public.device_push_tokens;
create policy push_tokens_select_own
  on public.device_push_tokens
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists push_tokens_insert_own on public.device_push_tokens;
create policy push_tokens_insert_own
  on public.device_push_tokens
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists push_tokens_update_own on public.device_push_tokens;
create policy push_tokens_update_own
  on public.device_push_tokens
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists push_tokens_delete_own on public.device_push_tokens;
create policy push_tokens_delete_own
  on public.device_push_tokens
  for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Applied client actions — the offline replay ledger.
--
-- The client needs to insert (to claim an action id) and select (to check
-- whether a queued action already landed before retrying it). It must never
-- update or delete, or replay-protection could be erased and a queued write
-- applied twice.
-- ---------------------------------------------------------------------------
alter table public.applied_client_actions enable row level security;

drop policy if exists applied_actions_select_own on public.applied_client_actions;
create policy applied_actions_select_own
  on public.applied_client_actions
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists applied_actions_insert_own on public.applied_client_actions;
create policy applied_actions_insert_own
  on public.applied_client_actions
  for insert
  to authenticated
  with check (user_id = auth.uid());

-- ============================================================================
-- Verify — run these in the SQL editor after applying.
--
-- 1. Every Stage 1 table should report rowsecurity = true:
--
--    select tablename, rowsecurity
--    from pg_tables
--    where schemaname = 'public'
--    order by tablename;
--
-- 2. Policy inventory, to confirm nothing is missing or duplicated:
--
--    select tablename, policyname, cmd
--    from pg_policies
--    where schemaname = 'public'
--    order by tablename, cmd;
--
-- 3. The real test — cross-user isolation — cannot be done from the SQL
--    editor, because that runs as a superuser and bypasses RLS entirely.
--    It must be done with two real signed-in accounts from the app.
--    README.md has the step-by-step.
-- ============================================================================
