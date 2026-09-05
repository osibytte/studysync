# StudySync — Stages 1 & 2: Accounts, Profiles & Group Formation

Study-partner matching for University of Ibadan students. React Native (Expo) + Supabase.

This is the first two stages of a five-stage build. A student can register, sign in, set their name and department, pick courses, and set a weekly availability grid. They can then be matched into a study group, browse the open groups on their courses, create their own, invite people, and answer invitations and join requests. Profile edits, creating a group, leaving a group, and choosing whether a course opts into automatic matching all work offline and sync when the connection returns.

Chat, materials and notifications are later stages. Stage 2's screens are written and typechecked but have **not yet been exercised against the live database from a device** — see the end of the Stage 2 section.

## What you need

- Node.js 20.19.4+, 22.13+, or 24.3+ — React Native 0.86 refuses older ones, Node 18 included
- A free Supabase account and project
- Expo Go on your phone (it runs one SDK version; this project is on **Expo SDK 57**, which is
  what the current App Store and Play Store builds ship)
- No card required at this tier

## Setup

### 1. Install

```bash
cd studysync
npm install
```

### 2. Create your Supabase project

At supabase.com, create a project. Note the region — pick the closest one to Nigeria (usually `eu-west-1` or `eu-central-1`) since latency shows up directly in the 2-second chat target in Stage 3.

### 3. Run the migrations

Supabase dashboard → SQL Editor → New query. Run these three files in order, each as a separate query:

1. `supabase/migrations/0001_stage1_schema.sql` — tables, triggers, the overlap function
2. `supabase/migrations/0002_stage1_rls.sql` — row level security policies
3. `supabase/seed/0003_seed_courses.sql` — placeholder courses

Order matters: 0002 adds policies to tables 0001 creates, and 0003 inserts into them.

**The seed data is placeholder.** The course codes follow the usual Nigerian convention, but I have not seen the UI syllabus. Check every row against the real course catalogue before your pilot — matching only ever compares students enrolled in the same course, so a wrong or missing course code silently keeps compatible students apart.

### 4. Wire up your credentials

```bash
cp .env.example .env
```

Fill in `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` from Project Settings → API.

The anon key is safe to ship in a mobile app — it is designed to be public, and RLS is what actually protects data. Never put the `service_role` key in `.env`; it bypasses RLS entirely and belongs only in Edge Function secrets from Stage 2 onward.

### 5. Decide on email confirmation

Authentication → Providers → Email. If "Confirm email" is on, signup shows a "check your email" screen and you cannot proceed until you click the link. **For testing, turn it off** — it makes creating the two test accounts you need for the RLS check much faster.

### 6. Run it

```bash
npx expo start
```

Scan the QR with Expo Go. If you change `.env`, restart with `npx expo start --clear` — Expo only reads env vars at startup.

## Verifying it works

### Unit tests

```bash
npm test
```

Covers the availability bitmask (encode/decode round-trip, day/slot bit layout, overlap counting, the zero-overlap edge case the spec names) and profile validation. The bit-layout tests are the important ones: if the TypeScript and SQL disagree about which bit is which, matching silently compares the wrong slots and nothing throws.

```bash
npm run typecheck
```

### Manual walkthrough

Time yourself against the 5-minute onboarding target:

1. Create an account
2. Enter name and department
3. Pick two or three courses
4. Set availability — tap a day name to fill the whole column
5. Land on home and confirm it reflects your courses and availability

### Offline behaviour

This is the heaviest requirement in the spec, so test it properly:

1. With the app open and signed in, turn on airplane mode
2. A grey banner appears: "Offline — showing saved data"
3. Edit your profile and save. The banner turns amber: "1 change saved, will sync automatically"
4. Force-quit the app and reopen it. Your edit is still there and still queued — the queue is in AsyncStorage, not memory
5. Turn airplane mode off. The queue drains on its own and the banner disappears
6. Check the Supabase table editor — the change landed

Worth also trying: queue several changes, then reconnect. They apply in order, because setting a course's availability depends on its course enrolment existing first.

### RLS — the check that actually matters

The spec's definition of done requires proving a student outside a group cannot read its data, not just that the UI hides it. Same principle applies to profiles in Stage 1.

**The SQL editor cannot test this.** It runs as superuser and bypasses RLS completely, so everything looks readable and you learn nothing.

Do this instead:

1. Create two accounts (A and B) through the app
2. Sign in as A, complete onboarding, note A's `user_id` from Supabase → Authentication → Users
3. Sign out, sign in as B
4. In `app/(app)/home.tsx`, temporarily add inside the component:

```ts
// TEMPORARY RLS CHECK — remove after verifying
useEffect(() => {
  void supabase
    .from('users')
    .select('*')
    .eq('user_id', 'PASTE_USER_A_ID_HERE')
    .then(({ data, error }) => {
      console.log('RLS check — rows:', data?.length ?? 0, 'error:', error?.message);
    });
}, []);
```

5. Expect `rows: 0` with no error. Zero rows and no error is exactly right: RLS filters invisibly rather than raising a permission error, so B's query returns an empty set as if A did not exist.
6. Repeat against `user_courses` filtered by A's id — also zero
7. Remove the block

If you see rows, RLS is not doing its job. Check that `0002_stage1_rls.sql` ran without errors and that `pg_tables.rowsecurity` is true for every table.

## Stage 2 — Group Formation

The database layer is complete — migrations `0004`–`0007` add the group tables, SELECT-only RLS, the SECURITY DEFINER write RPCs (all group mutations go through these, never a direct client write), a daily `pg_cron` lifecycle sweep, and the batch-matching pool column plus its operator write path (`0007`, described below). `0009` then removed topics, `0010` added the four read RPCs the client screens need, `0011` added the course-enrolment gate to the five write paths that hand out or promise a membership, and `0012` made the shared-time answer require every member while a group is small. Run them in order after Stage 1's `0001`–`0003`.

The compatibility score is a weighted sum, normalised to `[0, 1]`:

```
score = 0.8 · scheduleOverlap + 0.2 · groupFillBonus
```

Matching is by **course + availability**: course is the grouping key (only students enrolled in the same course are ever compared), and schedule overlap is the real compatibility signal — you have to actually be able to meet — with a small nudge toward filling a near-complete group. Schedule overlap normalises against the *more constrained* side, not the maximum, so a time-poor student is not punished for it. See `src/lib/matching.ts`.

### Pathway One — the `find-group` matching function

`supabase/functions/find-group` is an Edge Function that answers "find me a group for this course". It runs server-side for a privacy reason, not a performance one: RLS restricts `users` and `user_courses` to their owner, so the app *cannot* read other students' availability. Matching needs exactly that, across many students, so it runs with the `service_role` key (an Edge Function secret, never shipped in the app), reads what it needs, scores it, and returns only privacy-safe fields — name and department, a score, and a shared-slot count. Never an email or a raw availability mask.

It is read-only. It *suggests* existing joinable groups (ranked) and lone students to form a new group with (ranked). Acting on a suggestion — `request_to_join`, or `create_group` + `send_invitation` — is the client's job through the `0005` RPCs.

**The scoring is duplicated, on purpose.** The app imports `src/lib/matching.ts`; the function imports a hand-kept copy at `supabase/functions/_shared/matching.ts`, because the Deno function tree can't reliably reach up into `src/` at deploy time. The two copies must stay identical — the region between the `// === MIRROR START ===` / `// === MIRROR END ===` sentinels is asserted byte-for-byte equal by `src/lib/__tests__/mirror.test.ts`, so drift fails `npm test` rather than silently scoring differently on client and server. `_shared/availability.ts` is a full copy of `src/lib/availability.ts` under the same rule. **Change one, change both** — the same discipline as the `availability.ts` ⇄ SQL `availability_overlap()` pairing.

Deploy and test it (needs the Supabase CLI and Deno, neither required for the app itself):

```bash
supabase functions deploy find-group
```

Locally:

```bash
supabase functions serve find-group
```

then call it with a real user's JWT (copy an `access_token` from a signed-in session) and a course id:

```bash
curl -i -X POST http://localhost:54321/functions/v1/find-group \
  -H "Authorization: Bearer <USER_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"course_id":"<COURSE_UUID>"}'
```

Expect a JSON body with `requester`, a ranked `groups` array, and a ranked `suggested_partners` array. A caller not enrolled in the course gets a `400`; no JWT gets a `401`. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform — nothing to set by hand.

### Admin-initiated batch matching — the `run-batch-matching` function

`find-group` waits to be asked. Its counterpart, `supabase/functions/run-batch-matching`, is how an operator *starts* system matching for a whole course — "signify to the system when to begin the group matching" once enough students have enrolled. It reads the course's waiting pool, carves it into groups with the same mirrored scoring, and writes them.

**Who may run it.** There is no admin user in the schema, by design. The function authorises by requiring the request's bearer token to equal the `service_role` key — "admin" is whoever holds that key (you, from the dashboard or a script). Because that check lives entirely in the function, deploy it so the platform's own JWT gate doesn't reject the service key first:

```bash
supabase functions deploy run-batch-matching --no-verify-jwt
```

**Who's in the pool.** Every student enrolled in the course with `user_courses.matching_pref = 'system'` (the default on enrolment), minus anyone already in a group on that course. A student who would rather organise their own group sets `matching_pref = 'self_organized'` — from the "How you get matched" screen, which calls the `set_matching_pref` RPC in `0007` — and is left out: "the self-matching students are not among." So is anyone who has already self-organised, since group membership excludes them too.

**How it groups.** Group size is a random target of 3–6, per the product decision. Two rules keep the tail humane: a remainder of 2–6 becomes one final group (a pair is allowed), and a target that would strand exactly one student is shrunk by one. So any pool of ≥ 2 is fully grouped, and only a lone student (a pool of exactly one) comes back in `waiting`, to be picked up on the next run. Each group is written through the `create_system_group` RPC (`0007`) — service-role-only, the sole write path, mirroring how the client's own mutations go through definer RPCs.

Try it with `dry_run` first — it runs the full partition and returns the proposed groups **without writing anything** (needs the Supabase CLI and Deno, as with `find-group`):

```bash
curl -i -X POST http://localhost:54321/functions/v1/run-batch-matching \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"course_id":"<COURSE_UUID>","dry_run":true}'
```

Happy with the preview? Drop `dry_run` to actually form the groups (and optionally hold until enough have enrolled with `min_pool`):

```bash
curl -i -X POST http://localhost:54321/functions/v1/run-batch-matching \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"course_id":"<COURSE_UUID>","min_pool":8}'
```

The response is a run summary: `pool_size`, the `groups` formed (each with its members' names and ids, a size, and a `cohesion` score) and any `waiting` leftover. Names and ids are fine here — the caller is the trusted operator, not a student, so none of `find-group`'s privacy masking applies. A non-`service_role` token gets a `403`; a pool below `min_pool` returns `ran: false` with a reason and forms nothing. Re-running is self-healing: students just grouped drop out of the next pool, so a second run only regroups whoever is still waiting.

### The client screens

`app/(app)/groups/` holds the Stage 2 UI: the list of your groups, create, browse (`discover`), matching (`match`), invitations, how you get matched (`matching`), a group detail screen, and invite-a-student. `src/lib/groups.ts` is one typed wrapper per RPC; `src/lib/groupRules.ts` holds the status vocabulary, capacity phrasing and can-I-do-this predicates the screens share, unit-tested against the SQL rules they mirror.

**"How you get matched" is per course, not per student**, because `matching_pref` is a column on `user_courses` (`0007`): a student may want placing on the course they are struggling with and left alone on the one where they already have friends. The setting changes what a *batch matching run* does and nothing else — suggestions, browsing, requests and invitations work identically either way, and the hints say so, because "opt out" otherwise reads as "opt out of study groups". The screen also mirrors the run's own pool exclusion (`inMatchingPool`), so a course you are opted in on but already grouped on says it will be passed over rather than quietly doing nothing.

**Migration `0010` exists because of a name-resolution gap.** Stage 1's RLS on `users` is own-row only, which is the right default — a student must not be able to enumerate the student body. Stage 2's policies let a member read `group_members` (ids and roles) and their own invitations, but not the *names* behind those ids, so the roster and invitation screens had nothing to render. Widening the `users` policy would have fixed the screens and broken the privacy posture. Instead `0010` follows the precedent `search_students` already set: four SECURITY DEFINER `stable` reads, each gated on an explicit membership check, each returning **name and department only** — `group_members_detail`, `group_common_availability`, `my_invitations`, `group_join_requests`.

**Migration `0011` closes an enrolment gap the client could not have caused.** `create_group`, `request_to_join` and `send_invitation` never checked that the course being acted on was one the student is actually enrolled in, so a student enrolled only in BIO 201 could create a group on CSC 201 and ask to join one — confirmed live before the fix. Every screen takes its course id from the student's own enrolments, so the app never reached those states, but the RPCs are the real boundary and the damage was not cosmetic: because the shared-time tally joins members to `user_courses` on the group's course, a member who was never enrolled was dropped from it altogether, so "when you can all meet" quietly answered for a subset of the roster while presenting itself as the whole group's answer. `0011` adds one `is_enrolled(user_id, course_id)` helper (SECURITY DEFINER, `stable`, revoked from `anon`) and calls it from the three paths that *insert* a membership — `create_group`, `respond_join_request`, `respond_invitation` — plus the two that *promise* one, `request_to_join` and `send_invitation`. Checking at the moment of insert as well as the moment of asking is deliberate: a student can drop the course between requesting and being approved. Declining an invitation or a request is never gated — refusing someone should not depend on your enrolments. `discover_groups` is left ungated on purpose, since browsing what exists on a course is how a student decides to enrol.

**Migration `0012` makes "when you can all meet" mean *all* of you while a group is small.** `0010` marked a slot as shared when at least half the members were free then (`free >= ceil(n/2)`), which is right for a group of six — insisting on unanimity there usually returns nothing — and wrong for a group of two, where the threshold works out to 1 and the heading ends up describing a *union*. Measured live before the fix, with two members free at `1100110011001100110000000000` and `1100000011000000110011110000`, the group's grid came back `1100110011001100110011110000`: every slot either of them could make, presented as the time they can meet. Since every group begins at one or two members, that was the first thing most students would have read. `0012` sets the threshold to `n` at three members or fewer and keeps `ceil(n/2)` from four up. The step at four is deliberate rather than a smooth curve: two or three people can genuinely all show up, and a fourth is where holding out for unanimity starts costing the group more meetings than it saves. The RPC now returns `members_counted` and `meet_threshold` alongside the mask, and the screen names the rule it was given — "6 slots where all 2 of you are free" against "4 slots where at least 3 of 5 are free" — because the count the SQL divides by is the members enrolled in the *group's course*, which is smaller than the roster when someone has dropped it, so the client cannot re-derive the threshold from what it can see. The TypeScript scorer deliberately did **not** change with it: an intersection there would score most young groups 0 on schedule overlap and bury exactly the groups that need members. It was called `groupCommonAvailability` too, which made a rule difference look like drift, so it is now `groupScheduleProfile` in `src/lib/availability.ts` — different question, different name, and a unit test that fails if someone "fixes" it into agreeing with the SQL.

 Asking to join, answering an invitation, approving a request, renaming, toggling discoverability, archiving, removing a member, inviting and matching are online-only, and the screens say so rather than silently queueing. An action that hands out one of a finite number of seats, or that another person has to answer, cannot honestly be promised for later. Create and leave are safe because the group id is generated on the device, so the optimistic card and the eventual row share one id. `matching.pref` is safe on the opposite reasoning: it hands out no seat, nobody has to answer it, and it only takes effect the next time an operator runs batch matching — so a change that lands minutes later is honoured in full.

**Verified against the live project, 2026-09-05.** Every Stage 2 RPC was driven with two throwaway accounts over PostgREST using real user JWTs — the same wire supabase-js uses, so argument names, return shapes, table grants and RLS were all under test. Both pathways end to end, the creator-only refusals, an idempotent replay of `create_group`, disband-on-empty, both hooks' embedded selects, and `find-group`'s first real caller all behaved as written. `0011` was then verified the same way: each of the five gates refused with its own message, a refused `create_group` left no `groups` row behind (the raise rolls the ledger claim back with it), approving a requester who had since dropped the course and accepting an invitation after dropping were both refused while *declining* still worked, and `anon` cannot call `is_enrolled` at all. `set_matching_pref` was checked for the property its offline queueing rests on — a replay under the same `p_client_action_id` is a no-op even with the opposite value, a fresh id applies, and an invalid preference raises without leaving a ledger row, so a retry is possible. `0012` was verified on a four-member group built one member at a time, with the member masks chosen so each threshold produces a different answer: at two members the mask is now the intersection `1100000011000000110000000000` where `0010` returned the union, three members requires all three, the fourth restores the majority (threshold 2), a member who drops the course stops being counted at all (`members_counted` 3 of a roster of 4, threshold 3), a group with no enrolled members returns an empty mask with both numbers 0, and `anon` gets `401` / `42501 permission denied for function` rather than a mask. All test rows and users were deleted afterwards. **Still unverified: the UI itself** — no Stage 2 screen has been touched by a finger, and the offline queue has not drained on a real phone. `HANDOFF.md` §7 has the walkthrough.

## Layout

```
app/                      expo-router routes
  _layout.tsx             providers + auth route guard
  (auth)/                 login, signup
  (onboarding)/           profile → courses → availability
  (app)/                  home, profile, courses
    groups/               list, create, discover, match, matching,
                          invitations, [groupId]/ detail + invite
src/
  components/             Button, TextField, Screen, AvailabilityGrid,
                          OfflineBanner, CourseChips, StatusPill
  context/                AuthContext, NetworkContext
  hooks/                  useCourses, useUserCourses, useMyGroups, useDiscover,
                          useGroupDetail, useInvitations
  lib/
    supabase.ts           client + error mapping
    availability.ts       bitmask encoding, overlap scoring, group common grid
    matching.ts           compatibility scoring (mirrored to the Edge Function)
    groups.ts             typed wrappers over the Stage 2 RPCs
    groupRules.ts         shared group vocabulary + permission predicates
    ids.ts                client action ids for the offline ledger
    cache.ts              offline read cache
    outbox.ts             offline write queue
    validation.ts         form rules
    __tests__/            unit tests (incl. mirror-drift guard)
  types/
    database.ts           schema types (Stage 1 + Stage 2 tables)
    matching.ts           find-group + batch-matching response contracts
supabase/
  migrations/             schema + RLS + RPCs (0001–0012)
  seed/                   placeholder courses
  functions/
    _shared/              mirrored availability.ts + matching.ts
    find-group/           Pathway One matching Edge Function
    run-batch-matching/   admin-initiated batch matching Edge Function
```

## Decisions worth knowing

**Matching is by course and availability.** Course is the grouping key — only students enrolled in the same course are ever compared — and the weekly availability grid is the compatibility signal. There is no separate "topics" concept: the course *is* the subject.

**Availability is a 7×4 grid stored as `bit(28)`.** Overlap is `bit_count(a & b)`, one cheap operation per candidate. Bit index is `day * 4 + slot`, bit 0 leftmost. The TypeScript in `src/lib/availability.ts` and the SQL `availability_overlap()` must agree on this — change one, change both.

**Schedule overlap normalises against the more constrained student**, not against 28 slots. A student free only Monday morning who overlaps with someone free all week scores 1.0, because they can always meet. Dividing by 28 would score that 0.036 and effectively lock time-poor students out of good matches.

**Offline is full queue-and-sync**, per your call. Writes queue in AsyncStorage with a uuid that Postgres records in `applied_client_actions`; a replay whose response was lost hits a duplicate-key error, which the queue treats as success. This is what stops "save profile" on flaky wifi from creating duplicate rows. The queue is strictly FIFO and a permanent failure dead-letters rather than blocking the queue behind it.

**One availability grid applies to all courses** during onboarding. The schema stores it per enrolment, so per-course editing can be added later with no migration — but four grids during onboarding would blow the 5-minute target on its own.

## Schema additions beyond the original spec

Found during spec review; the feature logic requires them:

- unique `(user_id, course_id)` on `user_courses`
- `device_push_tokens` — Expo cannot deliver a push without a stored token per device
- `applied_client_actions` — idempotency ledger for offline replay
- `users.onboarding_complete` — gates routing; computing it on every read would mean three queries before the router can decide anything

`invitations` and `join_requests`, plus `groups.is_discoverable` / `last_activity_at` / `max_members`, were the same kind of find for Stage 2 — all added in `0004`.

## Known gaps at this stage

Availability edits apply to every enrolled course at once. Intentional for now, per above.

**Migrations `0010` and `0012` still name a function that no longer exists.** Their comments point at `groupCommonAvailability()` in `src/lib/availability.ts`, which is now `groupScheduleProfile`. Applied migrations are never rewritten — the same reason `0001`–`0008` still reference the topics tables that `0009` dropped — so the stale name is the documented cost of forward-only history, not an oversight.

**Closed since the first draft of this file:** the enrolment gap in the write RPCs (`0011`), the shared-time rule that called two people a majority of two (`0012`), the missing `set_matching_pref` screen (`app/(app)/groups/matching.tsx`), and the two functions that shared a name while applying different rules (the TS scorer is now `groupScheduleProfile`) — all described in the Stage 2 section.

## Before Stage 3

Two things worth knowing now rather than later:

**Supabase pauses free projects after about a week of inactivity.** Fine during the build, but during a two-week pilot a quiet weekend could pause the project mid-pilot. Open the dashboard periodically, or plan to upgrade for the pilot window.

**Expo Go on Android dropped remote push notification support in SDK 53.** Stages 1–4 test fine in Expo Go. Stage 5 will need an EAS dev build on your phone. Nothing to do about it now, but it is not a surprise you want at Stage 5.

Two of the three cross-stage questions Stage 1 left open are still open: `Sessions` has no roadmap stage despite the Active lifecycle state and all time-based notifications depending on it (I would slot it after Materials), and Stage 4's "upload fires a notification" needs Stage 4 writing `Notifications` rows with Stage 5 adding delivery on top. The third is settled — `0005` added the `is_group_member` / `is_group_creator` SECURITY DEFINER helpers, so no `group_members` policy queries its own table.
