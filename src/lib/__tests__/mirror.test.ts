import { readFileSync } from 'fs';
import { join } from 'path';

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
