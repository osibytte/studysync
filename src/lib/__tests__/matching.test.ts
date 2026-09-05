import {
  type Candidate,
  type PartitionMember,
  type ScoringProfile,
  WEIGHTS,
  compatibilityScore,
  groupFillBonus,
  partitionIntoGroups,
  rankCandidates,
  scoreBreakdown,
} from '../matching';
import { type AvailabilityGrid, emptyGrid } from '../availability';

/**
 * Matching is by course + availability. Course is the grouping key (only
 * same-course students are ever compared); availability is the compatibility
 * signal. The score is a weighted sum of two terms, both in [0, 1]:
 *
 *     score = 0.8 * scheduleOverlap + 0.2 * groupFillBonus
 *
 * These tests pin the intent:
 *
 *   1. zero schedule overlap — a candidate free at no shared time scores 0 on
 *      the schedule term (not NaN), and a fuller-but-never-free group must not
 *      outrank an open group you can actually meet. Schedule dominates fill.
 *   2. zero candidates — ranking an empty list returns [], the caller's cue to
 *      show the no-match fallback.
 *   3. the 0.8 / 0.2 weighting is applied exactly.
 *
 * This scoring is mirrored into supabase/functions/_shared/matching.ts. If you
 * change a formula here, change it there too — these tests only guard this copy.
 */

/** Build a 28-slot availability grid with the given flat bit indices set. */
function gridFrom(indices: number[]): AvailabilityGrid {
  const g = emptyGrid();
  for (const i of indices) g[i] = true;
  return g;
}

describe('groupFillBonus', () => {
  it('rewards a fuller group more than an emptier one', () => {
    expect(groupFillBonus(7, 8)).toBeGreaterThan(groupFillBonus(2, 8));
  });

  it('is the fullness fraction', () => {
    expect(groupFillBonus(2, 8)).toBeCloseTo(0.25, 10);
    expect(groupFillBonus(6, 8)).toBeCloseTo(0.75, 10);
  });

  it('is 0 for a full group (not joinable, nothing to prefer)', () => {
    expect(groupFillBonus(8, 8)).toBe(0);
    expect(groupFillBonus(9, 8)).toBe(0);
  });

  it('guards junk input', () => {
    expect(groupFillBonus(1, 0)).toBe(0);
    expect(groupFillBonus(0, 8)).toBe(0);
    expect(groupFillBonus(-1, 8)).toBe(0);
  });
});

describe('scoreBreakdown', () => {
  const requester: ScoringProfile = {
    availability: gridFrom([0, 1, 2, 3]), // free all Monday
  };

  it('applies the 0.8 / 0.2 weights exactly', () => {
    const candidate: Candidate = {
      availability: gridFrom([0, 1, 2, 3]), // scheduleScore 1
      memberCount: 4, // fillScore 4/8 = 0.5
      maxMembers: 8,
    };
    const b = scoreBreakdown(requester, candidate);
    expect(b.scheduleScore).toBe(1);
    expect(b.fillScore).toBeCloseTo(0.5, 10);
    expect(b.score).toBeCloseTo(WEIGHTS.schedule * 1 + WEIGHTS.fill * 0.5, 10);
  });

  it('reports the shared slot count for display', () => {
    const candidate: Candidate = {
      availability: gridFrom([0, 1, 9]),
      memberCount: 3,
      maxMembers: 8,
    };
    const b = scoreBreakdown(requester, candidate);
    expect(b.sharedSlots).toBe(2); // slots 0, 1
  });

  it('keeps the score within [0, 1]', () => {
    const candidate: Candidate = {
      availability: gridFrom([0, 1, 2, 3]),
      memberCount: 7,
      maxMembers: 8,
    };
    const score = compatibilityScore(requester, candidate);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('zero schedule overlap (spec edge case)', () => {
  const requester: ScoringProfile = {
    availability: gridFrom([0, 1, 2, 3]), // Monday
  };

  it('scores a zero-overlap candidate with the schedule term dropped, not NaN', () => {
    const noSchedule: Candidate = {
      availability: gridFrom([4, 5]), // Tuesday — no shared slot
      memberCount: 1,
      maxMembers: 8,
    };
    const b = scoreBreakdown(requester, noSchedule);
    expect(b.scheduleScore).toBe(0);
    expect(b.sharedSlots).toBe(0);
    // score is just the fill term
    expect(b.score).toBeCloseTo(WEIGHTS.fill * groupFillBonus(1, 8), 10);
  });

  it('does not let a full-but-never-free group outrank an open group you can meet', () => {
    const fullNoTime: Candidate = {
      availability: gridFrom([4, 5]), // zero overlap
      memberCount: 7, // nearly full -> strong fill bonus
      maxMembers: 8,
    };
    const openSharedTime: Candidate = {
      availability: gridFrom([0, 1]), // shares 2 slots -> scheduleScore 1.0
      memberCount: 1, // nearly empty -> weak fill bonus
      maxMembers: 8,
    };
    const ranked = rankCandidates(requester, [fullNoTime, openSharedTime]);
    // shared availability wins despite the other group being far fuller
    expect(ranked[0].availability).toEqual(openSharedTime.availability);
    expect(ranked[0].match.score).toBeGreaterThan(ranked[1].match.score);
  });
});

describe('rankCandidates', () => {
  const requester: ScoringProfile = {
    availability: gridFrom([0, 1, 2, 3]),
  };

  it('returns [] for no candidates (the no-match fallback trigger)', () => {
    expect(rankCandidates(requester, [])).toEqual([]);
  });

  it('orders best score first', () => {
    const weak: Candidate = {
      availability: gridFrom([10]), // no shared slot -> scheduleScore 0
      memberCount: 1,
      maxMembers: 8,
    };
    const strong: Candidate = {
      availability: gridFrom([0, 1, 2, 3]), // scheduleScore 1
      memberCount: 4,
      maxMembers: 8,
    };
    const ranked = rankCandidates(requester, [weak, strong]);
    expect(ranked[0].match.score).toBeGreaterThanOrEqual(ranked[1].match.score);
    expect(ranked[0].availability).toEqual(strong.availability);
  });

  it('prefers filling a near-complete group when all else is equal', () => {
    const base = {
      availability: gridFrom([0, 1, 2, 3]), // identical schedule fit
      maxMembers: 8,
    };
    const emptier: Candidate = { ...base, memberCount: 2 };
    const fuller: Candidate = { ...base, memberCount: 7 };
    const ranked = rankCandidates(requester, [emptier, fuller]);
    expect(ranked[0].memberCount).toBe(7);
    expect(ranked[0].match.score).toBeGreaterThan(ranked[1].match.score);
  });

  it('attaches the breakdown to each ranked candidate', () => {
    const c: Candidate = {
      availability: gridFrom([0, 1]),
      memberCount: 3,
      maxMembers: 8,
    };
    const [scored] = rankCandidates(requester, [c]);
    expect(scored.match).toBeDefined();
    expect(scored.match.score).toBeCloseTo(compatibilityScore(requester, c), 10);
    // original candidate fields are preserved
    expect(scored.availability).toEqual(c.availability);
    expect(scored.memberCount).toBe(3);
  });
});

/**
 * partitionIntoGroups powers admin-initiated batch (system) matching: it carves a
 * course's waiting pool into study groups. The risky properties are (a) nobody is
 * ever silently dropped, and (b) the "random 3-6, never strand a single" sizing
 * rule the product decided. Randomness is injected via pickSize so these are
 * deterministic. This logic is mirrored to the Deno side — mirror.test.ts guards
 * that copy; these tests guard the behaviour.
 */
describe('partitionIntoGroups', () => {
  function member(id: string, slots: number[] = []): PartitionMember {
    return { id, profile: { availability: gridFrom(slots) } };
  }

  it('groups nothing when the pool is empty', () => {
    expect(partitionIntoGroups([])).toEqual({ groups: [], waiting: [] });
  });

  it('leaves a lone student waiting — a group of one is impossible', () => {
    const { groups, waiting } = partitionIntoGroups([member('solo', [0, 1])]);
    expect(groups).toEqual([]);
    expect(waiting).toEqual(['solo']);
  });

  it('forms a pair from exactly two students (the pair floor)', () => {
    const { groups, waiting } = partitionIntoGroups([
      member('a', [0]),
      member('b', [0]),
    ]);
    expect(waiting).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds.slice().sort()).toEqual(['a', 'b']);
  });

  it('makes one group when the whole pool fits under the max size', () => {
    const pool = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => member(id, [0]));
    const { groups, waiting } = partitionIntoGroups(pool); // n=6, default max 6
    expect(waiting).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds).toHaveLength(6);
  });

  it('shrinks a target that would strand exactly one (7, pick 6 -> sizes 5 + 2)', () => {
    const pool = Array.from({ length: 7 }, (_, i) => member(`u${i}`, [0]));
    const { groups, waiting } = partitionIntoGroups(pool, { pickSize: () => 6 });
    expect(waiting).toEqual([]);
    expect(groups.map((g) => g.memberIds.length).sort((a, b) => a - b)).toEqual([2, 5]);
  });

  it('splits 7 into 3 + 4 when the target is 3', () => {
    const pool = Array.from({ length: 7 }, (_, i) => member(`u${i}`, [0]));
    const { groups } = partitionIntoGroups(pool, { pickSize: () => 3 });
    expect(groups.map((g) => g.memberIds.length).sort((a, b) => a - b)).toEqual([3, 4]);
  });

  it("fills a group with the seed's best matches, not arbitrary students", () => {
    // One cohesive cluster (A/B/C all free Mon morning/afternoon) and two
    // strangers free at unrelated times.
    const pool = [
      member('A', [0, 1]),
      member('B', [0, 1]),
      member('C', [0, 1]),
      member('X', [20]),
      member('Y', [24]),
    ];
    const { groups, waiting } = partitionIntoGroups(pool, {
      targetMin: 3,
      targetMax: 3,
      pickSize: () => 3,
    });
    expect(waiting).toEqual([]);
    expect(groups).toHaveLength(2);
    // Seed = A (most availability, lowest id on the tie); it pulls in the two
    // students who share its slots.
    expect(groups[0].seedId).toBe('A');
    expect(groups[0].memberIds.slice().sort()).toEqual(['A', 'B', 'C']);
    // The strangers are what's left, formed into the trailing pair.
    expect(groups[1].memberIds.slice().sort()).toEqual(['X', 'Y']);
    // A group that actually shares time scores higher than the mismatched leftovers.
    expect(groups[0].cohesion).toBeGreaterThan(groups[1].cohesion);
  });

  it('covers every student exactly once across groups and waiting, with sane sizes', () => {
    for (let n = 0; n <= 25; n++) {
      const pool = Array.from({ length: n }, (_, i) => member(`u${i}`, [i % 28]));
      // Deterministic pseudo-random target size in [3, 6].
      let k = 0;
      const pickSize = (lo: number, hi: number) => lo + (k++ % (hi - lo + 1));
      const { groups, waiting } = partitionIntoGroups(pool, { pickSize });

      const seen = [...groups.flatMap((g) => g.memberIds), ...waiting];
      expect(seen.slice().sort()).toEqual(pool.map((m) => m.id).sort());
      expect(new Set(seen).size).toBe(n); // no duplicates, nothing lost

      for (const g of groups) {
        expect(g.memberIds.length).toBeGreaterThanOrEqual(2);
        expect(g.memberIds.length).toBeLessThanOrEqual(6);
        expect(g.memberIds[0]).toBe(g.seedId); // seed always leads the list
      }
      // Only a lone pool waits; any pool of >= 2 is fully grouped.
      expect(waiting.length).toBe(n === 1 ? 1 : 0);
    }
  });
});
