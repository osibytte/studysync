-- ============================================================================
-- 0013_stage3_chat_schema.sql  —  Stage 3, part 1 of 2: tables.
--
-- Group chat. One table, one column added to group_members, and nothing else:
-- the RLS policy, the write RPCs and the Realtime publication all land in 0014,
-- because Realtime enforces the SELECT policy per subscriber and publishing a
-- table before its policy exists would be publishing an open table.
--
-- Three decisions are baked into the DDL below and each one has a reason that
-- is not obvious from the column list:
--
--   1. message_id has NO default. The device generates the uuid when the
--      student taps Send, so the optimistic bubble on screen and the row
--      Postgres eventually writes are the same object. Nothing has to be
--      reconciled when the write lands, and the Realtime echo of your own
--      message collapses onto the bubble by id rather than by guessing at
--      (sender, body, timestamp). group.create already works this way.
--
--   2. The page index is (group_id, created_at desc, message_id desc), which
--      is exactly the keyset the client pages by. created_at alone is not
--      unique — two messages in the same millisecond make "older than this
--      one" ambiguous, and a message can then be dropped or repeated at a page
--      boundary. The primary key breaks the tie.
--
--   3. Unread state is one timestamp per membership, not a row per
--      (message, recipient). A six-member group would otherwise write five
--      rows for every message sent. Rows-per-recipient is the right shape for
--      a discrete event you either delivered or did not (an invitation, an
--      upload); chat is a firehose, and a firehose wants a cursor.
--
-- Forward-only: new table, new column, no data migrated, nothing dropped.
-- ============================================================================

create table if not exists public.messages (
  -- No default: the client supplies this. See note 1 above.
  message_id  uuid primary key,
  group_id    uuid not null references public.groups(group_id) on delete cascade,
  sender_id   uuid not null references public.users(user_id)  on delete cascade,
  body        text not null,
  created_at  timestamptz not null default now(),
  -- Soft delete. Set by delete_my_message (0014), which also blanks the body.
  deleted_at  timestamptz,

  -- A live message carries real text; a deleted one carries none.
  --
  -- This is why the body is blanked rather than kept: RLS grants rows, not
  -- columns, so anything still in `body` is delivered to every subscribing
  -- member whatever the client chooses to render. "Keep the body but hide it"
  -- is not a thing this table can honestly offer, so it does not pretend to —
  -- deleting a message really deletes its text.
  constraint messages_body_shape check (
    case when deleted_at is null
         then length(btrim(body)) between 1 and 2000
         else body = ''
    end
  )
);

comment on table public.messages is
  'Group chat messages. Writes go only through send_message / delete_my_message (0014); message_id is generated on the device so an optimistic bubble and its row share an identity.';

-- The keyset the chat screen pages by: newest first within a group, primary key
-- as the tiebreak. Also serves the unread count in my_unread_counts, which is a
-- range scan on (group_id, created_at) per membership.
create index if not exists messages_group_page_idx
  on public.messages (group_id, created_at desc, message_id desc);

-- ---------------------------------------------------------------------------
-- The read cursor.
--
-- `not null default now()` means every membership that already exists starts
-- caught up, which is correct: there are no messages yet, so nobody has unread
-- ones. A membership created later starts caught up as of the moment somebody
-- joined — a new member does not inherit a backlog of unread from before they
-- were in the group, which is what a nullable column defaulting to "beginning
-- of time" would have given them.
--
-- Only mark_group_read (0014) moves it, and only ever forwards.
-- ---------------------------------------------------------------------------
alter table public.group_members
  add column if not exists last_read_at timestamptz not null default now();

comment on column public.group_members.last_read_at is
  'How far this member has read in the group chat. Moved forward only, by mark_group_read.';

-- ---------------------------------------------------------------------------
-- GRANTS — see the 0008 header. This project's default privileges give new
-- public tables only REFERENCES/TRIGGER/TRUNCATE, so a table without explicit
-- grants is unreachable ("permission denied for table", 42501) even for
-- service_role, whose BYPASSRLS skips RLS but not the privilege check.
--
-- authenticated gets SELECT and nothing else. Every client write goes through a
-- SECURITY DEFINER RPC in 0014, so INSERT/UPDATE/DELETE are never granted to
-- students — that is the same shape as every Stage 2 table.
-- ---------------------------------------------------------------------------
grant select on public.messages to authenticated;
grant select, insert, update, delete on public.messages to service_role;
