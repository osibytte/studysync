-- ============================================================================
-- 0019_stage5_notifications.sql  —  the delivery ledger Stage 5 sends from.
--
-- A ROW PER THING WE TOLD A STUDENT, not a row per thing that happened. That
-- distinction is the whole design and it is forced by one word in 0001: the
-- `daily_cap` in `users.notification_prefs`. You cannot enforce a cap you do not
-- count, and "have we already told this student?" is not derivable from
-- `messages`, `materials`, `study_sessions` or `invitations` — those record
-- events, and an event does not know who was reached about it, when, or whether
-- a retry sent it twice. So this table is the sender's own record, written at
-- delivery time, and it answers three questions nothing else can:
--
--   how many non-urgent notifications has this student had today?  (the cap)
--   have we already said this?                                     (dedupe_key)
--   what is in their in-app inbox?                                 (the list)
--
-- CHAT STAYS WATERMARKED. The obvious implementation — one row per message per
-- recipient — writes five rows every time somebody speaks in a group of six.
-- Stage 3 already refused that firehose once, when it chose `last_read_at` over
-- notification rows for unread badges, and nothing has changed to make it a good
-- idea. Instead the sender reads `messages`/`materials`/`study_sessions` against
-- a per-member watermark (`group_members.last_pushed_at`, added below) and writes
-- ONE digest row per group per run: "4 new messages in BIO 201". The row count
-- then scales with how often the sender runs, not with how chatty a group is.
--
-- THE LOCAL 30-MINUTE ALARM WRITES NOTHING HERE, and that is deliberate rather
-- than an omission. It is scheduled by the student's own device (see
-- `src/lib/notifier.ts`), fires from the OS with no server involved, and is
-- `urgent` — so it is uncapped, needs no dedupe, and there is no sender to
-- record it. A phone in airplane mode could not write this row anyway, which is
-- precisely the requirement that path exists to satisfy. `kind` therefore has no
-- 'session_reminder' value: this table's vocabulary is what a SERVER sends.
--
-- WHO WRITES: only the sender, which runs as service_role. Students get SELECT on
-- their own rows plus one RPC to mark a row read. That is the two-line grant
-- ritual 0015 spelled out for exactly this table, plus the `revoke all` from anon.
--
-- Forward-only: one new table, one new column on group_members, two RPCs.
-- ============================================================================

create table if not exists public.notifications (
  -- Server-generated, unlike message_id and session_id. Those are client-chosen
  -- because the client renders an optimistic copy before the row exists; nothing
  -- here is optimistic — a notification exists because the sender sent it.
  notification_id uuid primary key default gen_random_uuid(),

  user_id  uuid not null references public.users(user_id)  on delete cascade,

  -- Nullable on purpose. Every kind below is about a group, so in practice this
  -- is always set today — but an account-level notice ("your email changed")
  -- belongs in the same inbox and would have no group, and a not-null column
  -- would force a fake one. Cascade so leaving nothing behind is automatic.
  group_id uuid references public.groups(group_id) on delete cascade,

  -- The vocabulary. A check rather than an enum: adding a value to an enum is a
  -- migration that cannot run inside a transaction with other DDL on older
  -- Postgres, whereas widening a check is one `alter table` — and 0017 has
  -- already widened one in this project.
  --
  -- These names are NOT chosen here. They are `NotificationKind` in
  -- src/types/database.ts, which src/lib/notificationRules.ts keys three
  -- exhaustive Records on (copy, urgency, local-vs-remote). Change one, change
  -- both — the same rule the availability bitmask lives under.
  --
  --   chat activity (the scope statement's "messages, meeting schedule, files")
  --     message_activity      N new messages since we last told you
  --     file_shared           somebody shared a file
  --     session_proposed      somebody proposed a study time
  --     session_confirmed     enough yeses; it is happening
  --     session_cancelled     it is not happening after all
  --     invitation            you were invited to a group
  --
  --   the four nudges the owner chose on 2026-09-05 for "whatever notification
  --   is smart to indulge students to study" — every one non-urgent, capped,
  --   quiet-hours-silenced and individually switchable, for the reason in the
  --   comment on `urgent` below
  --     session_needs_one_yes one more yes and it is confirmed
  --     group_free_slot       you are all free then; propose something
  --     group_quiet           nothing has happened here in a while
  --     invitation_unanswered you never replied to that invitation
  --
  -- 'session_reminder' IS ABSENT and must stay absent. It is the one kind the
  -- DEVICE schedules (`NOTIFICATION_LOCAL` marks it true), it fires from the OS
  -- with no server involved, and a phone in airplane mode — the state the whole
  -- path exists for — could not write this row anyway. A sender that pushed one
  -- would give a student with a signal the alarm twice, one of them at the wrong
  -- second. The constraint is what makes that a failed insert rather than a
  -- duplicate alert.
  kind text not null check (kind in (
    'message_activity',
    'file_shared',
    'session_proposed',
    'session_confirmed',
    'session_cancelled',
    'invitation',
    'session_needs_one_yes',
    'group_free_slot',
    'group_quiet',
    'invitation_unanswered'
  )),

  -- The text as sent. Stored, not re-derived, because the inbox must show what
  -- the student's phone actually showed them: "4 new messages" stays true in the
  -- inbox even after a fifth arrives, and a session whose time later moved must
  -- not silently rewrite the notification that named the old one.
  title text not null check (length(trim(title)) between 1 and 120),
  body  text not null check (length(trim(body))  between 1 and 400),

  -- Set by the sender, not derived here, and the mapping lives in
  -- `src/lib/notificationRules.ts` beside the copy — same arrangement as the
  -- matching weights, which are mirrored rather than duplicated in SQL.
  --
  -- 0001's own comment fixes what this means: `daily_cap` applies to non-urgent
  -- only, urgent is never capped. Which makes `urgent = true` a decision to
  -- bypass the student's stated limit, so the bar is that missing it costs them
  -- something real — a session confirmed or cancelled changes where they will be
  -- in three hours. No nudge is ever urgent: an engagement notification that
  -- ignores the cap is how a student ends up disabling notifications at the OS
  -- level, and the 30-minute study alarm they actually wanted dies with it.
  urgent boolean not null default false,

  -- "Have we already said this?" One string, shaped by the sender, unique per
  -- student — see the index below for what it buys and why it is not optional.
  dedupe_key text not null check (length(trim(dedupe_key)) between 1 and 200),

  created_at timestamptz not null default now(),

  -- Null until the student dismisses it in the inbox. Deliberately NOT the same
  -- fact as `group_members.last_read_at`: dismissing a notification is not
  -- reading the conversation, and conflating them would either mark a group read
  -- from the inbox or resurrect notifications on every visit to the chat. Stage 4
  -- had to draw this same line for materials.
  read_at timestamptz
);

comment on table public.notifications is
  'One row per notification the SENDER delivered to one student. Not an event log — the local 30-minute study alarm is scheduled on the device and appears nowhere here.';

comment on column public.notifications.dedupe_key is
  'Sender-shaped idempotency key, unique per user. Also the cooldown mechanism: bucket a period into the key and a re-run inside that period cannot resend.';

comment on column public.notifications.urgent is
  'Exempts the row from users.notification_prefs->daily_cap (0001). Never true for a nudge.';

-- ---------------------------------------------------------------------------
-- THE UNIQUE INDEX IS THE FEATURE, not a hygiene measure.
--
-- An Edge Function can be invoked twice for one schedule tick — a retry after a
-- timeout that actually succeeded, an operator running it by hand, two cron
-- entries nobody reconciled. Without this, the second run re-sends everything the
-- first one sent, and the failure is not symmetrical with a missed notification:
-- a student who gets told twice about the same thing stops trusting the app, and
-- the duplicate also burns their daily_cap on a repeat.
--
-- It doubles as the cooldown. `group_quiet` should fire at most once per group
-- per fortnight, and there is no cooldown table: the sender puts the fortnight in
-- the key ('group_quiet:<group>:2026-W35', the label of the fortnight's first
-- week), and a run inside the same fortnight collides here and writes nothing.
-- `NOTIFICATION_COOLDOWN` in src/lib/notificationRules.ts is where each kind's
-- period is declared, and `cooldownBucket` is the one function that computes the
-- string — the Edge Function has to reproduce it exactly, so it is stated once.
-- Same trick gives message_activity its per-run bucket (the watermark below) and
-- invitation_unanswered its one-chase-only.
--
-- Scoped to (user_id, dedupe_key) rather than globally, so one group's fan-out
-- can share a key shape across its members without the first insert blocking the
-- rest.
-- ---------------------------------------------------------------------------
create unique index if not exists notifications_dedupe_idx
  on public.notifications (user_id, dedupe_key);

-- The inbox: newest first, keyset-paged. notification_id breaks ties because two
-- rows from one fan-out share a created_at to the microsecond often enough that
-- an unstable sort would drop or repeat a row across pages.
create index if not exists notifications_inbox_idx
  on public.notifications (user_id, created_at desc, notification_id desc);

-- The unread badge, and the cap count. Partial, because unread rows are the small
-- minority once the app has been used for a week, and the sender asks this
-- question for every candidate recipient on every run.
create index if not exists notifications_unread_idx
  on public.notifications (user_id)
  where read_at is null;

-- ---------------------------------------------------------------------------
-- The watermark that keeps chat digests from becoming a firehose.
--
-- Sits on group_members beside `last_read_at` (0014) because it is the same shape
-- of fact — a per-member cursor into one group's timeline — and a separate table
-- would need its own RLS, its own grants and a join on every sender run to say
-- nothing new.
--
-- It is NOT `last_read_at`. Reading the chat must not suppress the next digest,
-- and being told about a message must not mark it read. Two cursors, two
-- meanings; the app has already been bitten once by collapsing two facts that
-- looked alike (see 0012's threshold, and the scorer that shared a name with an
-- RPC applying a different rule).
--
-- Defaults to now() rather than null so a brand-new member is never told about
-- the entire backlog of a group they just joined — the one bug a null default
-- guarantees, and it lands on somebody's very first minute in the app.
--
-- Written only by the sender (service_role). Students have no UPDATE on
-- group_members at all: 0015's audit found the broad grants from 0008, and the
-- write path here is a definer RPC, same as everywhere else.
-- ---------------------------------------------------------------------------
alter table public.group_members
  add column if not exists last_pushed_at timestamptz not null default now();

comment on column public.group_members.last_pushed_at is
  'Watermark for outbound notifications: everything in this group after this instant is what the member has NOT been told about. Distinct from last_read_at, which is what they have not READ.';

-- ---------------------------------------------------------------------------
-- RLS: one policy, and it is a SELECT.
--
-- Own-row only, compared straight against auth.uid() with no lookup hop — the
-- same shape 0002 uses for device_push_tokens, and possible for the same reason:
-- user_id here IS auth.users.id (0001).
--
-- No INSERT policy, no UPDATE policy, no DELETE policy. PostgreSQL denies any
-- command a table has no permissive policy for, so their absence is the refusal.
-- Marking a row read goes through the definer RPC below, which is what lets it
-- move read_at forward without also letting a student rewrite the title of a
-- notification, invent one, or delete the evidence that their cap was spent.
--
-- Group membership is deliberately NOT re-checked. The row was addressed to this
-- student at delivery time; a student who has since left the group should still
-- see "you were removed from BIO 201" in their inbox, and a membership join would
-- delete exactly that notification at the moment it became relevant.
-- ---------------------------------------------------------------------------
alter table public.notifications enable row level security;

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own
  on public.notifications
  for select
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Grants: the two-line ritual 0015 wrote down for exactly this case.
--
-- The `grant select` alone would be a no-op that READS like a restriction. 0008
-- ended with `alter default privileges … grant select, insert, update, delete on
-- tables to authenticated`, so this table was born with full DML for
-- authenticated and only the missing policies were stopping a write. Revoking
-- makes the refusal closed rather than dependent on nobody ever adding a policy.
--
--   select grantee, privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'notifications';
--
-- Expect exactly SELECT for authenticated after this runs.
-- ---------------------------------------------------------------------------
grant select on public.notifications to authenticated, service_role;
revoke insert, update, delete, truncate on public.notifications from authenticated;
revoke all on public.notifications from anon;

-- ---------------------------------------------------------------------------
-- mark_notification_read — the caller's own row, once.
--
-- `read_at = coalesce(read_at, now())` rather than `= now()`, so a second tap on a
-- slow connection does not move the timestamp. That matters more than it looks:
-- read_at is the inbox's own cursor, and a value that drifts forward on a re-tap
-- would reorder a list the student is looking at.
--
-- Silent when the row is not theirs or does not exist. This is the one place in
-- the project where a missing row raises nothing, and it is on purpose — the
-- alternative leaks existence. `where user_id = auth.uid()` returning zero rows
-- is indistinguishable from a bad id, and a sentence saying which would let a
-- student probe for other people's notification ids. The student's own inbox is
-- the only place ids come from, so a legitimate call cannot miss.
--
-- No ledger entry and no client_action_id: idempotent by construction, so a key
-- would be dead weight. And the client does not queue this offline for the reason
-- mark_group_read does not — a dismissal replayed twenty minutes later is worse
-- than one that was lost.
-- ---------------------------------------------------------------------------
create or replace function public.mark_notification_read(p_notification_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_at  timestamptz;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;

  update public.notifications
     set read_at = coalesce(read_at, now())
   where notification_id = p_notification_id
     and user_id = v_uid
  returning read_at into v_at;

  return v_at;
end;
$$;

comment on function public.mark_notification_read is
  'Mark one of the caller''s own notifications read. Idempotent; returns null rather than raising when the id is not theirs.';

-- ---------------------------------------------------------------------------
-- mark_all_notifications_read — the "clear all" the inbox needs.
--
-- Exists as its own RPC rather than a loop in the client because dismissing
-- twenty notifications is one intention, and twenty round trips over hostel wifi
-- turns it into a partially-cleared inbox whenever one of them fails.
--
-- `read_at is null` in the predicate keeps it idempotent AND keeps the row count
-- honest: the return value is how many were actually unread, so a second call
-- returns 0 rather than re-stamping everything.
-- ---------------------------------------------------------------------------
create or replace function public.mark_all_notifications_read()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_n   integer;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;

  with cleared as (
    update public.notifications
       set read_at = now()
     where user_id = v_uid
       and read_at is null
    returning 1
  )
  select count(*) into v_n from cleared;

  return v_n;
end;
$$;

comment on function public.mark_all_notifications_read is
  'Mark every unread notification of the caller''s read. Returns how many were unread; a second call returns 0.';

-- ---------------------------------------------------------------------------
-- Function grants. Student-facing, so authenticated only — explicitly revoked
-- from public and anon, same treatment as every RPC since 0005.
--
-- There is deliberately NO read RPC here. Every other list in this app needs one
-- because it has to join in another student's name, which own-row RLS on `users`
-- forbids (see 0010) — but a notification stores its own title and body as sent,
-- so the SELECT policy above is the whole read path and the client queries the
-- table directly. One less definer function is one less thing to audit.
-- ---------------------------------------------------------------------------
revoke all on function public.mark_notification_read(uuid)    from public, anon;
revoke all on function public.mark_all_notifications_read()   from public, anon;

grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated;
