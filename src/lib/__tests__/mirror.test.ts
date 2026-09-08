import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { MATERIALS_ALLOWED_MIME_TYPES } from '../chatRules';
import {
  NOTIFICATION_KIND_LABEL,
  NOTIFICATION_LOCAL,
  WITHHELD_REASONS,
  isRetryableWithholding,
} from '../notificationRules';
import type { NotificationKind } from '@/types/database';

/**
 * Mirror-drift guard.
 *
 * The compatibility scoring is deliberately duplicated: the app imports
 * src/lib/matching.ts, and the find-group Edge Function imports a hand-kept copy
 * at supabase/functions/_shared/matching.ts (the Deno tree can't reliably reach
 * up into src/). If the two ever disagree — a weight tweaked in one, a tie-break
 * changed in the other — matching would score differently on the client and the
 * server, and nothing would throw. The bug would look like "the app shows a
 * score the server disagrees with", which is miserable to track down.
 *
 * These tests make that divergence a failing build instead. Same precedent as
 * the availability.ts <-> SQL availability_overlap() "change one, change both"
 * rule the codebase already follows.
 */

const ROOT = join(__dirname, '..', '..', '..');

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

/** Extract the text between the two sentinel comments, inclusive of neither. */
function mirrorRegion(source: string, label: string): string {
  const start = source.indexOf('// === MIRROR START ===');
  const end = source.indexOf('// === MIRROR END ===');
  expect(start).toBeGreaterThanOrEqual(0); // sentinel present in ${label}
  expect(end).toBeGreaterThan(start);
  // Drop the START sentinel line itself; keep everything up to (not including)
  // the END sentinel. Normalise line endings so a CRLF/LF checkout difference
  // between the two files isn't reported as drift.
  const region = source.slice(start, end);
  return region.replace(/\r\n/g, '\n');
}

describe('scoring mirror: src/lib/matching.ts <-> supabase/functions/_shared/matching.ts', () => {
  it('has identical scoring logic in both copies', () => {
    const appCopy = read('src/lib/matching.ts');
    const edgeCopy = read('supabase/functions/_shared/matching.ts');

    const appRegion = mirrorRegion(appCopy, 'app matching.ts');
    const edgeRegion = mirrorRegion(edgeCopy, 'edge matching.ts');

    // The whole point: byte-for-byte identical between the sentinels.
    expect(edgeRegion).toBe(appRegion);
  });
});

describe('availability mirror: src/lib/availability.ts <-> supabase/functions/_shared/availability.ts', () => {
  it('is a byte-for-byte copy (that module is pure and import-free)', () => {
    const appCopy = read('src/lib/availability.ts').replace(/\r\n/g, '\n');
    const edgeCopy = read('supabase/functions/_shared/availability.ts').replace(/\r\n/g, '\n');
    expect(edgeCopy).toBe(appCopy);
  });
});

/**
 * Third mirror, same "change one, change both" rule, different pair.
 *
 * An RPC that begins with `claim_client_action(p_client_action_id, v_uid,
 * '<action>')` owns its own idempotency ledger. For those, outbox.ts must NOT
 * pre-insert the id — which is what `SELF_LEDGERED` is — because the RPC would
 * then see its own action as an already-applied replay and do nothing at all.
 *
 * Both directions of that agreement fail silently, which is why they are pinned
 * here rather than left to review:
 *
 *   - A name in SELF_LEDGERED that no RPC claims means nothing records the id,
 *     so a retry after a lost response applies the write twice.
 *   - A queued action whose RPC self-claims but which is missing from
 *     SELF_LEDGERED is worse: the pre-insert burns the id the RPC is about to
 *     look for, `claim_client_action` reports it used, and the RPC returns
 *     early. The message is never sent, and nothing errors.
 */
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

/** Every action name an RPC claims for itself, across all migrations. */
function sqlClaimedActions(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(MIGRATIONS)) {
    if (!file.endsWith('.sql')) continue;
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    for (const match of sql.matchAll(
      /claim_client_action\([^)]*?'([a-z]+\.[a-z]+)'\s*\)/g
    )) {
      names.add(match[1]);
    }
  }
  return names;
}

function outboxSource(): string {
  // Comments stripped: both regions below quote action names in prose, and a
  // name mentioned in a comment is not a name in the array.
  return read('src/lib/outbox.ts')
    .replace(/\r\n/g, '\n')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function actionNamesIn(region: string): string[] {
  return [...region.matchAll(/'([a-z]+\.[a-z]+)'/g)].map((m) => m[1]);
}

describe('outbox ledger mirror: SELF_LEDGERED <-> claim_client_action in the migrations', () => {
  const source = outboxSource();
  const claimed = sqlClaimedActions();

  const selfLedgered = (() => {
    const start = source.indexOf('const SELF_LEDGERED');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('];', start);
    expect(end).toBeGreaterThan(start);
    return actionNamesIn(source.slice(start, end));
  })();

  /** Every action applyAction knows how to replay. */
  const replayed = [...source.matchAll(/case '([a-z]+\.[a-z]+)':/g)].map((m) => m[1]);

  it('found both sides, so a rename cannot pass by emptying one of them', () => {
    // The SQL floor stays at 15 even though 0020 dropped set_matching_pref:
    // migrations are forward-only text, so 0007's claim of 'matching.pref' is
    // still in the files and still counted here. A name lingering in `claimed`
    // can only make the checks below more permissive, never wrongly fail them.
    //
    // The replay floor is back at 10 because that migration traded one queued
    // action for another: 'matching.pref' out, 'course.proficiency' in. Only the
    // second is queueable, and outbox.ts's header says why.
    expect(claimed.size).toBeGreaterThanOrEqual(15);
    expect(selfLedgered.length).toBeGreaterThanOrEqual(5);
    expect(replayed.length).toBeGreaterThanOrEqual(10);
  });

  it.each(selfLedgered)('%s is claimed by its own RPC in SQL', (action) => {
    expect([...claimed]).toContain(action);
  });

  it('lists every replayable action whose RPC claims the ledger itself', () => {
    const missing = replayed.filter(
      (action) => claimed.has(action) && !selfLedgered.includes(action)
    );
    expect(missing).toEqual([]);
  });

  it('replays every action it declares as self-ledgered', () => {
    // The reverse omission is harmless at runtime but means the list has grown a
    // name nothing sends — usually the residue of a renamed action.
    expect(selfLedgered.filter((action) => !replayed.includes(action))).toEqual([]);
  });
});

/**
 * Fourth mirror, and the one with the most expensive failure.
 *
 * The `group-materials` bucket carries an `allowed_mime_types` list (0017) and
 * Storage enforces it, so it is the true set of types an upload can succeed with.
 * `MATERIALS_ALLOWED_MIME_TYPES` is that list copied onto the device, where it
 * does two things the server cannot: it filters the document picker, and
 * `uploadMimeType` refuses anything outside it before a byte goes on the wire.
 *
 * Drift is silent in both directions and neither is cheap:
 *
 *   - A type on the device that the bucket does not allow is accepted by the
 *     picker, uploaded in full, and rejected at the end. On a student's mobile
 *     data that is the whole file paid for and nothing shared.
 *   - A type the bucket allows that the device is missing is a file that cannot
 *     be picked at all, and no error anywhere to explain why.
 */
function sqlBucketMimeTypes(): string[] {
  const sql = read('supabase/migrations/0017_stage3_materials.sql').replace(/\r\n/g, '\n');
  const insert = sql.indexOf('insert into storage.buckets');
  expect(insert).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('array[', insert);
  expect(open).toBeGreaterThan(insert);
  const close = sql.indexOf(']', open);
  expect(close).toBeGreaterThan(open);
  return [...sql.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('bucket mime mirror: MATERIALS_ALLOWED_MIME_TYPES <-> storage.buckets in 0017', () => {
  const fromSql = sqlBucketMimeTypes();

  it('found both sides, so an empty parse cannot pass for agreement', () => {
    expect(fromSql.length).toBeGreaterThanOrEqual(15);
    expect(MATERIALS_ALLOWED_MIME_TYPES.length).toBe(fromSql.length);
  });

  it('allows exactly the same types', () => {
    // Sorted, because the order in either place is arbitrary — Storage compares
    // membership, and the picker does not care either.
    expect([...MATERIALS_ALLOWED_MIME_TYPES].sort()).toEqual([...fromSql].sort());
  });
});

/**
 * Fifth mirror. The notification vocabulary, TypeScript against the CHECK in SQL.
 *
 * `0019` says it in its own comment — "These names are NOT chosen here … Change
 * one, change both" — and both directions fail without a stack trace:
 *
 *   - A kind added to the union and shipped in a sender that the CHECK has never
 *     heard of is a `23514` at insert time, inside a batch job the student cannot
 *     see. They are simply never told the thing happened.
 *   - A value added to the CHECK and not to the union is the milder half: no copy,
 *     no urgency, no cooldown, and `notificationContent` cannot render it — so the
 *     kind exists in the database and can never legally be produced.
 *
 * The expected list is derived rather than typed out a third time: every kind
 * `NOTIFICATION_LOCAL` does not mark as device-scheduled is, by definition, one a
 * server sends and therefore one the table must accept. That makes this test also
 * the guard on `session_reminder`'s absence, which 0019 insists on twice — mark a
 * kind local and it must leave the CHECK; unmark one and it must appear.
 *
 * IT READS THE LAST DEFINITION, NOT 0019's, because migrations are forward-only:
 * 0019 created this CHECK and 0020 replaced it to admit 'group_matched'. A test
 * pinned to the file that happened to introduce a constraint starts failing the
 * moment that constraint is legitimately widened, which teaches the next reader to
 * delete the test rather than to trust it.
 */
function sqlNotificationKinds(): string[] {
  let latest: string[] | null = null;
  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (!file.endsWith('.sql')) continue;
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8').replace(/\r\n/g, '\n');
    // `kind in (...)` is only ever written about this table — messages_kind_shape
    // (0016, 0017) ties each kind to a referent instead — but require the file to
    // be about notifications anyway, so a future table cannot quietly take over.
    if (!sql.includes('public.notifications')) continue;
    for (const match of sql.matchAll(/check \(kind in \(([^)]*)\)\)/g)) {
      latest = [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    }
  }
  expect(latest).not.toBeNull();
  return latest as string[];
}

describe('notification kind mirror: NotificationKind <-> the CHECK in SQL', () => {
  const fromSql = sqlNotificationKinds();
  const sentFromTs = (Object.keys(NOTIFICATION_KIND_LABEL) as NotificationKind[]).filter(
    (kind) => !NOTIFICATION_LOCAL[kind]
  );

  it('found both sides, so an empty parse cannot pass for agreement', () => {
    expect(fromSql.length).toBeGreaterThanOrEqual(10);
    expect(sentFromTs.length).toBe(fromSql.length);
  });

  it('accepts exactly the kinds a server sends', () => {
    expect([...fromSql].sort()).toEqual([...sentFromTs].sort());
  });

  it('keeps the device-scheduled alarm out of the table entirely', () => {
    // Not implied by the equality above in any way a reader can see at a glance,
    // and it is the one value 0019 argues about at length: a sender that pushed it
    // would give a student with a signal the alarm twice.
    expect(fromSql).not.toContain('session_reminder');
    expect(NOTIFICATION_LOCAL.session_reminder).toBe(true);
  });
});

/**
 * Sixth mirror. `WithheldReason` against `0021`'s CHECK on `notifications.withheld`.
 *
 * Same shape of bug as the fifth, and worse to notice. The sender decides a reason
 * in TypeScript and writes it in SQL, so a reason the CHECK has never heard of is a
 * `23514` — and it fires on the WITHHOLDING path, the one nobody watches, in a
 * scheduled function with no student waiting on the response. The visible symptom
 * would be that quiet hours stopped working, days later, for everyone.
 *
 * The other direction is the quieter half again: a value in the CHECK with no arm
 * in `NOTIFICATION_WITHHOLD_RETRYABLE` can be stored by hand and the sender has no
 * opinion on whether to retry it, so `isRetryableWithholding` would answer
 * `undefined === true` — false — and the row would be abandoned silently.
 *
 * `WithheldReason` is a type and types do not survive to runtime, so the expected
 * list comes from the retryable table's keys. That is the whole reason the table is
 * a `Record` and not an array of strings.
 */
function sqlWithheldReasons(): string[] {
  let latest: string[] | null = null;
  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (!file.endsWith('.sql')) continue;
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8').replace(/\r\n/g, '\n');
    if (!sql.includes('public.notifications')) continue;
    // Newlines allowed inside the parens: the CHECK is written across two lines in
    // 0021 and reformatting it must not silently empty this parse — which is what
    // the "found both sides" assertion below is there to catch if it ever does.
    for (const match of sql.matchAll(/withheld in \(([^)]*)\)/g)) {
      latest = [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    }
  }
  expect(latest).not.toBeNull();
  return latest as string[];
}

describe('withheld reason mirror: WithheldReason <-> the CHECK in SQL', () => {
  const fromSql = sqlWithheldReasons();

  it('found both sides, so an empty parse cannot pass for agreement', () => {
    expect(fromSql.length).toBe(4);
    expect(WITHHELD_REASONS.length).toBe(4);
  });

  it('accepts exactly the reasons the sender can decide', () => {
    expect([...fromSql].sort()).toEqual([...WITHHELD_REASONS].sort());
  });

  it('leaves exactly one of them retryable', () => {
    // The asymmetry 0021's header is built on. If a second reason ever becomes
    // retryable that is a real decision and this test should be changed by hand —
    // but it must not happen by someone flipping a boolean without reading why.
    const retryable = WITHHELD_REASONS.filter((r) => isRetryableWithholding(r));
    expect(retryable).toEqual(['quiet_hours']);
  });

  it('treats a row that was never withheld as pending, not retryable', () => {
    // `withheld is null` means the sender has not tried yet. Reading that as
    // "retry" would make every fresh row look like a second attempt.
    expect(isRetryableWithholding(null)).toBe(false);
  });
});
