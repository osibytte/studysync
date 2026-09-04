-- ============================================================================
-- StudySync — Stage 1: Accounts & Profiles
-- Migration 0001: schema
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL editor (or via `supabase db push`) BEFORE 0002.
--
-- Covers the spec's Users / Courses / UserCourses tables, plus the additions
-- agreed during spec review:
--   * `topics` as a curated per-course list (decision: fixed list, not free text)
--   * `availability` as a 7-day x 4-slot grid stored as a bitmask
--   * unique constraint on (user_id, course_id)
--   * device push token table (Expo cannot deliver without one)
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Courses — shared reference table, seeded from the university course list.
-- Not per-user. Every student reads the same rows.
-- ---------------------------------------------------------------------------
create table if not exists public.courses (
  course_id    uuid primary key default gen_random_uuid(),
  course_code  text not null unique,
  course_title text not null,
  department   text,
  created_at   timestamptz not null default now()
);

comment on table public.courses is
  'Shared reference list of university courses. Seeded, not user-created.';

-- ---------------------------------------------------------------------------
-- Topics — curated list scoped to a course.
--
-- DECISION (2026-09-03): topics are a fixed curated list per course rather
-- than free text. Matching compares topic_id sets, so overlap is exact set
-- intersection. Free text would silently under-report overlap ("recursion"
-- vs "Recursive functions" would score as zero).
-- ---------------------------------------------------------------------------
create table if not exists public.topics (
  topic_id    uuid primary key default gen_random_uuid(),
  course_id   uuid not null references public.courses(course_id) on delete cascade,
  topic_name  text not null,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  -- same topic name cannot appear twice within one course
  constraint topics_unique_per_course unique (course_id, topic_name)
);

create index if not exists topics_course_idx on public.topics (course_id, sort_order);

-- ---------------------------------------------------------------------------
-- Users — one row per student, keyed to Supabase Auth.
--
-- user_id is the SAME uuid as auth.users.id. This matters: every RLS policy
-- below compares auth.uid() to this column directly, with no lookup hop.
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  full_name          text,
  email              text not null,
  department         text,
  -- Quiet hours + frequency. Defaults are proposals, user-configurable per spec.
  -- daily_cap applies to non-urgent notifications only; urgent is never capped.
  notification_prefs jsonb not null default jsonb_build_object(
                       'quiet_hours_start', '22:00',
                       'quiet_hours_end',   '07:00',
                       'daily_cap',         3,
                       'push_enabled',      true
                     ),
  -- Set true once the student has a name, department, >=1 course and
  -- a non-empty availability grid. Gates entry to the main app.
  onboarding_complete boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on column public.users.user_id is
  'Same UUID as auth.users.id — RLS policies compare auth.uid() to this directly.';

-- ---------------------------------------------------------------------------
-- UserCourses — the join table matching actually queries.
--
-- `availability` is a 28-bit mask: 7 days x 4 slots.
--   bit index = (day_index * 4) + slot_index
--   day_index  0=Mon 1=Tue 2=Wed 3=Thu 4=Fri 5=Sat 6=Sun
--   slot_index 0=morning(08-12) 1=afternoon(12-16) 2=evening(16-20) 3=night(20-23)
--
-- Bit 0 is the LEFTMOST character of the bit string. The TypeScript helpers in
-- src/lib/availability.ts use the same convention — change one, change both.
--
-- Why a bitmask: schedule overlap becomes bit_count(a & b), a single cheap
-- operation the matching Edge Function can run against every candidate row.
-- ---------------------------------------------------------------------------
create table if not exists public.user_courses (
  user_course_id uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users(user_id) on delete cascade,
  course_id      uuid not null references public.courses(course_id) on delete cascade,
  -- Written out in full rather than repeat('0', 28)::bit(28): Postgres has no
  -- text -> bit cast, so the function form fails. A bit literal works because
  -- the untyped constant is parsed as bit directly.
  availability   bit(28) not null default B'0000000000000000000000000000',
  created_at     timestamptz not null default now(),
  -- a student enrols in a given course once
  constraint user_courses_unique unique (user_id, course_id)
);

-- Matching hard-filters by course first, so this index carries the query.
create index if not exists user_courses_course_idx on public.user_courses (course_id);
create index if not exists user_courses_user_idx   on public.user_courses (user_id);

-- ---------------------------------------------------------------------------
-- UserCourseTopics — which topics a student flagged for a given course.
--
-- Normalised out of user_courses rather than stored as an array, so the
-- matching query can join and count overlap in SQL instead of pulling arrays
-- into the Edge Function and intersecting them in JS.
-- ---------------------------------------------------------------------------
create table if not exists public.user_course_topics (
  user_course_id uuid not null references public.user_courses(user_course_id) on delete cascade,
  topic_id       uuid not null references public.topics(topic_id) on delete cascade,
  primary key (user_course_id, topic_id)
);

create index if not exists uct_topic_idx on public.user_course_topics (topic_id);

-- ---------------------------------------------------------------------------
-- Device push tokens — one row per user per device.
--
-- Not in the original spec's table list, but Expo cannot deliver a push
-- without a stored token, and a student may use more than one device.
-- Created in Stage 1 because it is user-scoped; consumed in Stage 5.
-- ---------------------------------------------------------------------------
create table if not exists public.device_push_tokens (
  token_id    uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(user_id) on delete cascade,
  expo_token  text not null unique,
  platform    text not null check (platform in ('ios', 'android')),
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists push_tokens_user_idx on public.device_push_tokens (user_id);

-- ---------------------------------------------------------------------------
-- Outbox — offline queue-and-sync support.
--
-- DECISION (2026-09-03): full queue-and-sync, not a read-only cache.
-- The client queues writes locally while offline and replays them on
-- reconnect. This server-side table is the idempotency ledger: the client
-- sends a client_action_id with each replayed write, and a duplicate replay
-- is rejected here rather than creating a second row.
--
-- Why this exists in Stage 1: replay-safety has to be designed in before
-- there are writes worth replaying, and every later stage depends on it.
-- ---------------------------------------------------------------------------
create table if not exists public.applied_client_actions (
  client_action_id uuid primary key,
  user_id          uuid not null references public.users(user_id) on delete cascade,
  action_type      text not null,
  applied_at       timestamptz not null default now()
);

create index if not exists applied_actions_user_idx
  on public.applied_client_actions (user_id, applied_at desc);

-- ---------------------------------------------------------------------------
-- Auto-create a public.users row when an auth user signs up.
--
-- security definer so it can write to public.users regardless of the RLS
-- policies that apply to the signing-up user. search_path is pinned to defeat
-- search-path hijacking, which is a real risk on any security definer function.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.users (user_id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', null)
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Keep users.updated_at honest.
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_touch_updated_at on public.users;
create trigger users_touch_updated_at
  before update on public.users
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Schedule overlap helper — counts shared availability slots.
--
-- Used by the Stage 2 matching function. Lives here because it belongs with
-- the column whose encoding it depends on.
-- ---------------------------------------------------------------------------
create or replace function public.availability_overlap(a bit(28), b bit(28))
returns int
language sql
immutable
parallel safe
as $$
  -- bit_count over the AND of both masks = number of slots both are free.
  select length(replace((a & b)::text, '0', ''));
$$;

comment on function public.availability_overlap is
  'Number of weekly slots two students are both free. Stage 2 matching uses this.';
