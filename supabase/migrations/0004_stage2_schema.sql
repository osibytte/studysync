-- ============================================================================
-- StudySync — Stage 2: Group Formation
-- Migration 0004: schema (tables + indexes only)
-- ----------------------------------------------------------------------------
-- Run AFTER Stage 1 (0001–0003). 0005 adds the RLS policies and the RPCs that
-- write these tables; 0006 adds the lifecycle sweep. Run them in order.
--
-- Design note carried over from Stage 1's README ("Still to add in Stage 2"):
-- this migration adds `groups` (with is_discoverable / max_members /
-- last_activity_at), `group_members`, `invitations`, and `join_requests`.
--
-- Convention, matching Stage 1: lifecycle/role/status are `text` columns with
-- CHECK constraints rather than Postgres enums. Enums are awkward to extend
-- (every new value is a migration with a lock), and CHECK constraints read the
-- same in the schema and keep the door open for tuning the state set later.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Groups — the central object. A group carries its formation record now, and
-- from Stage 3+ its chat, materials and sessions all hang off group_id.
--
-- status is the queryable lifecycle field. It is kept up to date by the sweep
-- in 0006 and by the membership trigger in 0005 (disband on empty) — never
-- computed on read, per the spec.
--
--   forming    just created / matched; invites or join confirmations pending
--   active     at least one real interaction (chat/upload/session) — Stage 3+
--   dormant    14+ days with no activity (set by the daily sweep)
--   archived   30+ days dormant, or archived by the creator
--   disbanded  membership hit zero (set by the group_members delete trigger)
-- ---------------------------------------------------------------------------
create table if not exists public.groups (
  group_id       uuid primary key default gen_random_uuid(),
  group_name     text not null check (length(btrim(group_name)) between 1 and 80),
  course_id      uuid not null references public.courses(course_id) on delete restrict,
  formation_type text not null check (formation_type in ('system', 'self_organized')),
  status         text not null default 'forming'
                   check (status in ('forming', 'active', 'dormant', 'archived', 'disbanded')),
  -- Discoverable groups appear in other students' search on the same course.
  -- Direct-invite-only groups set this false.
  is_discoverable boolean not null default true,
  -- Soft cap from the spec (default 8), stored per-group so it can vary by
  -- course size later (an open decision in the spec) without a migration.
  -- The RPCs in 0005 enforce it; a large elective can be created with a higher
  -- cap without touching this default.
  max_members    int not null default 8 check (max_members between 2 and 50),
  -- Audit pointer to the original creator. The *active* creator is whoever
  -- holds role='creator' in group_members (which can transfer on leave), so
  -- this is deliberately separate and survives a transfer. set null on account
  -- deletion so a departed creator does not take the group's other members
  -- down with them.
  created_by     uuid references public.users(user_id) on delete set null,
  -- Drives the dormant/archived sweep. Bumped by touch_group_activity() in
  -- 0006 whenever a real interaction happens (wired up from Stage 3).
  last_activity_at timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

comment on table public.groups is
  'Study groups. status is the stored lifecycle state; last_activity_at drives the sweep.';

-- Discovery and matching both hard-filter by course, usually alongside status.
create index if not exists groups_course_status_idx
  on public.groups (course_id, status);
-- The daily sweep scans by status + age; this index carries that query.
create index if not exists groups_status_activity_idx
  on public.groups (status, last_activity_at);
-- Partial index for the discover screen's "open groups on this course" query.
create index if not exists groups_discoverable_idx
  on public.groups (course_id)
  where is_discoverable and status in ('forming', 'active', 'dormant');

-- ---------------------------------------------------------------------------
-- Group members — join table between groups and users, with a role.
--
-- The unique (group_id, user_id) constraint is load-bearing: it is what makes
-- "you're already in this group" a database guarantee rather than a race the
-- RPCs have to guard by hand.
--
-- role transfer and disband-on-empty are handled by an AFTER DELETE trigger in
-- 0005, so those invariants hold whether a row leaves via the leave_group RPC
-- or via an ON DELETE CASCADE from account deletion.
-- ---------------------------------------------------------------------------
create table if not exists public.group_members (
  member_id  uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups(group_id) on delete cascade,
  user_id    uuid not null references public.users(user_id) on delete cascade,
  role       text not null default 'member' check (role in ('creator', 'member')),
  joined_at  timestamptz not null default now(),
  constraint group_members_unique unique (group_id, user_id)
);

create index if not exists group_members_group_idx on public.group_members (group_id);
create index if not exists group_members_user_idx  on public.group_members (user_id);

-- ---------------------------------------------------------------------------
-- Invitations — Pathway Two, direct invite. A member picks a specific student;
-- the invitee accepts or declines.
--
-- The partial unique index blocks a second *pending* invite to the same
-- student for the same group, while still allowing a fresh invite after an
-- earlier one was declined or cancelled. A plain unique (group_id, invitee_id)
-- would permanently lock someone out of a group after one decline.
-- ---------------------------------------------------------------------------
create table if not exists public.invitations (
  invitation_id uuid primary key default gen_random_uuid(),
  group_id      uuid not null references public.groups(group_id) on delete cascade,
  inviter_id    uuid not null references public.users(user_id) on delete cascade,
  invitee_id    uuid not null references public.users(user_id) on delete cascade,
  status        text not null default 'pending'
                  check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at    timestamptz not null default now(),
  responded_at  timestamptz,
  -- can't invite yourself
  constraint invitations_not_self check (inviter_id <> invitee_id)
);

create unique index if not exists invitations_one_pending
  on public.invitations (group_id, invitee_id)
  where status = 'pending';

-- The invitee's "your invites" screen queries by invitee + pending.
create index if not exists invitations_invitee_idx
  on public.invitations (invitee_id, status);
create index if not exists invitations_group_idx
  on public.invitations (group_id, status);

-- ---------------------------------------------------------------------------
-- Join requests — Pathway Two, discoverable join. A student finds a
-- discoverable group and asks to join; a creator or member approves/declines.
--
-- Same partial-unique reasoning as invitations: one pending request per
-- (group, requester), re-requestable after a decline.
-- ---------------------------------------------------------------------------
create table if not exists public.join_requests (
  request_id   uuid primary key default gen_random_uuid(),
  group_id     uuid not null references public.groups(group_id) on delete cascade,
  requester_id uuid not null references public.users(user_id) on delete cascade,
  status       text not null default 'pending'
                 check (status in ('pending', 'approved', 'declined', 'cancelled')),
  responded_by uuid references public.users(user_id) on delete set null,
  created_at   timestamptz not null default now(),
  responded_at timestamptz
);

create unique index if not exists join_requests_one_pending
  on public.join_requests (group_id, requester_id)
  where status = 'pending';

create index if not exists join_requests_requester_idx
  on public.join_requests (requester_id, status);
create index if not exists join_requests_group_idx
  on public.join_requests (group_id, status);

-- ---------------------------------------------------------------------------
-- Group topics — the topics a group is about, chosen at creation ("optional
-- topics" in the spec) from the same curated per-course vocabulary students
-- use on their profiles.
--
-- Needed for two spec requirements: discovery "filterable by topic", and the
-- matching function scoring a requester's topics against an existing group's
-- when it decides whether to suggest filling that group. Kept as its own table
-- (not an array on groups) for the same reason user_course_topics is: overlap
-- is then a SQL join/count, not array intersection in application code.
-- ---------------------------------------------------------------------------
create table if not exists public.group_topics (
  group_id uuid not null references public.groups(group_id) on delete cascade,
  topic_id uuid not null references public.topics(topic_id) on delete cascade,
  primary key (group_id, topic_id)
);

create index if not exists group_topics_topic_idx on public.group_topics (topic_id);
