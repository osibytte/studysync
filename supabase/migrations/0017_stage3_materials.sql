-- ============================================================================
-- 0017_stage3_materials.sql  —  the files half of the 2026-09-05 scope change.
--
-- Sharing a file is the third kind of timeline item: `kind = 'file'` on a
-- message, pointing at a `materials` row. Same shape as sessions in 0016 — the
-- message is the anchor in the conversation, the domain row owns the state.
--
-- WHERE THE BYTES LIVE. Supabase Storage, in one PRIVATE bucket, not in a bytea
-- column. Postgres would work and is tempting for a project this size, but a
-- 25 MB past paper read out through PostgREST is a 25 MB row in a JSON response,
-- there is no range request, no resumable upload and no CDN. The bucket is
-- private: every download is a signed URL minted after the policies below have
-- agreed, so a leaked path is not a leaked file.
--
-- THE PATH IS THE PERMISSION. Objects are keyed
--
--   <group_id>/<material_id>/<file_name>
--
-- so the INSERT policy can decide "is this person in that group" from the key
-- alone, before any row exists to consult. Reads work the other way round: the
-- materials ROW is the authority, and the read policy asks whether the caller
-- can see a live material row with this exact path. That means a soft-deleted
-- material stops being downloadable the instant the RPC runs, whether or not the
-- object itself has been purged yet — the file's text disappearing is not left
-- depending on a second network call succeeding.
--
-- UPLOAD FIRST, RECORD SECOND. The client puts the object in the bucket and then
-- calls attach_material. Ordered that way because the failure modes are not
-- symmetrical: an object with no row is invisible, unlisted and unreadable
-- (dead weight, sweepable later), whereas a row with no object is a file card in
-- the timeline that downloads a 404. One is litter, the other is a bug students
-- can see. attach_material re-checks that the path it is handed really is inside
-- <group>/<material>/, so a member cannot register a row pointing at another
-- group's object and read it through their own group's policy.
--
-- Forward-only: one new table, one new column, one widened check, one bucket.
-- ============================================================================

create table if not exists public.materials (
  -- Client-generated, like message_id and session_id: the id is chosen before
  -- the upload starts, because it is part of the object's key.
  material_id  uuid primary key,
  group_id     uuid not null references public.groups(group_id) on delete cascade,
  uploaded_by  uuid not null references public.users(user_id)  on delete cascade,

  -- Stored, not derived. Deriving it from (group_id, material_id, file_name)
  -- would freeze today's key layout forever: change the scheme and every old
  -- row silently points somewhere that does not exist. Unique so two rows can
  -- never claim one object.
  storage_path text not null unique,
  -- What the student called it, shown in the timeline and used for the download
  -- filename. Never used to build the path's first two segments.
  file_name    text not null check (length(btrim(file_name)) between 1 and 255),
  mime_type    text not null check (length(btrim(mime_type)) between 1 and 128),
  -- Matches the bucket's file_size_limit below. Both exist: the bucket refuses
  -- the bytes, this refuses a row that lies about them.
  size_bytes   bigint not null check (size_bytes between 1 and 26214400),

  created_at   timestamptz not null default now(),
  -- Soft delete, so the timeline keeps its shape and the card can read
  -- "file removed" in place. See the read policy for why this is enough.
  deleted_at   timestamptz,
  deleted_by   uuid references public.users(user_id) on delete set null
);

comment on table public.materials is
  'A file shared in a group chat. Bytes live in the private group-materials bucket at <group_id>/<material_id>/<file_name>; this row is what grants read access to them.';

-- The files tab: newest first within a group.
create index if not exists materials_group_time_idx
  on public.materials (group_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 'file' becomes the third legal timeline kind.
--
-- 0016 deliberately left it out because a kind whose referent does not exist can
-- only render a broken bubble. The referent exists now, so the check widens.
-- Written as one constraint with three branches rather than three constraints,
-- so "exactly one referent, matching the kind" is stated in one place.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column if not exists material_id uuid
    references public.materials(material_id) on delete cascade;

alter table public.messages
  drop constraint if exists messages_kind_shape;

alter table public.messages
  add constraint messages_kind_shape check (
       (kind = 'text'    and session_id is null     and material_id is null)
    or (kind = 'session' and session_id is not null and material_id is null)
    or (kind = 'file'    and session_id is null     and material_id is not null)
  );

create index if not exists messages_material_idx
  on public.messages (material_id) where material_id is not null;

-- ---------------------------------------------------------------------------
-- The bucket.
--
-- `public = false` is the whole security posture: no object in here has a URL
-- that works without a signature, so the policies below are the only way in.
--
-- allowed_mime_types is a UX guard, not a control — Storage checks the
-- content-type the CLIENT declares, which anything can lie about. It is here so
-- a student who picks the wrong file gets told at the picker instead of after a
-- 20 MB upload. The reason an executable in this bucket would still be harmless
-- is that nothing ever runs it and nothing serves it to a browser unsigned.
--
-- Idempotent, and deliberately not an upsert: if this bucket already exists with
-- different settings, someone changed them on purpose in the Dashboard and a
-- migration should not silently undo that.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'group-materials', 'group-materials', false, 26214400,
  array[
    'application/pdf',
    'image/png', 'image/jpeg', 'image/webp', 'image/heic',
    'text/plain', 'text/csv', 'text/markdown',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip'
  ]
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- ACCESS, part 1: the materials rows.
--
-- A real SELECT policy, like messages (0014) and study_sessions (0016), for the
-- same two reasons: the table is published to Realtime so a file appears in an
-- open chat without a refetch, and the storage policies below read this table as
-- the CALLER, so this policy is what stops them from ever seeing a path that
-- belongs to somebody else's group.
--
-- Deleted rows stay visible on purpose — the timeline needs to know a file was
-- removed in order to say so. What deletion takes away is the download, which is
-- the read policy's job in part 2, not this one's.
--
-- Ordered before the publication for the reason 0014 spelled out: a published
-- table whose RLS is not yet in place is a table Realtime would broadcast to
-- anyone.
-- ---------------------------------------------------------------------------
alter table public.materials enable row level security;

create policy materials_select_members on public.materials
  for select to authenticated
  using (public.is_group_member(group_id, auth.uid()));

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'materials'
  ) then
    alter publication supabase_realtime add table public.materials;
  end if;
end $$;

grant select on public.materials to authenticated;
revoke insert, update, delete, truncate on public.materials from authenticated;
revoke all on public.materials from anon;
grant select, insert, update, delete on public.materials to service_role;

-- ---------------------------------------------------------------------------
-- ACCESS, part 2: the objects.
--
-- Checked live before writing this: storage.objects already has RLS enabled and
-- had ZERO policies, so the bucket starts closed to every client key and these
-- three statements are the entire client-facing surface of Storage in this
-- project. There is deliberately no UPDATE policy — a corrected file is a new
-- upload, so an object is never rewritten under a path someone already has a
-- signed URL for.
--
-- The uuid cast in the INSERT check sits inside a CASE rather than after an AND
-- because AND does not promise left-to-right evaluation: a client uploading to
-- `notes/x.pdf` would otherwise get 22P02 out of a security policy instead of a
-- plain refusal.
-- ---------------------------------------------------------------------------
drop policy if exists group_materials_insert on storage.objects;
create policy group_materials_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'group-materials'
    and case
          when (storage.foldername(name))[1] ~*
               '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then public.is_group_member(((storage.foldername(name))[1])::uuid, auth.uid())
          else false
        end
  );

-- Reads are row-led, not path-led: you may download an object exactly when you
-- can see a live materials row that claims it. Soft-deleting the row therefore
-- revokes the download immediately, with no second call to Storage required.
--
-- The is_group_member call is redundant today — materials' own SELECT policy
-- already narrows this subquery to the caller's groups — and it is here anyway,
-- for the reason 0015 was written: a guarantee that depends on another table's
-- policy staying narrow is one edit away from being untrue.
drop policy if exists group_materials_read on storage.objects;
create policy group_materials_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'group-materials'
    and exists (
      select 1 from public.materials m
      where m.storage_path = name
        and m.deleted_at is null
        and public.is_group_member(m.group_id, auth.uid())
    )
  );

-- Purging the bytes: whoever uploaded it, or the group's creator (the same rule
-- cancel_session uses in 0016). No `deleted_at is null` here on purpose — the
-- point of this policy is to clean up after a soft delete, so it has to keep
-- working once the row is marked deleted.
drop policy if exists group_materials_delete on storage.objects;
create policy group_materials_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'group-materials'
    and exists (
      select 1 from public.materials m
      where m.storage_path = name
        and (m.uploaded_by = auth.uid()
             or public.is_group_creator(m.group_id, auth.uid()))
    )
  );

-- ---------------------------------------------------------------------------
-- attach_material — called after the upload has landed, one transaction for the
-- material row and its timeline message.
--
-- The path check is the security-relevant line. Without it a member could upload
-- nothing at all and simply register a row whose storage_path points into
-- another group's folder; the read policy would then hand their group a file
-- they were never shown. Requiring the path to begin with
-- <this group>/<this material>/ makes that impossible to express.
-- ---------------------------------------------------------------------------
create or replace function public.attach_material(
  p_client_action_id uuid,
  p_material_id      uuid,
  p_message_id       uuid,
  p_group_id         uuid,
  p_storage_path     text,
  p_file_name        text,
  p_mime_type        text,
  p_size_bytes       bigint,
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
  v_name   text := btrim(coalesce(p_file_name, ''));
  v_mime   text := btrim(coalesce(p_mime_type, ''));
  v_prefix text := p_group_id::text || '/' || p_material_id::text || '/';
  v_body   text;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not public.claim_client_action(p_client_action_id, v_uid, 'material.attach') then
    return p_material_id; -- replay: the file is already on the timeline
  end if;

  select status into v_status from public.groups where group_id = p_group_id;
  if not found then raise exception 'That group no longer exists.'; end if;
  if v_status in ('archived', 'disbanded') then
    raise exception 'This group is closed, so you cannot share files in it.';
  end if;
  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are not a member of this group.';
  end if;

  if length(v_name) = 0 or length(v_name) > 255 then
    raise exception 'That file needs a name, under 255 characters.';
  end if;
  if length(v_mime) = 0 then
    raise exception 'That file has no type, so it cannot be shared.';
  end if;
  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 26214400 then
    raise exception 'Files have to be between 1 byte and 25 MB.';
  end if;
  if p_storage_path is null
     or left(p_storage_path, length(v_prefix)) <> v_prefix
     or length(p_storage_path) <= length(v_prefix) then
    raise exception 'That upload is not where it claims to be.';
  end if;

  insert into public.materials
    (material_id, group_id, uploaded_by, storage_path, file_name, mime_type, size_bytes)
  values
    (p_material_id, p_group_id, v_uid, p_storage_path, v_name, v_mime, p_size_bytes);

  -- Same rule as a session proposal: the body has to read as a sentence on its
  -- own, because it is what an older build and every push notification shows.
  v_body := coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Shared ' || v_name);

  insert into public.messages
    (message_id, group_id, sender_id, body, kind, material_id)
  values
    (p_message_id, p_group_id, v_uid, v_body, 'file', p_material_id);

  perform public.touch_group_activity(p_group_id);
  return p_material_id;
end;
$$;

comment on function public.attach_material is
  'Record an uploaded file and post it to the group timeline. Verifies the object path really belongs to this group and material.';

-- ---------------------------------------------------------------------------
-- delete_material — soft delete, uploader or group creator.
--
-- Only the row is touched. The object is the client's to remove next, under the
-- delete policy above, and it does not matter much if that call never happens:
-- once deleted_at is set, the read policy will not sign a URL for it again. That
-- is the same bargain as a deleted message, arrived at differently — a message
-- has to blank its own body because RLS grants rows and not columns, whereas a
-- file's bytes are behind a second door this row is the key to.
--
-- The message stays, with its body, and turns into a "file removed" card. The
-- body is the sentence somebody typed, not the file, so there is nothing to
-- blank.
-- ---------------------------------------------------------------------------
create or replace function public.delete_material(
  p_client_action_id uuid,
  p_material_id      uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_group    uuid;
  v_owner    uuid;
  v_deleted  timestamptz;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;

  select group_id, uploaded_by, deleted_at into v_group, v_owner, v_deleted
  from public.materials where material_id = p_material_id;
  if not found then raise exception 'That file no longer exists.'; end if;

  if not public.claim_client_action(p_client_action_id, v_uid, 'material.delete') then
    return; -- replay
  end if;

  if v_owner <> v_uid and not public.is_group_creator(v_group, v_uid) then
    raise exception 'Only whoever shared this file, or the group''s creator, can remove it.';
  end if;
  if v_deleted is not null then return; end if;

  update public.materials
     set deleted_at = now(), deleted_by = v_uid
   where material_id = p_material_id;
end;
$$;

comment on function public.delete_material is
  'Soft-delete a shared file, which revokes downloads at once. Uploader or group creator; idempotent.';

-- ---------------------------------------------------------------------------
-- group_materials — the files tab.
--
-- Definer and membership-gated like every other Stage 2/3 read, and it returns
-- storage_path because the client needs it to ask Storage for a signed URL. That
-- is not a leak: the path is only useful to somebody the read policy already
-- agrees with, and this function only hands it to members in the first place.
--
-- Deleted files are included by default, with deleted_at set, because the files
-- tab has to be able to say "removed by Ada" rather than quietly losing a row
-- somebody is looking for. Pass p_include_deleted false for a clean list.
-- ---------------------------------------------------------------------------
create or replace function public.group_materials(
  p_group_id        uuid,
  p_include_deleted boolean default true
)
returns table (
  material_id   uuid,
  message_id    uuid,
  storage_path  text,
  file_name     text,
  mime_type     text,
  size_bytes    bigint,
  uploaded_by   uuid,
  uploader_name text,
  created_at    timestamptz,
  deleted_at    timestamptz,
  deleted_by    uuid
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
  select mt.material_id, msg.message_id, mt.storage_path, mt.file_name,
         mt.mime_type, mt.size_bytes, mt.uploaded_by, u.full_name,
         mt.created_at, mt.deleted_at, mt.deleted_by
  from public.materials mt
  join public.users u on u.user_id = mt.uploaded_by
  left join public.messages msg on msg.material_id = mt.material_id
  where mt.group_id = p_group_id
    and (p_include_deleted or mt.deleted_at is null)
  order by mt.created_at desc;
end;
$$;

comment on function public.group_materials is
  'Files shared in a group the caller belongs to, including the storage path needed to sign a download URL.';

-- ---------------------------------------------------------------------------
-- Function grants — student-facing, so authenticated only, and explicitly not
-- public or anon so an unauthenticated key cannot probe a group's files.
-- ---------------------------------------------------------------------------
revoke all on function public.attach_material(uuid, uuid, uuid, uuid, text, text, text, bigint, text) from public, anon;
revoke all on function public.delete_material(uuid, uuid)          from public, anon;
revoke all on function public.group_materials(uuid, boolean)       from public, anon;

grant execute on function public.attach_material(uuid, uuid, uuid, uuid, text, text, text, bigint, text) to authenticated;
grant execute on function public.delete_material(uuid, uuid)       to authenticated;
grant execute on function public.group_materials(uuid, boolean)    to authenticated;

