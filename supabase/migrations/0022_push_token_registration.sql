-- ============================================================================
-- 0022_push_token_registration.sql  —  claiming a device for a student.
--
-- `device_push_tokens` has existed since 0001 and nothing has ever written to it.
-- Step 6 finally does, and the write turns out to be the one shape the table's own
-- RLS cannot express.
--
-- THE PHONE-SHARING PROBLEM.
--
-- `expo_token` is UNIQUE, and correctly so: it identifies a device, not an
-- account. Two students who share a phone produce the SAME token. So the second
-- one to sign in needs an upsert that moves the existing row's `user_id` — and
-- 0002's `push_tokens_update_own` says `using (user_id = auth.uid())`, which is
-- false for exactly that row. The upsert fails with a policy violation, the
-- student gets no push, and nothing in the app can tell them why.
--
-- Relaxing the policy is not the fix. `using (true)` on an UPDATE would let any
-- signed-in student claim any token by guessing it, and the payoff for guessing is
-- another student's notifications on your lock screen. Phone-sharing is normal in
-- this user population (the sign-out path in AuthContext is built around it), so
-- this is a live path, not a hypothetical.
--
-- So: a `security definer` function that does the one privileged thing — reassign
-- a token that already exists — and nothing else. The caller cannot name a
-- `user_id`; it is always `auth.uid()`. There is no way to spell "give this token
-- to somebody else" through this API, which is the property the open policy would
-- have thrown away.
--
-- WHAT IT DOES NOT DO.
--
-- It does not touch `users.timezone`. That is written by the client through 0002's
-- own-row update, and it has to be a separate write because it is needed even when
-- there is NO token: a student in Expo Go, or one who declined the OS prompt, still
-- has quiet hours, and the compose phase still evaluates them against a local
-- clock. Folding the two together would make the timezone depend on a push
-- registration that never happens.
--
-- Forward-only: one function, one grant. No schema change, no policy change.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- register_push_token — "this device belongs to me now."
--
-- Idempotent by design and called on every sign-in, so the common case is the
-- second one: same student, same device, and all that changes is `last_seen_at`.
-- That timestamp is the only thing the sender can use to tell a live device from
-- one uninstalled eight months ago, which is why it is refreshed even when nothing
-- else moved.
--
-- `platform` is re-asserted rather than left alone. It cannot change for a real
-- device, but it CAN be wrong: a token minted on a reinstall, or a row written by
-- an earlier build that guessed. Taking the caller's word each time keeps the
-- column honest at no cost.
--
-- Returns the row's id so the client can hold it, but the client's real handle is
-- the token string itself — the id is a convenience, not a capability.
-- ---------------------------------------------------------------------------
create or replace function public.register_push_token(
  p_expo_token text,
  p_platform   text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;

  -- Validated here rather than trusted, because `security definer` means this
  -- function's checks are the ONLY checks. The table's CHECK would catch a bad
  -- platform, but a blank token would insert happily and then match nothing.
  if p_expo_token is null or length(trim(p_expo_token)) = 0 then
    raise exception 'A push token is required.';
  end if;
  if p_platform not in ('ios', 'android') then
    raise exception 'Unknown platform: %', p_platform;
  end if;

  insert into public.device_push_tokens (user_id, expo_token, platform)
  values (v_uid, trim(p_expo_token), p_platform)
  on conflict (expo_token) do update
     set user_id      = v_uid,
         platform     = excluded.platform,
         last_seen_at = now()
  returning token_id into v_id;

  return v_id;
end;
$$;

comment on function public.register_push_token is
  'Claim this device''s Expo push token for the calling student, moving it off whoever held it before. Idempotent; refreshes last_seen_at on every call. security definer because a shared phone means the row being updated may belong to another student, which no own-row policy can permit safely.';

-- ---------------------------------------------------------------------------
-- forget_push_token — the sign-out half.
--
-- Defence in depth, not the only guard. The next student to sign in on this phone
-- reassigns the row through `register_push_token` above, so the dangerous window
-- is "signed out, nobody signed in yet" — and in that window a push would land on
-- a lock screen belonging to nobody in particular, naming a group and a meeting
-- time. Cheap to close, so it is closed.
--
-- Deliberately narrow: it deletes ONE token, the one the caller is holding, and
-- only if it is currently theirs. A student with two devices signing out of one
-- keeps push on the other. Silent when the token is not theirs — there is nothing
-- for the leaving student to do about it, and saying so would be a way to probe
-- which tokens exist.
-- ---------------------------------------------------------------------------
create or replace function public.forget_push_token(p_expo_token text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_n   integer;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;

  delete from public.device_push_tokens
   where expo_token = trim(coalesce(p_expo_token, ''))
     and user_id = v_uid;

  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

comment on function public.forget_push_token is
  'Drop one of the caller''s own device tokens, for sign-out on a shared phone. Returns false rather than raising when the token is not theirs.';

grant execute on function public.register_push_token(text, text) to authenticated;
grant execute on function public.forget_push_token(text) to authenticated;
