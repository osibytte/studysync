-- ============================================================================
-- 0018_stage3_storage_readback.sql  —  one gap in 0017's Storage policies.
--
-- 0017 made reads row-led: an object is downloadable because a live materials
-- row claims it and the caller is in that row's group. That is still the rule.
-- What it missed is the moment BEFORE the row exists.
--
-- Measured on this database, as `authenticated`, inside a rolled-back
-- transaction (three inserts into the same group's folder by the same member):
--
--   insert … values ('group-materials', '<g>/<claimed mat>/f.pdf') returning id
--     -> 3019d8b6-…                        (a live materials row claims it)
--   insert … values ('group-materials', '<g>/<fresh uuid>/f.pdf')  returning id
--     -> 42501 new row violates row-level security policy for table "objects"
--   insert … values ('group-materials', '<g>/<fresh uuid>/g.pdf')  -- no RETURNING
--     -> ok, and the row is there
--
-- The WITH CHECK of group_materials_insert passes in all three cases. The
-- difference is RETURNING: PostgreSQL applies the SELECT policies to the row a
-- writing statement hands back, so an object nobody has claimed yet cannot be
-- returned to the very client that just uploaded it. The uploader could not see
-- their own object either (count = 0 immediately after inserting it).
--
-- That breaks the upload-first/record-second handshake the feature is built on:
-- the client uploads bytes, then calls attach_material with the path. If the
-- Storage API reads the object row back to answer with its id and path — and its
-- response shape says it does — every upload fails before attach_material is
-- ever reached, with an error about row-level security that has nothing to do
-- with the student.
--
-- So: while an object is unclaimed it belongs to whoever uploaded it. Once a
-- materials row claims it, the row decides and the uploader loses that standing.
-- One sentence, two policies:
--
--   read/delete an object  <=>  a live row claims it and you are in its group
--                          OR   nothing claims it and you uploaded it
--
-- The revocation guarantee survives intact, which is the part worth checking:
-- after delete_material the row still EXISTS (deleted_at is set, we soft delete),
-- so the object is claimed, so the second branch is off and the first fails on
-- deleted_at — the uploader loses the download at the same instant as everybody
-- else. A hard delete of the row would hand the object back to its uploader, but
-- nothing in the app hard-deletes materials.
--
-- WHY THE `unclaimed` TEST IS A DEFINER FUNCTION AND NOT AN INLINE `not exists`.
-- A policy's subqueries are themselves subject to RLS on the tables they touch.
-- An inline `not exists (select 1 from public.materials …)` would run under the
-- materials SELECT policy, which is per-group — so a member who uploaded a file
-- and then LEFT the group would stop seeing the row that claims it, "unclaimed"
-- would flip to true for them, and they would keep both the download and the
-- right to delete the bytes out from under the group. The definer function sees
-- all rows and answers the question that was actually asked.
-- ============================================================================

create or replace function public.storage_object_is_unclaimed(p_path text)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select not exists (
    select 1 from public.materials m where m.storage_path = p_path
  );
$$;

comment on function public.storage_object_is_unclaimed is
  'True when no materials row claims this storage path, deleted or not. Used by the group-materials Storage policies to recognise an upload that has not been recorded yet.';

revoke all on function public.storage_object_is_unclaimed(text) from public, anon;
grant execute on function public.storage_object_is_unclaimed(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Reads. Branch one is 0017's rule, unchanged. Branch two is the upload window.
--
-- owner_id is what the Storage API stamps with the uploader's JWT `sub`; the
-- older `owner` uuid column is left alone. A row inserted by anything other than
-- the API (service_role housekeeping, a migration) has owner_id null, which
-- matches nobody — such an object is claimable but not readable until a
-- materials row exists, which is the safe direction to fail.
-- ---------------------------------------------------------------------------
drop policy if exists group_materials_read on storage.objects;
create policy group_materials_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'group-materials'
    and (
      exists (
        select 1 from public.materials m
        where m.storage_path = storage.objects.name
          and m.deleted_at is null
          and public.is_group_member(m.group_id, auth.uid())
      )
      or (
        owner_id = auth.uid()::text
        and public.storage_object_is_unclaimed(storage.objects.name)
      )
    )
  );

-- ---------------------------------------------------------------------------
-- Deletes, same two branches.
--
-- Branch two is what lets the app clean up after itself: if the upload lands but
-- attach_material then fails (the group was archived a second earlier, the
-- device went offline mid-handshake), the client can remove the bytes it just
-- wrote. Without it those objects are permanent litter only a service_role sweep
-- could ever reach, since branch one requires a row that will never exist.
--
-- NOTE FOR ANY FUTURE READER OF THIS POLICY: you cannot exercise it with SQL.
-- storage.objects carries a BEFORE DELETE statement trigger, protect_objects_delete,
-- whose function raises 42501 'Direct deletion from storage tables is not allowed.
-- Use the Storage API instead.' unless the GUC storage.allow_delete_query is
-- 'true'. The Storage API sets it on its own connection; PostgREST gives a client
-- no way to. To test the policy from a SQL session, do
--
--   perform set_config('storage.allow_delete_query', 'true', true);
--
-- inside the transaction (it survives `set local role`, so it can be set once at
-- the top), after which RLS decides normally: a row the policy does not admit is
-- simply not deleted, with no error.
-- ---------------------------------------------------------------------------
drop policy if exists group_materials_delete on storage.objects;
create policy group_materials_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'group-materials'
    and (
      exists (
        select 1 from public.materials m
        where m.storage_path = storage.objects.name
          and (m.uploaded_by = auth.uid()
               or public.is_group_creator(m.group_id, auth.uid()))
      )
      or (
        owner_id = auth.uid()::text
        and public.storage_object_is_unclaimed(storage.objects.name)
      )
    )
  );

-- The INSERT policy from 0017 is deliberately left as it is. Adding
-- `owner_id = auth.uid()::text` to it would make the ownership rule airtight,
-- but it would also mean that any Storage API version which stamps only the
-- legacy `owner` column could not upload at all — trading recoverable litter for
-- a feature that does not work. The path check is the security-relevant half and
-- that one is already exact.
