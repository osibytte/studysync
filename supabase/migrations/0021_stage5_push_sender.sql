-- ============================================================================
-- 0021_stage5_push_sender.sql  —  what the Expo Push sender needs and 0019 left out.
--
-- 0019 built the ledger on one question: "have we already told this student?"
-- The sender turns out to need two more that the same table is the only honest
-- place for, plus one fact about the student that has never been stored.
--
-- 1. DID THE PUSH ACTUALLY GO OUT?  (`pushed_at`)
--
--    0019's row means "we decided to tell this student". That is not the same as
--    "their phone rang", and the gap is not an edge case — it is the normal path.
--    A notification withheld by quiet hours still belongs in the inbox (the whole
--    argument for the inbox existing is that the lock screen is the unreliable
--    half), so the row is written either way, and something has to distinguish the
--    two states or three separate things break at once:
--
--      - the daily cap counts DELIVERIES. `isDailyCapReached` takes
--        `deliveredNonUrgentToday`, and counting rows we wrote but never sent
--        would let quiet hours eat the day's allowance.
--      - a run cannot be repeated safely. Without a per-row marker the second
--        invocation of a schedule tick re-pushes everything the first one pushed,
--        which is the exact failure 0019's unique index exists to prevent — and
--        `(user_id, dedupe_key)` cannot help here, because the row is already
--        there and it is the PUSH that would double.
--      - `group_matched` could never be pushed at all. Its row is written in SQL
--        by `create_system_group` (0020 §8), so the sender did not compose it and
--        has nothing in hand to push; it has to find it by reading the ledger for
--        "written and not yet sent", which is precisely this column.
--
-- 2. WHY NOT, WHEN NOT?  (`withheld`)
--
--    `pushed_at is null` alone cannot say whether a row is waiting or finished
--    with. Quiet hours are a DELAY — the sender is supposed to come back at 07:00,
--    which is the whole point of `minutesUntilQuietHoursEnd` — while a spent cap or
--    a switched-off kind is terminal for that row. Collapsing the two either loses
--    the 23:00 message forever or pushes yesterday's cap-withheld banner this
--    morning. So the reason is stored, the four values are exactly
--    `WithheldReason` in src/lib/notificationRules.ts, and a mirror test pins the
--    CHECK against that union the way 0019's does for `kind`.
--
-- 3. WHAT CLOCK IS THE STUDENT ON?  (`users.timezone`)
--
--    Quiet hours are read off the student's own clock — `isWithinQuietHours` calls
--    `at.getHours()` — and until now every caller WAS the student's device, so the
--    question never came up. A server-side sender cannot answer it: the schema has
--    never stored a timezone, and `isoWeekLabel`'s comment says as much where it
--    explains why a dedupe bucket is UTC.
--
--    Guessing is not available. An offset assumed from the target campus is wrong
--    for one student in a way nobody can see: their quiet hours silently shift, and
--    the only symptom is notifications at the wrong time of night. So the device
--    reports its own IANA zone (`Intl` exists in Deno and in Hermes' modern
--    builds for this one call — and where it does not, the column stays null).
--
--    Null means "not reported", and the sender treats it as the app's default
--    rather than as UTC. UTC would be a real wrong answer for the campus this is
--    built for; the default is a stated assumption in one place.
--
-- Forward-only: two nullable columns on notifications, one on users, two indexes.
-- No RLS change — `notifications` still has exactly one SELECT policy, and the new
-- columns are written only by the sender (service_role) which no policy governs.
-- `users.timezone` is covered by 0002's own-row update policy, which whitelists no
-- columns, so the client can write it through the update it already makes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- notifications.pushed_at — the moment Expo accepted it, not the moment we tried.
--
-- Set only after the Expo Push API returns an 'ok' ticket for at least one of the
-- student's device tokens. A ticket is not a delivery receipt — Expo hands the
-- message to APNs/FCM and the real verdict arrives later via a receipt — but it is
-- the last point the sender has any say in, and treating "handed off" as "sent" is
-- the only definition that keeps a retry from doubling. A student with no
-- registered token at all leaves this null forever, which is correct: their inbox
-- still has the row, and nothing was pushed.
-- ---------------------------------------------------------------------------
alter table public.notifications
  add column if not exists pushed_at timestamptz;

comment on column public.notifications.pushed_at is
  'When the Expo Push API accepted this row for at least one device. Null means never pushed — either still pending, withheld, or the student has no registered token. The daily cap counts rows where this is set.';

-- ---------------------------------------------------------------------------
-- notifications.withheld — the sender's own reason, never shown to a student.
--
-- The CHECK lists the four values of `WithheldReason`. It is not a lookup table
-- for the same reason `notifications.kind` is not one: four values that change
-- only when the decision function changes, and a mirror test is a cheaper guard
-- than a join on every insert.
--
-- 'quiet_hours' is the only retryable value, and that asymmetry is the reason this
-- column exists rather than a boolean. The other three need the student to change
-- a setting, so time alone will never make them deliverable.
-- ---------------------------------------------------------------------------
alter table public.notifications
  add column if not exists withheld text
  check (withheld is null or withheld in ('push_disabled', 'kind_disabled', 'quiet_hours', 'daily_cap'));

comment on column public.notifications.withheld is
  'Why the push did not go out, matching WithheldReason in src/lib/notificationRules.ts. Null means delivered or still pending. Only ''quiet_hours'' is retryable — the other three need the student to change a setting.';

-- ---------------------------------------------------------------------------
-- The sender's own queue: rows written and not yet sent.
--
-- Partial and deliberately narrow. This is the hottest query in the sender — it
-- runs first on every invocation, across every user — and the rows it wants are a
-- vanishing fraction of the table within a week of use. Ordered by created_at so
-- the oldest pending notification is pushed first: a student catching up after
-- quiet hours should get them in the order they happened.
--
-- No user_id in the index. The sender is not scoped to a student; it sweeps
-- everybody, and adding user_id first would make the planner walk one student at a
-- time for no benefit.
-- ---------------------------------------------------------------------------
create index if not exists notifications_unpushed_idx
  on public.notifications (created_at)
  where pushed_at is null;

-- ---------------------------------------------------------------------------
-- The cap count, corrected.
--
-- 0019's `notifications_unread_idx` answers the badge. This one answers the cap,
-- which is a different question: non-urgent rows ACTUALLY PUSHED to one student
-- since a moving 24-hour boundary. Partial on `not urgent` because urgent rows are
-- exempt by definition and including them would make the index answer a question
-- nobody asks.
-- ---------------------------------------------------------------------------
create index if not exists notifications_cap_idx
  on public.notifications (user_id, pushed_at desc)
  where pushed_at is not null and not urgent;

-- ---------------------------------------------------------------------------
-- users.timezone — the student's IANA zone, as their own device reports it.
--
-- Text rather than an interval or a numeric offset, because an offset is not a
-- timezone: 'Africa/Lagos' is a rule, +01:00 is a snapshot of that rule, and a
-- stored offset is wrong for half the year anywhere that observes DST. Nigeria
-- does not, but the app should not encode that assumption in a column type.
--
-- No CHECK against a list of zones. The set is maintained by the IANA database and
-- changes without asking us; a CHECK would turn a tzdata update into a failed
-- insert. The sender validates by using it — an unrecognised zone throws in
-- `Intl.DateTimeFormat`, which it catches and falls back from.
-- ---------------------------------------------------------------------------
alter table public.users
  add column if not exists timezone text;

comment on column public.users.timezone is
  'IANA timezone as reported by the student''s device (e.g. ''Africa/Lagos''). Null means never reported; the sender falls back to its own default rather than to UTC. Needed because quiet hours are a local-clock rule and the server has no other way to know the clock.';
