-- One-shot live verification for 0019/0020/0022, in the harness idiom of the
-- project: one transaction, throwaway accounts, set local role + jwt claims,
-- refusals caught as assertions, everything rolled back at the end.
begin;

create temp table r (step text, result text);
grant all on r to authenticated, anon;

do $do$
declare
  a uuid; b uuid; cid uuid; nid uuid; nb uuid;
  t1 timestamptz; t2 timestamptz; n int; phase text;
  tok text := 'ExponentPushToken[tt-verify]';
  gid uuid := gen_random_uuid();
begin
  select course_id into cid from public.courses order by course_code limit 1;

  -- Throwaway accounts (never signed in via GoTrue; claims are set by hand).
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at)
  values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tt.a@example.com', 'tt',
          now(), '{}', '{}', now(), now())
  returning id into a;
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at)
  values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tt.b@example.com', 'tt',
          now(), '{}', '{}', now(), now())
  returning id into b;
  -- handle_new_auth_user (trigger) already created the public.users rows.
  update public.users set full_name='TT A', department='Zoology' where user_id=a;
  update public.users set full_name='TT B', department='Zoology' where user_id=b;

  -- 0019: seed ledger rows the way the sender (service) would.
  insert into public.notifications (user_id, kind, title, body, urgent, dedupe_key)
    values (a, 'invitation', 'TT A title', 'TT A body', false, 'tt-dk-a')
    returning notification_id into nid;
  insert into public.notifications (user_id, kind, title, body, urgent, dedupe_key)
    values (b, 'invitation', 'TT B title', 'TT B body', false, 'tt-dk-b')
    returning notification_id into nb;

  -- 0019: the dedupe collision must be a unique violation, not a second row.
  begin
    insert into public.notifications (user_id, kind, title, body, dedupe_key)
      values (a, 'invitation', 'x', 'x', 'tt-dk-a');
    insert into r values ('0019 dedupe collision (want 23505)', 'NO ERROR - BAD');
  exception when unique_violation then
    insert into r values ('0019 dedupe collision', '23505 unique_violation OK');
  end;

  -- ===== as A =====
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);

  insert into r values ('0019 A own rows (want 1)',
    (select count(*)::text from public.notifications where user_id = a));
  insert into r values ('0019 A sees B rows (want 0)',
    (select count(*)::text from public.notifications where user_id = b));
  insert into r values ('0019 mark_all first (want 1)',
    (select public.mark_all_notifications_read()::text));
  insert into r values ('0019 mark_all second (want 0)',
    (select public.mark_all_notifications_read()::text));
  insert into r values ('0019 A marks own (want ts)',
    coalesce((select public.mark_notification_read(nid)::text), 'null'));
  insert into r values ('0019 A marks B''s (want null)',
    coalesce((select public.mark_notification_read(nb)::text), 'null'));

  -- 0022: A registers the token.
  perform public.register_push_token(tok, 'ios');
  insert into r values ('0022 after A registers (want 1, owner A)',
    (select count(*)::text || ' row(s), owner-is-A=' || bool_and(user_id = a)::text
       from public.device_push_tokens where expo_token = tok));

  -- ===== as B: the shared-phone reassignment =====
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  perform public.register_push_token(tok, 'ios');
  insert into r values ('0022 B claims same token (want 1, owner B)',
    (select count(*)::text || ' row(s), owner-is-B=' || bool_and(user_id = b)::text
       from public.device_push_tokens where expo_token = tok));

  -- ===== as A: no back-door delete of B's row =====
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  with d as (delete from public.device_push_tokens where expo_token = tok returning 1)
  select count(*) into n from d;
  insert into r values ('0022 A direct delete of B row (want 0)', n::text);
  insert into r values ('0022 A forgets B''s token (want false)',
    (select public.forget_push_token(tok)::text));

  -- ===== as B: forget own =====
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  insert into r values ('0022 B forgets own (want true)',
    (select public.forget_push_token(tok)::text));
  insert into r values ('0022 token rows after forget (want 0)',
    (select count(*)::text from public.device_push_tokens where expo_token = tok));

  -- ===== anon is refused =====
  perform set_config('role', 'anon', true);
  -- claims are transaction-local and would otherwise leak B's identity into anon
  perform set_config('request.jwt.claims', '', true);
  begin
    perform public.mark_all_notifications_read();
    insert into r values ('0019 anon mark_all (want 42501)', 'NO ERROR - BAD');
  exception when insufficient_privilege then
    insert into r values ('0019 anon mark_all', '42501 refused OK');
  end;
  begin
    perform public.register_push_token(tok, 'ios');
    insert into r values ('0022 anon register (want refused)', 'NO ERROR - BAD');
  exception when others then
    insert into r values ('0022 anon register', sqlstate || ' ' || sqlerrm);
  end;

  -- ===== admin: 0020 setup =====
  perform set_config('role', 'none', true);
  insert into public.user_courses (user_id, course_id, availability, proficiency)
    values (a, cid, '1100000011000000110000000000', 2),
           (b, cid, '1100000011000000110000000000', null);
  perform public.open_matching_window('tt-verify window', now() - interval '1 hour', now() + interval '2 hours');

  -- ===== as A: window state, then apply twice =====
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  insert into r values ('0020 window_state as A',
    coalesce((select mw::text from public.matching_window_state() mw), 'no rows'));
  select public.request_matching(cid) into t1;
  select public.request_matching(cid) into t2;
  insert into r values ('0020 A applies (want ts)', coalesce(t1::text, 'NULL - BAD'));
  insert into r values ('0020 A idempotent replay',
    case when t1 = t2 then 'same ts OK' else 'DIFFERENT: ' || t1::text || ' vs ' || t2::text end);

  -- ===== as B: unrated, window open -> rating refusal =====
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  begin
    perform public.request_matching(cid);
    insert into r values ('0020 B unrated (want refusal)', 'NO REFUSAL - BAD');
  exception when others then
    insert into r values ('0020 B unrated', sqlerrm);
  end;

  -- ===== admin: shut the window =====
  perform set_config('role', 'none', true);
  perform public.close_matching_window_now();

  -- ===== as B: window refusal precedes the rating one =====
  perform set_config('role', 'authenticated', true);
  begin
    perform public.request_matching(cid);
    insert into r values ('0020 B window shut (want refusal)', 'NO REFUSAL - BAD');
  exception when others then
    insert into r values ('0020 B window shut', sqlerrm);
  end;
  begin
    perform public.request_matching(gen_random_uuid());
    insert into r values ('0020 B not enrolled (want refusal)', 'NO REFUSAL - BAD');
  exception when others then
    insert into r values ('0020 B not enrolled', sqlerrm);
  end;

  -- ===== admin: an OUTSTANDING application cannot be withdrawn by deleting =====
  -- B has not applied (every request_matching attempt of theirs was refused), so
  -- stamp applied_at directly, as a past window's run would have. The table's
  -- own CHECK demands a rating alongside it.
  perform set_config('role', 'none', true);
  update public.user_courses set proficiency = 2, applied_at = now() where user_id = b and course_id = cid;
  begin
    delete from public.user_courses where user_id = b and course_id = cid;
    insert into r values ('0020 delete while outstanding (want refused)', 'NO REFUSAL - BAD');
  exception when others then
    insert into r values ('0020 delete while outstanding', sqlstate || ' ' || sqlerrm);
  end;

  -- ===== admin: system group writes the group_matched rows =====
  -- Clear B's stamp first: request_matching's idempotent early return for an
  -- already-applied student precedes its grouped check, and the next assertion
  -- wants the grouped refusal.
  perform set_config('role', 'none', true);
  update public.user_courses set applied_at = null where user_id = b and course_id = cid;
  perform public.create_system_group(gid, 'TT System Group', cid, array[a, b], a);
  insert into r values ('0020 group_matched rows (want 2)',
    (select count(*)::text from public.notifications where kind = 'group_matched' and user_id in (a, b)));

  -- ===== as B: grouped refusal precedes the window one =====
  perform set_config('role', 'authenticated', true);
  begin
    perform public.request_matching(cid);
    insert into r values ('0020 B grouped (want refusal)', 'NO REFUSAL - BAD');
  exception when others then
    insert into r values ('0020 B grouped', sqlerrm);
  end;

  -- ===== admin: once PLACED the application is honoured, and the row is
  -- deletable again — the trigger's second half =====
  perform set_config('role', 'none', true);
  delete from public.user_courses where user_id = a and course_id = cid;
  get diagnostics n = row_count;
  insert into r values ('0020 delete after placement (want 1)', n::text);
end $do$;

select * from r order by step;

rollback;
