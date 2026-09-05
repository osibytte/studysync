-- ============================================================================
-- 0016_stage3_timeline_sessions.sql
--
-- The chat becomes the group's workspace, not just its message log.
--
-- SCOPE CHANGE, 2026-09-05, on the user's instruction: a group's chat is where
-- study times get proposed, agreed and managed, and where files get shared. The
-- old roadmap had those as a separate "Sessions" stage after Materials and as
-- Stage 4; both now belong to the same timeline the messages live in, because
-- that is where the conversation that produces them happens. "Can we do Tuesday
-- evening?" and the thing that actually books Tuesday evening should not live in
-- two different screens.
--
-- The structural consequence is that a message becomes a TYPED TIMELINE ITEM.
-- `messages.kind` says what it is and a nullable foreign key points at the
-- domain row:
--
--   kind = 'text'     -> just words
--   kind = 'session'  -> session_id, a proposed study time with its own state
--   kind = 'file'     -> material_id, added in 0017
--
-- The alternative was a jsonb payload on the message. Rejected: a session has
-- mutable state that other features have to read and query — who said yes, has
-- it been cancelled, when is the next one — and Stage 5 has to find sessions
-- starting soon in order to remind anyone about them. State that other features
-- query does not belong inside a chat row's blob. The message stays the timeline
-- anchor (ordering, unread cursor, Realtime delivery); the session is its own
-- table with its own lifecycle.
--
-- `body` stays required for every kind, carrying the human sentence ("Library,
-- Tuesday 4pm?"). A build that does not understand a future kind still renders
-- something a student can read, rather than an empty bubble.
--
-- THE AGREEMENT RULE is 0012's meet rule, deliberately reused rather than
-- invented: a proposal is confirmed when the number of yeses reaches
--
--   members <= 3  ->  every member
--   members >= 4  ->  ceil(members / 2)
--
-- The same reasoning applies as it did for "when you can all meet": with three
-- people or fewer, "we agreed" should mean all of us, because it can; from four
-- up, unanimity means nothing ever gets booked. Reusing the rule also means one
-- explanation covers both screens.
--
-- Once confirmed, a session does NOT fall back to proposed if somebody later
-- changes their yes to a no. People plan around a confirmed meeting; quietly
-- un-booking it is worse than showing that one member dropped out. Cancelling
-- is explicit and someone owns it.
--
-- Forward-only: two new tables, two new columns, no data migrated.
-- ============================================================================

create table if not exists public.study_sessions (
  -- Client-generated, for the same reason as messages.message_id (0013): the
  -- optimistic card and the row Postgres writes are one object.
  session_id   uuid primary key,
  group_id     uuid not null references public.groups(group_id) on delete cascade,
  proposed_by  uuid not null references public.users(user_id)  on delete cascade,

  starts_at    timestamptz not null,
  -- A length rather than an ends_at: the UI asks for a start and a duration, and
  -- a duration cannot be accidentally earlier than its start. 15 minutes to 8
  -- hours covers a quick revision block and a full study day.
  duration_min int not null default 120 check (duration_min between 15 and 480),
  -- Free text on purpose — "New Lecture Theatre", "Ada's room", a meeting link.
  -- Campus room lists are not something this app should pretend to own.
  location     text check (location is null or length(btrim(location)) between 1 and 200),

  status       text not null default 'proposed'
                 check (status in ('proposed', 'confirmed', 'cancelled')),
  created_at   timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references public.users(user_id) on delete set null
);

comment on table public.study_sessions is
  'A study time proposed inside a group chat. Confirmed automatically once enough members say yes (0012''s meet rule); cancelled only explicitly.';

-- "The next session for this group", and Stage 5's "sessions starting soon".
create index if not exists study_sessions_group_time_idx
  on public.study_sessions (group_id, starts_at);

-- ---------------------------------------------------------------------------
-- Who is coming.
--
-- Composite primary key, so a member has exactly one answer per session and
-- changing your mind is an upsert rather than a second row. 'maybe' exists
-- because it is the honest answer students actually give, and counting it as a
-- silent no would misreport agreement.
-- ---------------------------------------------------------------------------
create table if not exists public.session_responses (
  session_id   uuid not null references public.study_sessions(session_id) on delete cascade,
  user_id      uuid not null references public.users(user_id)             on delete cascade,
  response     text not null check (response in ('yes', 'no', 'maybe')),
  responded_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

comment on table public.session_responses is
  'One RSVP per member per session. Only ''yes'' counts towards confirmation.';

-- ---------------------------------------------------------------------------
-- messages becomes a typed timeline.
--
-- `kind` defaults to 'text', so every row written before this migration — and
-- every plain message written after it — is correct without a backfill.
--
-- 'file' is NOT yet a legal kind: materials arrive in 0017, and a kind whose
-- referent does not exist is a kind that can only produce a broken bubble. 0017
-- widens the constraint when it has somewhere to point.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column if not exists kind text not null default 'text',
  add column if not exists session_id uuid
    references public.study_sessions(session_id) on delete cascade;

alter table public.messages
  drop constraint if exists messages_kind_shape;

alter table public.messages
  add constraint messages_kind_shape check (
    (kind = 'text'    and session_id is null)
    or (kind = 'session' and session_id is not null)
  );

comment on column public.messages.kind is
  'What this timeline item is: text | session (see 0017 for file). Drives which nullable reference is populated.';

-- One index per timeline kind that has a referent, so "the message for this
-- session" is a lookup rather than a scan of the group's history.
create index if not exists messages_session_idx
  on public.messages (session_id) where session_id is not null;

-- ---------------------------------------------------------------------------
-- session_agreement — the numbers behind "3 of 5 coming, confirmed".
--
-- Counts the GROUP ROSTER, not the members enrolled in the group's course, and
-- that is a deliberate difference from group_common_availability (0012). The
-- meet rule reads availability, which only exists on an enrolment row, so a
-- member who dropped the course has no opinion to count. An RSVP is attached to
-- the member, not the enrolment — somebody who dropped the course is still in
-- the group and can still turn up to the session.
--
-- Returned as numbers rather than a verdict so the client can say which rule is
-- in force ("all 3 of you", "3 of 5") instead of hard-coding one branch — the
-- same reason 0012 widened its return type.
-- ---------------------------------------------------------------------------
create or replace function public.session_agreement(p_session_id uuid)
returns table (
  members_counted   int,
  yes_count         int,
  no_count          int,
  maybe_count       int,
  confirm_threshold int,
  threshold_met     boolean
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  with s as (
    select group_id from public.study_sessions where session_id = p_session_id
  ),
  m as (
    select count(*)::int as n
    from public.group_members gm
    join s on gm.group_id = s.group_id
  ),
  r as (
    select (count(*) filter (where response = 'yes'))::int   as y,
           (count(*) filter (where response = 'no'))::int    as no_n,
           (count(*) filter (where response = 'maybe'))::int as mb
    from public.session_responses where session_id = p_session_id
  ),
  t as (
    select m.n,
           case when m.n <= 3 then m.n else ceil(m.n::numeric / 2)::int end as thr
    from m
  )
  select t.n, r.y, r.no_n, r.mb, t.thr, (t.n > 0 and r.y >= t.thr)
  from t, r;
$$;

comment on function public.session_agreement is
  'RSVP tally and confirmation threshold for one session. Threshold is 0012''s meet rule: everyone below four members, majority at four or more.';

-- ---------------------------------------------------------------------------
-- Confirmation happens here rather than in the respond RPC, so it is true of
-- every path that ever writes an RSVP — including a future admin fix-up or a
-- Stage 5 "reply yes from the notification" that does not go through the app.
--
-- Only ever forwards: proposed -> confirmed. A confirmed session that loses a
-- yes stays confirmed (see the header). Cancelling is the only way back, and it
-- has a name attached to it.
-- ---------------------------------------------------------------------------
create or replace function public.handle_session_response()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_met boolean;
begin
  select threshold_met into v_met from public.session_agreement(new.session_id);
  if v_met then
    update public.study_sessions
       set status = 'confirmed'
     where session_id = new.session_id
       and status = 'proposed';
  end if;
  return new;
end;
$$;

drop trigger if exists session_response_confirms on public.session_responses;
create trigger session_response_confirms
  after insert or update on public.session_responses
  for each row execute function public.handle_session_response();

-- ---------------------------------------------------------------------------
-- propose_session — one transaction produces the session, its timeline message
-- and the proposer's own yes.
--
-- All three or none. A session with no message is invisible; a message with no
-- session is a broken bubble; and a proposal whose proposer has not said they
-- are coming reads as an invitation from nobody. The proposer's yes also means a
-- solo group's session is confirmed the moment it is made, which is right — one
-- person agreeing with themselves is the whole roster.
--
-- Both ids come from the device, so a replay returns the session id it was
-- given rather than null.
-- ---------------------------------------------------------------------------
create or replace function public.propose_session(
  p_client_action_id uuid,
  p_session_id       uuid,
  p_message_id       uuid,
  p_group_id         uuid,
  p_starts_at        timestamptz,
  p_duration_min     int  default 120,
  p_location         text default null,
  p_note             text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_status text;
  v_body   text;
  v_loc    text := nullif(btrim(coalesce(p_location, '')), '');
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not public.claim_client_action(p_client_action_id, v_uid, 'session.propose') then
    return p_session_id; -- replay
  end if;

  select status into v_status from public.groups where group_id = p_group_id;
  if not found then raise exception 'That group no longer exists.'; end if;
  if v_status in ('archived', 'disbanded') then
    raise exception 'This group is closed, so you cannot plan sessions in it.';
  end if;
  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are not a member of this group.';
  end if;

  if p_starts_at is null or p_starts_at <= now() then
    raise exception 'Pick a start time in the future.';
  end if;
  if p_duration_min is null or p_duration_min < 15 or p_duration_min > 480 then
    raise exception 'A session has to be between 15 minutes and 8 hours long.';
  end if;
  if v_loc is not null and length(v_loc) > 200 then
    raise exception 'That location is too long. Keep it under 200 characters.';
  end if;

  -- The message body is what a build that does not understand session cards
  -- would show, so it must read as a sentence on its own.
  v_body := coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Proposed a study session');

  insert into public.study_sessions
    (session_id, group_id, proposed_by, starts_at, duration_min, location)
  values
    (p_session_id, p_group_id, v_uid, p_starts_at, p_duration_min, v_loc);

  insert into public.messages (message_id, group_id, sender_id, body, kind, session_id)
  values (p_message_id, p_group_id, v_uid, v_body, 'session', p_session_id);

  -- Fires the confirmation trigger.
  insert into public.session_responses (session_id, user_id, response)
  values (p_session_id, v_uid, 'yes');

  perform public.touch_group_activity(p_group_id);
  return p_session_id;
end;
$$;

comment on function public.propose_session is
  'Propose a study time inside a group chat: creates the session, its timeline message and the proposer''s yes in one transaction.';

-- ---------------------------------------------------------------------------
-- respond_to_session — yes / no / maybe, changeable until the session starts.
--
-- Online-only on the client, for the same reason respond_invitation is: a yes
-- that arrives after the session has started is not a late yes, it is a wrong
-- one. The ledger claim is still here so a lost response cannot double-write,
-- and so every write RPC in this schema has the same shape.
--
-- Returns the session's status after the write, so the caller learns that its
-- own yes was the one that confirmed the session without a second read.
-- ---------------------------------------------------------------------------
create or replace function public.respond_to_session(
  p_client_action_id uuid,
  p_session_id       uuid,
  p_response         text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_group    uuid;
  v_status   text;
  v_starts   timestamptz;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;

  select group_id, status, starts_at into v_group, v_status, v_starts
  from public.study_sessions where session_id = p_session_id;
  if not found then raise exception 'That session no longer exists.'; end if;

  if not public.claim_client_action(p_client_action_id, v_uid, 'session.respond') then
    return v_status; -- replay
  end if;

  if not public.is_group_member(v_group, v_uid) then
    raise exception 'You are not a member of this group.';
  end if;
  if v_status = 'cancelled' then
    raise exception 'That session was cancelled.';
  end if;
  if v_starts <= now() then
    raise exception 'That session has already started.';
  end if;
  if p_response is null or p_response not in ('yes', 'no', 'maybe') then
    raise exception 'Answer yes, no, or maybe.';
  end if;

  insert into public.session_responses (session_id, user_id, response)
  values (p_session_id, v_uid, p_response)
  on conflict (session_id, user_id)
    do update set response = excluded.response, responded_at = now();

  select status into v_status from public.study_sessions where session_id = p_session_id;
  return v_status;
end;
$$;

comment on function public.respond_to_session is
  'Set or change the caller''s RSVP for a session. Returns the session status afterwards, which the confirmation trigger may just have changed.';

-- ---------------------------------------------------------------------------
-- cancel_session — the proposer, or the group's creator.
--
-- The creator can cancel anyone's proposal because they can already rename the
-- group, remove members and archive it (0005); a session they cannot call off is
-- an odd hole in that. Nobody else can, so a member who dislikes a time says no
-- rather than deleting it for everybody.
--
-- Idempotent: cancelling a cancelled session is a no-op, not an error, so a
-- double tap on a slow connection does not produce a scary sentence.
--
-- No timeline message is posted for a cancellation. The session card is already
-- in the timeline and it changes to read as cancelled — announcing it a second
-- time in a bubble underneath says the same thing twice.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_session(
  p_client_action_id uuid,
  p_session_id       uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_group    uuid;
  v_status   text;
  v_proposer uuid;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;

  select group_id, status, proposed_by into v_group, v_status, v_proposer
  from public.study_sessions where session_id = p_session_id;
  if not found then raise exception 'That session no longer exists.'; end if;

  if not public.claim_client_action(p_client_action_id, v_uid, 'session.cancel') then
    return; -- replay
  end if;

  if v_proposer <> v_uid and not public.is_group_creator(v_group, v_uid) then
    raise exception 'Only whoever proposed this session, or the group''s creator, can cancel it.';
  end if;
  if v_status = 'cancelled' then return; end if;

  update public.study_sessions
     set status = 'cancelled', cancelled_at = now(), cancelled_by = v_uid
   where session_id = p_session_id;
end;
$$;

comment on function public.cancel_session is
  'Cancel a proposed or confirmed session. Proposer or group creator only; idempotent.';

-- ---------------------------------------------------------------------------
-- group_sessions — everything the session cards and the "next session" header
-- need, in one read. Membership-gated, names but never emails (0010's pattern).
--
-- Defaults to sessions that have not finished starting yet, plus a one-hour
-- grace so a session you are currently sitting in does not vanish off the
-- screen. Pass p_include_past to get the history.
-- ---------------------------------------------------------------------------
create or replace function public.group_sessions(
  p_group_id     uuid,
  p_include_past boolean default false
)
returns table (
  session_id        uuid,
  message_id        uuid,
  starts_at         timestamptz,
  duration_min      int,
  location          text,
  status            text,
  proposed_by       uuid,
  proposer_name     text,
  members_counted   int,
  yes_count         int,
  no_count          int,
  maybe_count       int,
  confirm_threshold int,
  my_response       text
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
  select s.session_id, msg.message_id, s.starts_at, s.duration_min, s.location,
         s.status, s.proposed_by, u.full_name,
         a.members_counted, a.yes_count, a.no_count, a.maybe_count,
         a.confirm_threshold, mine.response
  from public.study_sessions s
  join public.users u on u.user_id = s.proposed_by
  cross join lateral public.session_agreement(s.session_id) a
  left join public.messages msg on msg.session_id = s.session_id
  left join public.session_responses mine
         on mine.session_id = s.session_id and mine.user_id = v_uid
  where s.group_id = p_group_id
    and (p_include_past or s.starts_at > now() - interval '1 hour')
  order by s.starts_at asc;
end;
$$;

comment on function public.group_sessions is
  'Sessions for a group the caller belongs to, with the RSVP tally, the threshold in force and the caller''s own answer.';

-- ---------------------------------------------------------------------------
-- session_attendees — who is coming, for the detail sheet behind a card.
--
-- Driven from group_members and LEFT JOINed to the responses, so a member who
-- has not answered appears with response null rather than being missing. "Three
-- of five answered" is the interesting fact; a query that returned only the
-- three could not tell you that.
-- ---------------------------------------------------------------------------
create or replace function public.session_attendees(p_session_id uuid)
returns table (
  user_id      uuid,
  full_name    text,
  department   text,
  is_proposer  boolean,
  response     text,
  responded_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_group_id uuid;
  v_proposer uuid;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;

  select s.group_id, s.proposed_by into v_group_id, v_proposer
  from public.study_sessions s where s.session_id = p_session_id;

  if not found then raise exception 'That session no longer exists.'; end if;
  if not public.is_group_member(v_group_id, v_uid) then
    raise exception 'You are not a member of this group.';
  end if;

  return query
  select gm.user_id, u.full_name, u.department,
         (gm.user_id = v_proposer),
         r.response, r.responded_at
  from public.group_members gm
  join public.users u on u.user_id = gm.user_id
  left join public.session_responses r
         on r.session_id = p_session_id and r.user_id = gm.user_id
  where gm.group_id = v_group_id
  order by (gm.user_id = v_proposer) desc, u.full_name asc;
end;
$$;

comment on function public.session_attendees is
  'Every member of a session''s group with their answer, or null if they have not answered.';

-- ---------------------------------------------------------------------------
-- ACCESS.
--
-- study_sessions gets a real SELECT policy for the same reason messages did
-- (0014): it is published to Realtime below, and postgres_changes re-evaluates
-- this policy per subscriber to decide who sees a confirmation or a cancellation
-- land. A session row carries a time, a place and a status — group-visible facts
-- by definition, since agreeing on them is the point.
--
-- session_responses gets RLS with NO policy, which denies every command to
-- authenticated outright. Reads go through session_agreement's tallies and
-- session_attendees' roster join, both definer. Deliberately not published to
-- Realtime: an RSVP arriving changes the tally, and the tally is recomputed when
-- the study_sessions row it may have confirmed broadcasts. For a response that
-- does not cross the threshold the client refetches on focus — cheaper than a
-- second subscription and a second policy to keep honest.
-- ---------------------------------------------------------------------------
alter table public.study_sessions   enable row level security;
alter table public.session_responses enable row level security;

create policy study_sessions_select_members on public.study_sessions
  for select to authenticated
  using (public.is_group_member(group_id, auth.uid()));

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'study_sessions'
  ) then
    alter publication supabase_realtime add table public.study_sessions;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- GRANTS — the two-line ritual from 0015. The revokes are the operative half:
-- 0008's `alter default privileges` hands every new public table full DML to
-- authenticated, so the grants above them describe the intent and the revokes
-- below them are what makes it true.
-- ---------------------------------------------------------------------------
grant select on public.study_sessions to authenticated;
revoke insert, update, delete, truncate on public.study_sessions from authenticated;
revoke all on public.study_sessions from anon;

-- Nothing at all for authenticated here: RLS denies it anyway, and a table with
-- neither a policy nor a privilege cannot be reached by accident later.
revoke all on public.session_responses from authenticated, anon;

grant select, insert, update, delete on public.study_sessions   to service_role;
grant select, insert, update, delete on public.session_responses to service_role;

-- session_agreement is an INTERNAL helper and stays that way: it is definer and
-- takes a session id with no membership check, so granting it to authenticated
-- would let anyone read any group's RSVP tally. Its callers (the trigger and
-- group_sessions) are themselves definer and run as the owner, which is enough.
revoke all on function public.session_agreement(uuid) from public, anon, authenticated;

revoke all on function public.propose_session(uuid, uuid, uuid, uuid, timestamptz, int, text, text) from public, anon;
revoke all on function public.respond_to_session(uuid, uuid, text)  from public, anon;
revoke all on function public.cancel_session(uuid, uuid)            from public, anon;
revoke all on function public.group_sessions(uuid, boolean)         from public, anon;
revoke all on function public.session_attendees(uuid)               from public, anon;

grant execute on function public.propose_session(uuid, uuid, uuid, uuid, timestamptz, int, text, text) to authenticated;
grant execute on function public.respond_to_session(uuid, uuid, text)  to authenticated;
grant execute on function public.cancel_session(uuid, uuid)            to authenticated;
grant execute on function public.group_sessions(uuid, boolean)         to authenticated;
grant execute on function public.session_attendees(uuid)               to authenticated;
