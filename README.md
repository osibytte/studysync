# StudySync — Accounts, Groups, the Group Timeline, Shared Files, and Study Alarms

Study-partner matching for University of Ibadan students. React Native (Expo) + Supabase.

Four of a five-stage build are complete, and the fifth is half done. A student can register, sign in, set their name and department, pick the courses they want a study group for, rate how well they understand each one, and set a weekly availability grid (**Stage 1**). They can apply to be matched while the registration window is open, browse the open groups on their courses, create their own, invite people, and answer invitations and join requests (**Stage 2**). Inside a group there is a timeline: chat, plus study times proposed, agreed and cancelled in it (**Stage 3**), and files shared from the same timeline into a private bucket, with their own tab (**Stage 4**). And the phone now rings **30 minutes before a study time the group agreed on**, from the OS rather than a server, so it works with no signal and the app closed (**Stage 5**, its local half).

What is left of Stage 5 is everything with a server in it: the notification ledger, a preferences screen and in-app inbox, and remote push for chat, file and invitation activity — that last part is the only thing in the project needing an EAS development build.

Profile edits, creating a group, leaving a group, rating a course, sending a message, proposing a study time and answering one all work offline and sync when the connection returns. Applying to be matched is deliberately online-only, for the reason given under [Stage 2](#stage-2--group-formation). `HANDOFF.md` is the full engineering record; this file is orientation and setup.

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

Supabase dashboard → SQL Editor → New query. Run every file **in numerical order**, each as a separate query — the first three being:

1. `supabase/migrations/0001_stage1_schema.sql` — tables, triggers, the overlap function
2. `supabase/migrations/0002_stage1_rls.sql` — row level security policies
3. `supabase/seed/0003_seed_courses.sql` — placeholder courses

…then `0004` through `0020` from `supabase/migrations/`. The seed took the number `0003`, so the migrations skip it; nothing is missing.

Order matters throughout, and migrations are **forward-only** — an applied file is never edited, which is why a few of them still carry comments naming things a later one dropped or renamed. `0002` adds policies to tables `0001` creates and the seed inserts into them; `0005` adds policies to `0004`'s tables; `0018` fixes a gap in `0017`'s Storage policies. Filenames record when a file was written rather than which stage owns it, so `0017_stage3_materials.sql` and `0018_stage3_storage_readback.sql` are in fact Stage 4's backend.

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

472 tests in 8 suites. The availability bitmask (encode/decode round-trip, day/slot bit layout, overlap counting, the zero-overlap edge case the spec names), profile validation, the compatibility scorer and its proficiency term, the registration-window and apply-to-be-matched rules, the group vocabulary, the chat and materials rules, and the notification rules. The bit-layout tests are the important ones: if the TypeScript and SQL disagree about which bit is which, matching silently compares the wrong slots and nothing throws.

**A green suite cannot see a bundling failure**, because `jest-expo` resolves modules through its own preset and never reads `metro.config.js` — which is how this project once had 325 passing tests and an app that would not bundle on either platform. `HANDOFF.md` §4 has the four-part health check, including how to ask Metro for each platform's bundle directly.

```bash
npm run typecheck
```

### Manual walkthrough

Time yourself against the 5-minute onboarding target:

1. Create an account
2. Enter name and department
3. Pick two or three courses, and rate each one — onboarding will not continue until every picked course has a band
4. Set availability — tap a day name to fill the whole column
5. Land on home and confirm it reflects your courses and availability

Then, for the later stages: apply to be matched on a course (needs an open registration window — see Stage 2 below), open a group, send a message, propose a study time **at least 31 minutes out**, answer *yes* (the one tap that asks for notification permission), and share a file. `HANDOFF.md` §7 walks each of these as a numbered pathway, including what is still unproven on a real device.

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

The database layer is complete — migrations `0004`–`0007` add the group tables, SELECT-only RLS, the SECURITY DEFINER write RPCs (all group mutations go through these, never a direct client write), a daily `pg_cron` lifecycle sweep, and the batch-matching pool column plus its operator write path (`0007`, described below). `0009` then removed topics, `0010` added the four read RPCs the client screens need, `0011` added the course-enrolment gate to the five write paths that hand out or promise a membership, `0012` made the shared-time answer require every member while a group is small, and `0020` added the self-rated proficiency band, the apply-to-be-matched pool and the registration window that gates it (retiring `0007`'s `matching_pref`). Run them in order after Stage 1's `0001`–`0003`.

The compatibility score is a weighted sum, normalised to `[0, 1]`:

```
score = 0.65 · scheduleOverlap + 0.25 · proficiencyMix + 0.10 · groupFillBonus
```

Matching is by **course + availability + self-rated proficiency**: course is the grouping key (only students enrolled in the same course are ever compared), and schedule overlap is still the dominant signal — you have to actually be able to meet — with the students' own understanding of the course as a second term and a small nudge toward filling a near-complete group. Schedule overlap normalises against the *more constrained* side, not the maximum, so a time-poor student is not punished for it. See `src/lib/matching.ts`.

**The proficiency term rewards a mix, not a match.** One band apart scores 1.0, identical bands 0.5, and the extremes (struggling with fairly confident) 0.75 — so a group where somebody can explain and somebody needs the explanation beats a room of people equally stuck, while the widest gap is discouraged rather than forbidden. It is a term and not a filter: it can never drag a score below `0.125`, so a promising mix cannot rescue a group that can never meet, and an unrated legacy enrolment falls back to the middle band and ranks on schedule alone. A separate whole-group rule, `isolatedByProficiency`, catches the one shape no pairwise term can see — a single student at one extreme with nobody in the middle band to bridge to — and `partitionIntoGroups` tries one swap to fix it before letting the group stand.

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

**Who's in the pool.** Every student who has *applied* on that course — `user_courses.applied_at is not null` — minus anyone already in a group on it. Nothing puts a student in the pool on their behalf: `0020` retired `0007`'s opt-out `matching_pref` in favour of an explicit application from the "Apply to be matched" screen, which only works while a registration window is open. Being matched is not stored anywhere, it is derived from group membership — so leaving a system-formed group returns the student to the pool for the next run — and `applied_at` is never cleared, because an application cannot be withdrawn.

> ⚠️ **The deployed copy of this function still filters on `matching_pref`.** It must be redeployed from the branch that carries `0020`, once `0020` is applied, or a run will find an empty pool.

**How it groups.** Group size is a random target of 3–6, per the product decision. Two rules keep the tail humane: a remainder of 2–6 becomes one final group (a pair is allowed), and a target that would strand exactly one student is shrunk by one. So any pool of ≥ 2 is fully grouped, and only a lone student (a pool of exactly one) comes back in `waiting`, to be picked up on the next run. Each formed group is then checked for a single student stranded at one proficiency extreme, and one swap is attempted before it is accepted (above). Each group is written through the `create_system_group` RPC (`0007`, extended by `0020`) — service-role-only, the sole write path, mirroring how the client's own mutations go through definer RPCs — which also composes each new member's `group_matched` notification in SQL, inside the same transaction that creates the group.

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

`app/(app)/groups/` holds the Stage 2 UI: the list of your groups, create, browse (`discover`), suggestions (`match`), invitations, apply to be matched (`matching`), a group detail screen, and invite-a-student. `src/lib/groups.ts` is one typed wrapper per RPC; `src/lib/groupRules.ts` holds the status vocabulary, capacity phrasing, the proficiency and registration-window wording, and the can-I-do-this predicates the screens share, unit-tested against the SQL rules they mirror.

**"Apply to be matched" is per course, not per student**, because the pool is a column on `user_courses` (`applied_at`, `0020`): a student may want placing on the course they are struggling with and left alone on the one where they already have friends. The screen resolves each enrolment to one of five steps — grouped, applied, needs a rating, needs free time, ready — and shows only that step's sentence, so there is never a disabled button without the reason next to it. Two properties are worth knowing before you test it. **An application cannot be withdrawn**, including by dropping the course: a trigger in `0020` refuses to delete an applied enrolment, and the button says so before the tap. And **being matched is derived, not stored** — leaving a system-formed group puts you back in the pool with nothing to re-submit.

**The registration window gates that one button and nothing else.** `matching_windows` (`0020`) holds one global period an operator opens and closes with service-role RPCs; students read it through `matching_window_state()`, which returns the *server's* clock alongside the window, because a phone whose clock is a day out would otherwise read an open deadline as "Yesterday" under a live button. When no period is scheduled the banner says what still works — browse, ask to join, wait to be invited — since a closed window is not a closed app.

**Applying is online-only, and it is the one action where that is not a convenience call.** `request_matching`'s answer depends on whether a window is open *at the moment it runs*. An application queued while the window was open and replayed after it shut would be refused, with the student already told they were in the pool, no way to withdraw, and no screen left to correct it. Rating a course is the deliberate contrast and *is* queued: a private, last-write-wins field on the student's own row that nothing reads until a run happens.

**Migration `0010` exists because of a name-resolution gap.** Stage 1's RLS on `users` is own-row only, which is the right default — a student must not be able to enumerate the student body. Stage 2's policies let a member read `group_members` (ids and roles) and their own invitations, but not the *names* behind those ids, so the roster and invitation screens had nothing to render. Widening the `users` policy would have fixed the screens and broken the privacy posture. Instead `0010` follows the precedent `search_students` already set: four SECURITY DEFINER `stable` reads, each gated on an explicit membership check, each returning **name and department only** — `group_members_detail`, `group_common_availability`, `my_invitations`, `group_join_requests`.

**Migration `0011` closes an enrolment gap the client could not have caused.** `create_group`, `request_to_join` and `send_invitation` never checked that the course being acted on was one the student is actually enrolled in, so a student enrolled only in BIO 201 could create a group on CSC 201 and ask to join one — confirmed live before the fix. Every screen takes its course id from the student's own enrolments, so the app never reached those states, but the RPCs are the real boundary and the damage was not cosmetic: because the shared-time tally joins members to `user_courses` on the group's course, a member who was never enrolled was dropped from it altogether, so "when you can all meet" quietly answered for a subset of the roster while presenting itself as the whole group's answer. `0011` adds one `is_enrolled(user_id, course_id)` helper (SECURITY DEFINER, `stable`, revoked from `anon`) and calls it from the three paths that *insert* a membership — `create_group`, `respond_join_request`, `respond_invitation` — plus the two that *promise* one, `request_to_join` and `send_invitation`. Checking at the moment of insert as well as the moment of asking is deliberate: a student can drop the course between requesting and being approved. Declining an invitation or a request is never gated — refusing someone should not depend on your enrolments. `discover_groups` is left ungated on purpose, since browsing what exists on a course is how a student decides to enrol.

**Migration `0012` makes "when you can all meet" mean *all* of you while a group is small.** `0010` marked a slot as shared when at least half the members were free then (`free >= ceil(n/2)`), which is right for a group of six — insisting on unanimity there usually returns nothing — and wrong for a group of two, where the threshold works out to 1 and the heading ends up describing a *union*. Measured live before the fix, with two members free at `1100110011001100110000000000` and `1100000011000000110011110000`, the group's grid came back `1100110011001100110011110000`: every slot either of them could make, presented as the time they can meet. Since every group begins at one or two members, that was the first thing most students would have read. `0012` sets the threshold to `n` at three members or fewer and keeps `ceil(n/2)` from four up. The step at four is deliberate rather than a smooth curve: two or three people can genuinely all show up, and a fourth is where holding out for unanimity starts costing the group more meetings than it saves. The RPC now returns `members_counted` and `meet_threshold` alongside the mask, and the screen names the rule it was given — "6 slots where all 2 of you are free" against "4 slots where at least 3 of 5 are free" — because the count the SQL divides by is the members enrolled in the *group's course*, which is smaller than the roster when someone has dropped it, so the client cannot re-derive the threshold from what it can see. The TypeScript scorer deliberately did **not** change with it: an intersection there would score most young groups 0 on schedule overlap and bury exactly the groups that need members. It was called `groupCommonAvailability` too, which made a rule difference look like drift, so it is now `groupScheduleProfile` in `src/lib/availability.ts` — different question, different name, and a unit test that fails if someone "fixes" it into agreeing with the SQL.

 Asking to join, answering an invitation, approving a request, renaming, toggling discoverability, archiving, removing a member, inviting, applying to be matched and browsing suggestions are online-only, and the screens say so rather than silently queueing. An action that hands out one of a finite number of seats, or that another person has to answer, cannot honestly be promised for later. Create and leave are safe because the group id is generated on the device, so the optimistic card and the eventual row share one id. `course.proficiency` is safe on the opposite reasoning: it hands out no seat, nobody has to answer it, and nothing reads it until a matching run happens — so a rating that lands minutes later is honoured in full.

**Verified against the live project, 2026-09-05.** Every Stage 2 RPC was driven with two throwaway accounts over PostgREST using real user JWTs — the same wire supabase-js uses, so argument names, return shapes, table grants and RLS were all under test. Both pathways end to end, the creator-only refusals, an idempotent replay of `create_group`, disband-on-empty, both hooks' embedded selects, and `find-group`'s first real caller all behaved as written. `0011` was then verified the same way: each of the five gates refused with its own message, a refused `create_group` left no `groups` row behind (the raise rolls the ledger claim back with it), approving a requester who had since dropped the course and accepting an invitation after dropping were both refused while *declining* still worked, and `anon` cannot call `is_enrolled` at all. `set_matching_pref` was checked for the property its offline queueing rests on — a replay under the same `p_client_action_id` is a no-op even with the opposite value, a fresh id applies, and an invalid preference raises without leaving a ledger row, so a retry is possible. (**That RPC no longer exists.** `0020` dropped it along with `matching_pref`; the queued action it backed is now `course.proficiency`, and nothing in `0020` has been verified live yet, because it has not been applied.) `0012` was verified on a four-member group built one member at a time, with the member masks chosen so each threshold produces a different answer: at two members the mask is now the intersection `1100000011000000110000000000` where `0010` returned the union, three members requires all three, the fourth restores the majority (threshold 2), a member who drops the course stops being counted at all (`members_counted` 3 of a roster of 4, threshold 3), a group with no enrolled members returns an empty mask with both numbers 0, and `anon` gets `401` / `42501 permission denied for function` rather than a mask. All test rows and users were deleted afterwards. **The UI has since been driven on a real iPhone (2026-09-05):** sign-in, onboarding, group creation and chat all behaved. **What a finger still has not touched:** sharing a file (the multipart upload has been read but never run), Realtime between two phones, the offline queue draining after a genuine disconnect, and the 30-minute alarm firing in airplane mode. `HANDOFF.md` §7 has a numbered walkthrough for each.

## Stage 3 — the group timeline

A group has one screen where things happen: `app/(app)/groups/[groupId]/chat.tsx`. Messages and study times share it, ordered together, because a proposal is something the group says to each other — splitting them into a "chat" tab and a "schedule" tab would hide the discussion that produced the plan.

**A study time is proposed in the timeline and answered there.** Anyone proposes a start, an end and an optional place; every member answers yes, no or maybe; the card shows the tally and, once enough people are in, the session flips to `confirmed`. Cancelling puts a cancellation in the timeline rather than making the card vanish, so a member who was offline can see what happened and why. `src/lib/chatRules.ts` holds the parts worth testing on their own — how consecutive messages from one person group into a block, where day dividers fall, and the RSVP vocabulary the card renders — which is what lets the screen stay a thin renderer.

**Sending a message, proposing a study time and answering one all work offline**, queued in the same outbox on the same client-action-id idempotency as a profile edit — they are the three things a student does most, and each is safe to replay. **Cancelling** a session, **deleting** a message and **sharing a file** are online-only and say so on the button: cancelling and deleting change what other people are looking at, and a file upload has bytes to move.

**Realtime's live edge is deliberately narrow.** Only `messages` is subscribed to. Study times and files are read through SECURITY DEFINER RPCs that join in the proposer's name, the uploader's name, the yes-tally and the threshold a card renders — none of which travels on a replicated row — so a card built from the raw row would be missing most of its own text. A new message therefore arrives live, and when it is a session or file message the hook refetches the lists behind it. Something that changes with no message attached, like another member answering a study time, is caught on the next focus instead.

## Stage 4 — shared files

Files are shared from the timeline, so a lecture slide arrives in the conversation it belongs to, and they collect in their own tab (`[groupId]/files.tsx`) for the times you are looking for a file rather than reading back. There is no separate materials module: a shared file **is** a timeline entry, so `src/lib/chat.ts` carries the Storage work alongside messages and sessions, and `src/lib/chatRules.ts` holds the upload rules (`validateUpload`, `fileKind`, `formatFileSize`, `materialStoragePath`) next to the message and session rules. `src/lib/filePicker.ts` is the one piece that is genuinely its own concern — getting a file off the device.

**The bucket is private.** Nothing is served by a public URL; every read goes through a signed URL minted for that member at that moment, and the Storage policies check group membership rather than trusting the path. A private bucket plus signed reads is the only arrangement where leaving a group actually revokes access to the group's files.

## Stage 5 — notifications and the study alarm

Half of this stage is built and needs no development build; the other half needs one. The split is not arbitrary — it is the local/remote line described under [Before the pilot](#before-the-pilot).

**Built: the 30-minute alarm.** When a group confirms a study time, this phone asks the OS to wake it 30 minutes before the start. Because the OS holds the schedule, the alert arrives with no signal, with the app force-closed, and after a reboot. `src/lib/notificationRules.ts` decides which alarms are owed (a pure module, 104 tests), `src/lib/notifier.ts` is the only file allowed to talk to `expo-notifications`, and `src/lib/reminders.ts` reconciles the two — re-running whenever the app comes to the foreground, comes online, or finishes draining its outbox, so cancelling a session clears its alarm.

The rule most likely to look like a bug: **a session must start at least 31 minutes from now to get an alarm** (a 30-minute lead plus a 60-second floor). Propose something 20 minutes out and nothing is scheduled, by design. And the permission prompt appears at exactly one moment — the tap that answers *yes* to a study time — because that is the one point where a student has just said they intend to be somewhere.

**Built, and the reason the sender is safe to run twice:** `0019_stage5_notifications.sql`, the delivery ledger. It stores a row per thing a student was *told*, not per thing that happened, because you cannot enforce the `daily_cap` they set without counting deliveries — and "have we already said this?" is not answerable from the messages, files and sessions themselves. A unique `(user_id, dedupe_key)` index turns a retried or double-invoked run into a conflict the writer swallows instead of a second banner, and bucketing a period into that key is also how "at most once per fortnight" works with no cooldown table anywhere. Chat is watermarked rather than row-per-message: one digest row per group per run ("4 new messages in BIO 201"), so the table grows with how often the sender runs and not with how chatty a group is. The 30-minute alarm writes nothing here, deliberately — a phone in airplane mode could not, which is the whole point of it being local.

`0020` then added the one notification kind composed entirely in SQL: **`group_matched`**, written by `create_system_group` inside the transaction that forms the group. It is there because being placed in a study group is the one thing a student is *waiting* to hear, and it happens while the app is closed — an operator runs the batch, not the student. Everything else is composed in TypeScript, which is why `group_matched` is the one kind with no arm in `subjectFor`.

**Not built yet:** a preferences screen and in-app inbox over that ledger, then remote push for chat, file, session and invitation activity — plus the four study nudges (a study time one yes short, a slot the whole group is free, a group gone quiet, an invitation never answered). Every one of those is capped, quiet-hours-silenced and individually switchable, and **none is ever urgent**: a nudge that ignores a student's stated limit is how notifications get switched off at the OS level, taking the study alarm they actually wanted with them. The remote half is what the EAS development build is for.

## Layout

```
app/                      expo-router routes
  _layout.tsx             providers + auth route guard
  (auth)/                 login, signup
  (onboarding)/           profile → courses → availability
  (app)/                  home, profile, courses
    groups/               list, create, discover, match, matching,
                          invitations, [groupId]/ detail + invite,
                          [groupId]/chat (timeline), [groupId]/files
src/
  components/             Button, TextField, Screen, AvailabilityGrid,
                          OfflineBanner, CourseChips, StatusPill, StepHeader,
                          MessageBubble, SessionCard, ProposeTimeSheet,
                          FileCard, Composer
  context/                AuthContext, NetworkContext
  hooks/                  useCourses, useUserCourses, useMyGroups, useDiscover,
                          useGroupDetail, useInvitations, useMatchingWindow,
                          useMessages, useSessionAttendees, useMaterials,
                          useUnread, useReminders
  lib/
    supabase.ts           client + error mapping
    availability.ts       bitmask encoding, overlap scoring, group common grid
    matching.ts           compatibility scoring (mirrored to the Edge Function)
    groups.ts             typed wrappers over the Stage 2 RPCs
    groupRules.ts         shared group vocabulary + permission predicates
    chat.ts               messages, study times, RSVPs, shared files,
                          Realtime subscribe — the whole timeline's network layer
    chatRules.ts          timeline grouping, day dividers, RSVP vocabulary,
                          proposal validation, upload + file-kind rules (pure)
    filePicker.ts         getting a file off the device
    notificationRules.ts  which alarms are owed, and when (pure)
    notifier.ts           the ONLY file that may touch expo-notifications
    reminders.ts          fetch → remember → reconcile with the OS
    ids.ts                client action ids for the offline ledger
    cache.ts              offline read cache
    outbox.ts             offline write queue
    validation.ts         form rules
    __tests__/            unit tests (incl. mirror-drift guard)
  types/
    database.ts           schema types (Stages 1–4 tables)
    matching.ts           find-group + batch-matching response contracts
supabase/
  migrations/             schema + RLS + RPCs (0001–0020; no 0003, that is the seed)
  seed/                   placeholder courses
  functions/
    _shared/              mirrored availability.ts + matching.ts
    find-group/           Pathway One matching Edge Function
    run-batch-matching/   admin-initiated batch matching Edge Function
```

`notifier.ts` being the single importer of `expo-notifications` is an invariant, not a convention — `HANDOFF.md` §6 invariant 9 says why, and §8 has the four-step crash it protects against.

## Decisions worth knowing

**Matching is by course, availability and a self-rated proficiency band.** Course is the grouping key — only students enrolled in the same course are ever compared — the weekly availability grid is the dominant compatibility signal, and the student's own answer to "how is this course going" is the second. There is no separate "topics" concept: the course *is* the subject.

**A student picks only the courses they want a study group for**, and nothing puts them in a matching pool on their behalf. They apply, per course, while a registration window is open, and then wait for the run — an application cannot be withdrawn, and the trigger in `0020` closes the back door of dropping the course to escape it. The window gates that one action and nothing else: with no period scheduled a student can still browse, ask to join, or be invited.

**The proficiency band is three options, not a number.** "Struggling", "Getting by", "Fairly confident" (stored 1/2/3). A 1–10 scale invites false precision on a self-assessment, and the scorer only ever reasons about the *gap* between two answers, which needs bands rather than points. It is private — a footnote on the picker says so — because a rating other students could read would be answered strategically rather than honestly.

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

**`0019` and `0020` are written but not yet applied to the live project.** Everything in the repo compiles and passes against them; the database does not have them. Run `supabase db push` (or paste them into the SQL editor in order) before testing the notification ledger, the proficiency band, applying to be matched, or the registration window — and redeploy `run-batch-matching` afterwards, since the deployed copy still reads the pool column `0020` retires.

Availability edits apply to every enrolled course at once. Intentional for now, per above.

**Migrations `0010` and `0012` still name a function that no longer exists.** Their comments point at `groupCommonAvailability()` in `src/lib/availability.ts`, which is now `groupScheduleProfile`. Applied migrations are never rewritten — the same reason `0001`–`0008` still reference the topics tables that `0009` dropped — so the stale name is the documented cost of forward-only history, not an oversight.

**Closed since the first draft of this file:** the enrolment gap in the write RPCs (`0011`), the shared-time rule that called two people a majority of two (`0012`), and the two functions that shared a name while applying different rules (the TS scorer is now `groupScheduleProfile`) — all described in the Stage 2 section. The "how you get matched" screen that once filled `app/(app)/groups/matching.tsx` is gone rather than fixed: `0020` replaced the opt-out preference behind it with an explicit application, and that route is now "Apply to be matched".

## Before the pilot

**Supabase pauses free projects after about a week of inactivity.** Fine during the build, but during a two-week pilot a quiet weekend could pause the project mid-pilot. Open the dashboard periodically, or plan to upgrade for the pilot window.

**Expo Go on Android dropped *remote* push in SDK 53 — but not local notifications.** This distinction decides how much of Stage 5 you can test today, so it is worth holding onto. A notification the OS schedules on the device (`scheduleNotificationAsync` with a date trigger) works in Expo Go on both platforms, which is why the 30-minute study alarm is finished and testable **now**, with no build. A notification a server sends does not, on Android, and importing `expo-notifications` carelessly in Expo Go on Android **throws at module scope rather than warning** — hence `notifier.ts`. Only the remote half — chat, file and invitation push — needs an EAS development build.

**The 30-minute alarm rings at alarm volume, not with an alarm ringtone.** Android exposes the audio stream through the notification channel, so the reminder is as loud as an alarm; the *tone* is still the notification tone until a sound file is bundled, which needs a dev build. On iOS, a phone whose ringer switch is off shows a silent banner — only Apple's critical-alerts entitlement overrides the mute switch, and it is granted by individual application. Both limits are deliberate and recorded in `HANDOFF.md` §8.

All three cross-stage questions Stage 1 left open are now settled. Study times never became their own stage: they live inside the group timeline, proposed and agreed in chat (Stage 3), which is where a group actually decides to meet. "Upload fires a notification" splits as planned — Stage 4 records the material, Stage 5 delivers on top. And `0005`'s `is_group_member` / `is_group_creator` SECURITY DEFINER helpers mean no `group_members` policy queries its own table.
