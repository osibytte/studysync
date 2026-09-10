-- Fixture for the send-push live verification. Unlike verify_stage5_live.sql
-- this is NOT wrapped in begin/rollback: the function writes through its own
-- service-role client, outside any transaction opened here. Everything is
-- tagged tt.snd.* and removed by cleanup_send_push_test.sql afterwards.
--
-- Wall-clock assumption, checked at seed time: it is night in Lagos
-- (Africa/Lagos, UTC+1), so student A's default 22:00-07:00 quiet hours are in
-- force and B's 07:00-07:00 window is off. The seed refuses to run otherwise,
-- so the run's assertions can never pass for the wrong reason.

do $do$
declare
  a uuid; b uuid; cid uuid; gid uuid;
  m1 uuid; m2 uuid; m3 uuid; m4 uuid;
  s1 uuid; s2 uuid; i1 uuid;
  lagos_hour int;
begin
  select course_id into cid from public.courses order by course_code limit 1;

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at)
  values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'tt.snd.a@example.com', 'tt', now(), '{}', '{}', now(), now())
  returning id into a;
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at)
  values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'tt.snd.b@example.com', 'tt', now(), '{}', '{}', now(), now())
  returning id into b;

  -- A: default quiet hours 22:00-07:00, Lagos. B: equal start/end, which the
  -- rules read as quiet hours OFF.
  update public.users set full_name='Snd A', timezone='Africa/Lagos'
    where user_id = a;
  update public.users
     set full_name='Snd B', timezone=null,
         notification_prefs = jsonb_build_object(
           'quiet_hours_start','07:00','quiet_hours_end','07:00',
           'daily_cap',3,'push_enabled',true)
   where user_id = b;

  -- The seed only makes sense at night in Lagos: the whole A-side of the
  -- verification (quiet-hours withholding, watermark held) depends on it.
  select extract(hour from (now() at time zone 'Africa/Lagos'))::int into lagos_hour;
  if lagos_hour < 22 and lagos_hour >= 7 then
    raise exception 'Seed expects night in Lagos; it is %:00 there. Run this between 22:00 and 07:00 Lagos time.', lagos_hour;
  end if;

  insert into public.user_courses (user_id, course_id, availability, proficiency)
    values (a, cid, '1100000011000000110000000000', 2),
           (b, cid, '1100000011000000110000000000', 2);

  insert into public.groups (group_id, group_name, course_id, formation_type,
                             is_discoverable, max_members, created_by, status,
                             last_activity_at)
  values (gen_random_uuid(), 'TT Sender Group', cid, 'self_organized', true, 8, a, 'active',
          now() - interval '8 days')
  returning group_id into gid;

  -- last_pushed_at is the digest watermark: an hour back, so tonight's
  -- messages are inside the window.
  insert into public.group_members (group_id, user_id, role, last_pushed_at)
    values (gid, a, 'creator', now() - interval '1 hour'),
           (gid, b, 'member',  now() - interval '1 hour');

  -- Chat: two from B, one from A, one deleted. A's digest counts 2 (not their
  -- own, not deleted), B's counts 1.
  insert into public.messages (message_id, group_id, sender_id, body, created_at)
  values (gen_random_uuid(), gid, b, 'hello from B one', now() - interval '5 minutes')
  returning message_id into m1;
  insert into public.messages (message_id, group_id, sender_id, body, created_at)
  values (gen_random_uuid(), gid, b, 'hello from B two', now() - interval '4 minutes')
  returning message_id into m2;
  insert into public.messages (message_id, group_id, sender_id, body, created_at)
  values (gen_random_uuid(), gid, a, 'hello from A', now() - interval '3 minutes')
  returning message_id into m3;
  insert into public.messages (message_id, group_id, sender_id, body, created_at, deleted_at)
  values (gen_random_uuid(), gid, b, '', now() - interval '2 minutes', now())
  returning message_id into m4;

  -- Proposed, one yes short of its threshold of two: chases A, who has not
  -- answered. Created inside the compose window, so session_proposed fires too.
  insert into public.study_sessions
    (session_id, group_id, proposed_by, starts_at, duration_min, status, created_at)
  values (gen_random_uuid(), gid, b, now() + interval '2 hours', 120, 'proposed',
          now() - interval '5 minutes')
  returning session_id into s1;
  insert into public.session_responses (session_id, user_id, response, responded_at)
    values (s1, b, 'yes', now() - interval '5 minutes');

  -- Confirmed inside the window (the second yes flips it via the trigger) but
  -- created before it, so only the confirmation is news.
  insert into public.study_sessions
    (session_id, group_id, proposed_by, starts_at, duration_min, status, created_at)
  values (gen_random_uuid(), gid, a, now() + interval '4 hours', 60, 'proposed',
          now() - interval '30 minutes')
  returning session_id into s2;
  insert into public.session_responses (session_id, user_id, response, responded_at)
    values (s2, a, 'yes', now() - interval '30 minutes'),
           (s2, b, 'yes', now() - interval '5 minutes');

  -- One fresh invitation to A from B. The invitations_one_pending index
  -- allows a single pending row per (group, invitee), so the
  -- invitation_unanswered nudge is tested by AGING this row between runs
  -- (cleanup script's companion step), not by seeding a second one.
  insert into public.invitations (invitation_id, group_id, inviter_id, invitee_id,
                                  status, created_at)
  values (gen_random_uuid(), gid, b, a, 'pending', now() - interval '5 minutes')
  returning invitation_id into i1;

  raise notice 'seeded: A=% B=% group=% sessions=%/% invitation=% messages=%',
    a, b, gid, s1, s2, i1,
    (select count(*) from public.messages where group_id = gid);
end $do$;
