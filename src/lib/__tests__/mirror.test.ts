import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { MATERIALS_ALLOWED_MIME_TYPES } from '../chatRules';

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
    expect(claimed.size).toBeGreaterThanOrEqual(15);
    expect(selfLedgered.length).toBeGreaterThanOrEqual(6);
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
