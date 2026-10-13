-- ============================================================================
-- StudySync — seed 20 students across 10 courses, all applied to the match pool.
--
-- This REPLACES the earlier one-course draft of this file. That version was
-- never run against the live project (no seed users existed) and could not
-- have been: it still read `topics` and `user_course_topics`, which migration
-- 0009 dropped — matching is course + availability only now.
--
-- WHAT IT DOES (idempotent — safe to re-run):
--   1. 20 auth.users + public.users profiles, with real departments and a
--      timezone. Every student can actually log in: the password is
--      c_password below and the email is confirmed. An auth.identities row is
--      upserted per student too — without it GoTrue's password grant fails
--      with a 500 for hand-inserted users.
--   2. Each enrols in 3 of the ten 500-level courses in c_courses (migration
--      0026), always inside their own department:
--        students  1–10  Computer Science         -> CSC 501 + two more
--        students 11–20  Agricultural Engineering -> AGE 501 + two more
--      Both departments use the same pattern, so their pools mirror:
--        x01: 10   x03: 7   x05: 5   x07: 5   x09: 3
--      Every pool holds at least three, so each course can form a group.
--   3. Availability is ALL EIGHT WEEKEND SLOTS plus two or three week nights
--      per student (six patterns rotate through the twenty), so every pair
--      shares at least the whole weekend and the night patterns give the
--      schedule score something to differentiate on.
--   4. All 20 apply to be matched on every course they take — through the real
--      public.request_matching(), not by writing applied_at directly, so the
--      window / rating / availability guards actually execute. request_matching
--      resolves the caller via auth.uid(), which reads the `request.jwt.claim.sub`
--      GUC, so the loop lends each student their identity with set_config for
--      the duration of the call.
--   5. Opens a registration window first if none is currently open. (If a
--      FUTURE window exists that overlaps the proposed 7 days, open_matching_window
--      refuses with its own overlap message and the whole seed rolls back.)
--
-- NOT seeded, on purpose:
--   * No topics — they do not exist since 0009.
--   * No device_push_tokens — the send-push sweep must never see fake Expo
--     tokens; 'group_matched' notifications will sit in the in-app inbox.
--   * No groups — the pool is left for run-batch-matching (service_role) to
--     consume.
--
-- PREREQUISITES: migrations through 0026 applied; the ten courses exist
-- (migration 0026, mirrored in supabase/seed/0003_seed_courses.sql).
--
-- RUN:   supabase db query --linked --file supabase/seed_matching_test.sql
--        (or paste into the Supabase SQL Editor — no psql variables are used)
--
-- LOGIN: <firstname>.<lastname>@seed.invalid  /  studysync
--        e.g. adaeze.okafor@seed.invalid — to eyeball the applied state in-app.
--
-- ROLLBACK (removes the 20 students and everything they own, cascading):
--   delete from auth.users where email like '%@seed.invalid';
-- ============================================================================

do $seed$
declare
  -- ---- configuration -------------------------------------------------------
  -- The ten courses everyone registers across. Must exist in public.courses.
  c_courses    constant text[] := array['CSC 501', 'CSC 503', 'CSC 505', 'CSC 507', 'CSC 509',
                                        'AGE 501', 'AGE 503', 'AGE 505', 'AGE 507', 'AGE 509'];
  c_email_host constant text   := '@seed.invalid';
  c_password   constant text   := 'studysync';       -- login password for every seed student
  c_timezone   constant text   := 'Africa/Lagos';

  -- Availability encoding (must mirror src/lib/availability.ts):
  --   bit index = day * 4 + slot; day 0=Mon .. 6=Sun;
  --   slot 0=morning(08-12) 1=afternoon(12-16) 2=evening(16-20) 3=night(20-23);
  --   bit 0 is the leftmost character of the bit string.
  -- Weekend = days 5,6 × all four slots -> indices 20..27.
  c_weekend    constant int[]  := array[20, 21, 22, 23, 24, 25, 26, 27];

  v_course_ids uuid[];
  v_missing    text;
  v_window_id  uuid;
  s            record;
  v_uid        uuid;
  v_email      text;
  v_avail      bit(28) := B'0000000000000000000000000000';
  v_bits       int[];
  v_idx        int;
  v_course_code text;
  v_course_id  uuid;
  v_uc_id      uuid;
  v_applied_at timestamptz;
  v_created    int := 0;
  v_enrolled   int := 0;
  v_applied    int := 0;
  v_skipped    int := 0;
begin
  -- ---- resolve the ten courses ---------------------------------------------
  select coalesce(array_agg(course_id order by course_code), array[]::uuid[])
    into v_course_ids
    from public.courses
   where course_code = any(c_courses);

  if coalesce(array_length(v_course_ids, 1), 0) <> array_length(c_courses, 1) then
    select string_agg(cc, ', ') into v_missing
      from unnest(c_courses) as cc
      where cc not in (select course_code from public.courses);
    raise exception 'Missing courses in public.courses: % — run supabase/seed/0003_seed_courses.sql first.', v_missing;
  end if;

  -- ---- registration window: request_matching refuses to apply without one ---
  select w.window_id into v_window_id
    from public.matching_windows w
   where w.opens_at <= now()
     and w.closes_at >  now()
   order by w.opens_at
   limit 1;

  if v_window_id is null then
    v_window_id := public.open_matching_window(
      'Seed matching window', now(), now() + interval '7 days');
  end if;

  -- ---- the 20 students -------------------------------------------------------
  -- night_days = weekdays that get a NIGHT session on top of the full weekend;
  -- day 0=Mon .. 4=Fri, so the bit index added is day*4 + 3.
  for s in
    select * from (values
      ( 1,'Adaeze Okafor',      'Computer Science',         array['CSC 501','CSC 503','CSC 505'], array[0,2],    1),
      ( 2,'Chinedu Eze',        'Computer Science',         array['CSC 501','CSC 503','CSC 505'], array[1,3],    2),
      ( 3,'Fatima Bello',       'Computer Science',         array['CSC 501','CSC 503','CSC 505'], array[2,4],    3),
      ( 4,'Emeka Nwosu',        'Computer Science',         array['CSC 501','CSC 503','CSC 505'], array[0,3],    1),
      ( 5,'Aisha Yusuf',        'Computer Science',         array['CSC 501','CSC 503','CSC 507'], array[1,2],    2),
      ( 6,'Tunde Adeyemi',      'Computer Science',         array['CSC 501','CSC 503','CSC 507'], array[0,1,3],  3),
      ( 7,'Ngozi Obi',          'Computer Science',         array['CSC 501','CSC 503','CSC 507'], array[2,4],    2),
      ( 8,'Ibrahim Musa',       'Computer Science',         array['CSC 501','CSC 507','CSC 509'], array[0,2],    1),
      ( 9,'Kemi Adebayo',       'Computer Science',         array['CSC 501','CSC 505','CSC 509'], array[1,3],    2),
      (10,'Olumide Fashola',    'Computer Science',         array['CSC 501','CSC 507','CSC 509'], array[2,4],    3),
      (11,'Zainab Lawal',       'Agricultural Engineering', array['AGE 501','AGE 503','AGE 505'], array[0,3],    1),
      (12,'Chidi Anyanwu',      'Agricultural Engineering', array['AGE 501','AGE 503','AGE 505'], array[1,2],    2),
      (13,'Blessing Etim',      'Agricultural Engineering', array['AGE 501','AGE 503','AGE 505'], array[0,1,3],  3),
      (14,'Suleiman Abubakar',  'Agricultural Engineering', array['AGE 501','AGE 503','AGE 505'], array[2,4],    1),
      (15,'Funmi Alade',        'Agricultural Engineering', array['AGE 501','AGE 503','AGE 507'], array[0,2],    2),
      (16,'Kelechi Udo',        'Agricultural Engineering', array['AGE 501','AGE 503','AGE 507'], array[1,3],    3),
      (17,'Halima Sani',        'Agricultural Engineering', array['AGE 501','AGE 503','AGE 507'], array[2,4],    1),
      (18,'Segun Balogun',      'Agricultural Engineering', array['AGE 501','AGE 507','AGE 509'], array[0,3],    2),
      (19,'Amarachi Igwe',      'Agricultural Engineering', array['AGE 501','AGE 505','AGE 509'], array[1,2],    1),
      (20,'Bola Ogunleye',      'Agricultural Engineering', array['AGE 501','AGE 507','AGE 509'], array[0,1,3],  3)
    ) as t(seq, full_name, department, courses, night_days, proficiency)
  loop
    v_email := lower(replace(s.full_name, ' ', '.')) || c_email_host;

    -- auth user; the handle_new_auth_user trigger creates the public.users row.
    -- encrypted_password is a real bcrypt hash, so the account is sign-in-able.
    -- confirmed_at is a GENERATED column (GoTrue derives it from
    -- email_confirmed_at), so it must not appear in the column list. The token
    -- columns are seeded as '' to match GoTrue's own signup shape.
    select id into v_uid from auth.users where email = v_email;
    if v_uid is null then
      insert into auth.users (
        instance_id, id, email, encrypted_password,
        email_confirmed_at,
        confirmation_token, recovery_token, email_change,
        email_change_token_new, reauthentication_token,
        created_at, updated_at, role, aud,
        raw_app_meta_data, raw_user_meta_data
      ) values (
        '00000000-0000-0000-0000-000000000000',
        gen_random_uuid(), v_email, crypt(c_password, gen_salt('bf')),
        now(),
        '', '', '', '', '',
        now(), now(), 'authenticated', 'authenticated',
        jsonb_build_object('provider','email','providers',array['email']),
        jsonb_build_object('full_name', s.full_name, 'department', s.department)
      ) returning id into v_uid;
      v_created := v_created + 1;
    end if;

    -- GoTrue's password grant 500s ("Database error querying schema") for a
    -- user with no auth.identities row: hand-inserted auth.users rows don't
    -- get one the way GoTrue's signup does. Upserted outside the if above so
    -- re-runs also repair users created by earlier versions of this seed.
    insert into auth.identities (
      id, user_id, identity_data, provider_id, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), v_uid,
      jsonb_build_object('sub', v_uid::text, 'email', v_email,
                         'email_verified', true, 'phone_verified', false,
                         'full_name', s.full_name),
      v_uid::text, 'email', now(), now(), now()
    )
    on conflict do nothing;

    -- profile: upsert so re-runs also refresh pre-existing rows.
    insert into public.users (user_id, full_name, email, department, timezone, onboarding_complete)
    values (v_uid, s.full_name, v_email, s.department, c_timezone, true)
    on conflict (user_id) do update
      set full_name          = excluded.full_name,
          department         = excluded.department,
          timezone           = excluded.timezone,
          onboarding_complete = true;

    -- weekend slots + this student's week nights
    v_bits  := c_weekend || array(select d * 4 + 3 from unnest(s.night_days) as d);
    v_avail := B'0000000000000000000000000000'::bit(28);
    foreach v_idx in array v_bits loop
      v_avail := set_bit(v_avail, v_idx, 1);
    end loop;

    -- enrol (and apply) on each of this student's courses
    foreach v_course_code in array s.courses loop
      select course_id into v_course_id
        from public.courses
       where course_code = v_course_code;

      insert into public.user_courses (user_id, course_id, availability, proficiency)
      values (v_uid, v_course_id, v_avail, s.proficiency)
      on conflict (user_id, course_id) do update
        set availability = excluded.availability,
            proficiency  = excluded.proficiency
      returning user_course_id, applied_at into v_uc_id, v_applied_at;

      v_enrolled := v_enrolled + 1;

      if v_applied_at is not null then
        -- already in the pool from an earlier run of this seed
        v_skipped := v_skipped + 1;
      elsif exists (
        select 1
          from public.group_members gm
          join public.groups g on g.group_id = gm.group_id
         where gm.user_id = v_uid
           and g.course_id = v_course_id
      ) then
        -- a matching run already placed this student; leave them be
        v_skipped := v_skipped + 1;
      else
        -- Lend the student's identity to the transaction so the real
        -- request_matching() runs with its guards. auth.uid() reads
        -- request.jwt.claim.sub (verified against the live definition).
        perform set_config('request.jwt.claims',
                           jsonb_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
        perform set_config('request.jwt.claim.sub', v_uid::text, true);
        perform set_config('request.jwt.claim.role', 'authenticated', true);
        perform public.request_matching(v_course_id);
        v_applied := v_applied + 1;
      end if;
    end loop;
  end loop;

  raise notice 'Seed complete: % profiles (% new), % enrollments, % new applications, % already in pool or placed.',
    20, v_created, v_enrolled, v_applied, v_skipped;
end
$seed$;

-- Visible summary — the seed ran clean only if every row shows
-- seeded_in_pool = seeded_enrolled.
select c.course_code,
       count(*)                                          as seeded_enrolled,
       count(*) filter (where uc.applied_at is not null) as seeded_in_pool,
       (select count(*) from public.user_courses x
         where x.course_id = c.course_id
           and x.applied_at is not null)                 as pool_all_users
  from public.user_courses uc
  join public.courses c on c.course_id = uc.course_id
  join public.users  u on u.user_id   = uc.user_id
 where u.email like '%@seed.invalid'
 group by c.course_id, c.course_code
 order by c.course_code;
