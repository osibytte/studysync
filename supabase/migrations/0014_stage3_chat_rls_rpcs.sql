-- ============================================================================
-- 0014_stage3_chat_rls_rpcs.sql  —  Stage 3, part 2 of 2: access + writes.
--
-- Reads:  a real RLS SELECT policy, queried straight through PostgREST.
-- Writes: SECURITY DEFINER RPCs, as everywhere else in this schema.
--
-- WHY READS ARE A POLICY AND NOT A SECURITY DEFINER FUNCTION.
-- Every other privileged read in this project (group_members_detail,
-- group_common_availability, my_invitations, group_join_requests — all 0010) is
-- a definer function, because Stage 1's `users` policy is own-row-only and a
-- function was the narrow way to hand out other people's names. Chat breaks
-- that pattern deliberately: Supabase Realtime's `postgres_changes` decides who
-- may see a new row by re-evaluating THIS TABLE'S SELECT POLICY for each
-- subscriber. A definer function leaves it with no policy to consult, and the
-- live subscription then either delivers every group's messages to every socket
-- or delivers nothing at all. So the policy is the feature, not boilerplate.
--
-- The consequence is that `messages` rows are the one place a student reads
-- another student's row directly — which is fine, because a message body is
-- something its sender chose to show the group, unlike an email address or a
-- raw availability mask. Names still do not come from here: the payload carries
-- sender_id only, and the client resolves it against the roster it already
-- loaded from group_members_detail.
--
-- Not gated on enrolment (unlike the 0011 write paths): sending a message
-- neither creates a membership nor promises a seat, and a member who has
-- dropped the course should still be able to tell their group so.
-- ============================================================================

alter table public.messages enable row level security;

-- The whole of chat's read security, in three lines. is_group_member is 0005's
-- definer helper, so this policy does not itself need to see group_members.
create policy messages_select_members on public.messages
  for select to authenticated
  using (public.is_group_member(group_id, auth.uid()));

-- ---------------------------------------------------------------------------
-- Realtime.
--
-- Checked live on 2026-09-05, before this migration: the supabase_realtime
-- publication contained ZERO tables and puballtables was false. The Realtime
-- service being enabled in config.toml publishes nothing on its own — this
-- statement is what makes the chat screen live, and without it the feature
-- silently degrades to "messages appear when you pull to refresh".
--
-- Ordered after the policy above on purpose: a published table with RLS not yet
-- enabled is a table Realtime would happily broadcast to anyone.
--
-- REPLICA IDENTITY stays `default`. The primary key is enough for the INSERT
-- payloads the chat screen subscribes to, and for the UPDATE payload a soft
-- delete produces — the client only needs the new row, never the old one.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- send_message — the only way a student writes to this table.
--
-- p_message_id comes from the device (0013, note 1), so this returns it either
-- way: on a first application, and on a replay of the same client action. The
-- Stage 2 RPCs whose ids are server-generated return null on a replay because
-- they have nothing truthful to return; here the id the caller sent IS the
-- answer, and handing it back means the outbox never has to special-case which
-- attempt succeeded.
--
-- The claim, the insert and the activity bump share one transaction, which is
-- why the claim belongs in here rather than in outbox.ts — see SELF_LEDGERED.
--
-- Body validation is duplicated: this raise gives the friendly sentence, the
-- 0013 CHECK is the guarantee. The client validates a third time so the student
-- is refused before a round trip.
-- ---------------------------------------------------------------------------
create or replace function public.send_message(
  p_client_action_id uuid,
  p_message_id       uuid,
  p_group_id         uuid,
  p_body             text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_status text;
  v_body   text := btrim(coalesce(p_body, ''));
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not public.claim_client_action(p_client_action_id, v_uid, 'chat.send') then
    return p_message_id; -- replay: already sent, nothing to do
  end if;

  if length(v_body) = 0 then
    raise exception 'Type a message first.';
  end if;
  if length(v_body) > 2000 then
    raise exception 'That message is too long. Keep it under 2000 characters.';
  end if;

  select status into v_status from public.groups where group_id = p_group_id;
  if not found then raise exception 'That group no longer exists.'; end if;
  -- `dormant` is deliberately allowed: a message is exactly what should wake a
  -- quiet group up, and touch_group_activity below flips it back to active.
  if v_status in ('archived', 'disbanded') then
    raise exception 'This group is closed, so you cannot post in it.';
  end if;
  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are not a member of this group.';
  end if;

  insert into public.messages (message_id, group_id, sender_id, body)
  values (p_message_id, p_group_id, v_uid, v_body);

  -- First caller of this since 0006 defined it and left it waiting for Stage 3.
  perform public.touch_group_activity(p_group_id);

  return p_message_id;
end;
$$;

comment on function public.send_message is
  'Post a message to a group the caller belongs to. Ledger-backed: replaying one client action id returns the same message id without posting twice.';

-- ---------------------------------------------------------------------------
-- mark_group_read — move the caller's own read cursor to now.
--
-- greatest(last_read_at, now()) is the whole point. The cursor must never move
-- BACKWARDS: two devices on one account, or a stale value arriving late, would
-- otherwise resurrect messages the student has already read and re-badge the
-- group. This is also why the client does NOT queue this action offline — a
-- cursor replayed twenty minutes later is worse than no cursor — and the guard
-- here is the second line of defence for the case where it happens anyway.
--
-- No ledger entry: the operation is idempotent by construction, so an
-- idempotency key would be dead weight and one more row per screen visit.
-- ---------------------------------------------------------------------------
create or replace function public.mark_group_read(p_group_id uuid)
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

  update public.group_members
     set last_read_at = greatest(last_read_at, now())
   where group_id = p_group_id and user_id = v_uid
  returning last_read_at into v_at;

  if not found then raise exception 'You are not a member of this group.'; end if;
  return v_at;
end;
$$;

comment on function public.mark_group_read is
  'Move the caller''s read cursor for one group forward to now. Never moves it backwards.';

-- ---------------------------------------------------------------------------
-- delete_my_message — soft delete, sender only.
--
-- Blanks the body as well as stamping deleted_at, because RLS grants rows and
-- not columns: text left in `body` is delivered to every subscribing member no
-- matter what the client renders. The row survives so the transcript keeps its
-- shape and the page cursor stays stable — the client shows "message deleted"
-- in place.
--
-- Re-deleting is a no-op rather than an error, so a double tap on a slow
-- connection does not produce a scary sentence.
-- ---------------------------------------------------------------------------
create or replace function public.delete_my_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_sender  uuid;
  v_deleted timestamptz;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;

  select sender_id, deleted_at into v_sender, v_deleted
  from public.messages where message_id = p_message_id;

  if not found then raise exception 'That message no longer exists.'; end if;
  if v_sender <> v_uid then
    raise exception 'You can only delete your own messages.';
  end if;
  if v_deleted is not null then return; end if;

  update public.messages
     set body = '', deleted_at = now()
   where message_id = p_message_id;
end;
$$;

comment on function public.delete_my_message is
  'Soft-delete one of the caller''s own messages, blanking its text. Idempotent.';

-- ---------------------------------------------------------------------------
-- my_unread_counts — every badge in the app, in one round trip.
--
-- A read, so no ledger and no client action id. An RPC rather than a client-side
-- query for two reasons: counting per group from the device is one request per
-- group, and this must only ever see the caller's OWN memberships — the WHERE
-- clause below is the entire access rule, since a definer function has no RLS.
--
-- Own messages are excluded from the count. You have not "not read" something
-- you typed, and sending deliberately does not move the cursor (you can send
-- without having read what came before).
--
-- The preview is the newest message that has not been deleted, so deleting the
-- last thing you said reveals the one before it rather than blanking the list
-- row. last_body is a full body, not a truncation — the client decides how much
-- of it fits, and 2000 characters is cheaper to ship than a second round trip.
-- ---------------------------------------------------------------------------
create or replace function public.my_unread_counts()
returns table (
  group_id        uuid,
  unread_count    int,
  last_message_at timestamptz,
  last_sender_id  uuid,
  last_body       text
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select gm.group_id,
         (select count(*)::int
            from public.messages m
           where m.group_id   = gm.group_id
             and m.created_at > gm.last_read_at
             and m.sender_id <> gm.user_id
             and m.deleted_at is null),
         newest.created_at,
         newest.sender_id,
         newest.body
  from public.group_members gm
  left join lateral (
    select m.created_at, m.sender_id, m.body
      from public.messages m
     where m.group_id = gm.group_id
       and m.deleted_at is null
     order by m.created_at desc, m.message_id desc
     limit 1
  ) newest on true
  where gm.user_id = auth.uid();
$$;

comment on function public.my_unread_counts is
  'Per-group unread count and last-message preview for the caller''s own memberships. Own messages never count as unread.';

-- ---------------------------------------------------------------------------
-- Function grants. Student-facing, so authenticated only — explicitly revoked
-- from public and anon so an unauthenticated key cannot probe group membership
-- by calling them. Same treatment as every RPC since 0005.
-- ---------------------------------------------------------------------------
revoke all on function public.send_message(uuid, uuid, uuid, text) from public, anon;
revoke all on function public.mark_group_read(uuid)                from public, anon;
revoke all on function public.delete_my_message(uuid)              from public, anon;
revoke all on function public.my_unread_counts()                   from public, anon;

grant execute on function public.send_message(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.mark_group_read(uuid)                to authenticated;
grant execute on function public.delete_my_message(uuid)              to authenticated;
grant execute on function public.my_unread_counts()                   to authenticated;
