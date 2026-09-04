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
  sharedTopicCount,
  topicOverlapScore,
} from '../matching';
import { type AvailabilityGrid, emptyGrid } from '../availability';

/**
 * The spec names two matching edge cases explicitly and describes the weighting
 * intent. These tests pin all three:
 *
 *   1. zero schedule overlap — a candidate free at no shared time must not
 *      outrank a candidate with good (not perfect) topic fit AND real shared
 *      availability. This is the spec's worked example.
 *   2. zero candidates — ranking an empty list returns [], the caller's cue to
 *      show the no-match fallback.
 *   3. the 0.5 / 0.3 / 0.2 weighting is applied exactly.
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

describe('topicOverlapScore', () => {
  it('is 1 when every topic of the smaller set is shared', () => {
    expect(topicOverlapScore(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(1);
  });

  it('is 0 with no shared topics', () => {
    expect(topicOverlapScore(['a', 'b'], ['c', 'd'])).toBe(0);
  });

  it('normalises by the smaller set (focused student vs broad group)', () => {
    // smaller set has 2, shares 1 of them -> 0.5
    expect(topicOverlapScore(['a', 'b', 'c', 'd'], ['a', 'z'])).toBe(0.5);
    // smaller set fully contained in the larger -> perfect fit for that student
    expect(topicOverlapScore(['a', 'b', 'x', 'y'], ['a', 'b'])).toBe(1);
  });

  it('is 0 (not NaN) when either side lists no topics', () => {
    expect(topicOverlapScore([], ['a'])).toBe(0);
    expect(topicOverlapScore(['a'], [])).toBe(0);
    expect(topicOverlapScore([], [])).toBe(0);
  });

  it('ignores duplicates in the other set via set membership', () => {
    expect(sharedTopicCount(['a', 'b'], ['a', 'a', 'a'])).toBe(1);
  });
});

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
    topicIds: ['a', 'b', 'c', 'd'],
    availability: gridFrom([0, 1, 2, 3]), // free all Monday
  };

  it('applies the 0.5 / 0.3 / 0.2 weights exactly', () => {
    const candidate: Candidate = {
      topicIds: ['a', 'b', 'c', 'd'], // topicScore 1
      availability: gridFrom([0, 1, 2, 3]), // scheduleScore 1
      memberCount: 8, // full -> fillScore 0
      maxMembers: 8,
    };
    const b = scoreBreakdown(requester, candidate);
    expect(b.topicScore).toBe(1);
    expect(b.scheduleScore).toBe(1);
    expect(b.fillScore).toBe(0);
    expect(b.score).toBeCloseTo(WEIGHTS.topic * 1 + WEIGHTS.schedule * 1, 10);
  });

  it('reports shared topic and slot counts for display', () => {
    const candidate: Candidate = {
      topicIds: ['a', 'b', 'z'],
      availability: gridFrom([0, 1, 9]),
      memberCount: 3,
      maxMembers: 8,
    };
    const b = scoreBreakdown(requester, candidate);
    expect(b.sharedTopics).toBe(2); // a, b
    expect(b.sharedSlots).toBe(2); // slots 0, 1
  });

  it('keeps the score within [0, 1]', () => {
    const candidate: Candidate = {
      topicIds: ['a', 'b', 'c', 'd'],
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
    topicIds: ['a', 'b', 'c', 'd'],
    availability: gridFrom([0, 1, 2, 3]), // Monday
  };

  it('scores a zero-overlap candidate with the schedule term dropped, not NaN', () => {
    const noSchedule: Candidate = {
      topicIds: ['a', 'b', 'c', 'd'], // perfect topic
      availability: gridFrom([4, 5]), // Tuesday — no shared slot
      memberCount: 1,
      maxMembers: 8,
    };
    const b = scoreBreakdown(requester, noSchedule);
    expect(b.scheduleScore).toBe(0);
    expect(b.sharedSlots).toBe(0);
    // score is just the topic and fill terms
    expect(b.score).toBeCloseTo(
      WEIGHTS.topic * 1 + WEIGHTS.fill * groupFillBonus(1, 8),
      10
    );
  });

  it('does not let perfect-topic-but-no-time outrank good-topic-with-shared-time', () => {
    const perfectTopicNoTime: Candidate = {
      topicIds: ['a', 'b', 'c', 'd'], // topicScore 1.0
      availability: gridFrom([4, 5]), // zero overlap
      memberCount: 1,
      maxMembers: 8,
    };
    const goodTopicSharedTime: Candidate = {
      topicIds: ['a', 'b', 'w', 'z'], // shares 2 of 4 -> topicScore 0.5
      availability: gridFrom([0, 1]), // shares 2 slots -> scheduleScore 1.0
      memberCount: 1,
      maxMembers: 8,
    };
    const ranked = rankCandidates(requester, [perfectTopicNoTime, goodTopicSharedTime]);
    // the one with shared availability wins despite weaker topic fit
    expect(ranked[0]).toBe(
      ranked.find((c) => c.availability === goodTopicSharedTime.availability)
    );
    expect(ranked[0].availability).toEqual(goodTopicSharedTime.availability);
    expect(ranked[0].match.score).toBeGreaterThan(ranked[1].match.score);
  });
});

describe('rankCandidates', () => {
  const requester: ScoringProfile = {
    topicIds: ['a', 'b'],
    availability: gridFrom([0, 1, 2, 3]),
  };

  it('returns [] for no candidates (the no-match fallback trigger)', () => {
    expect(rankCandidates(requester, [])).toEqual([]);
  });

  it('orders best score first', () => {
    const weak: Candidate = {
      topicIds: ['x'],
      availability: gridFrom([10]),
      memberCount: 1,
      maxMembers: 8,
    };
    const strong: Candidate = {
      topicIds: ['a', 'b'],
      availability: gridFrom([0, 1, 2, 3]),
      memberCount: 4,
      maxMembers: 8,
    };
    const ranked = rankCandidates(requester, [weak, strong]);
    expect(ranked[0].match.score).toBeGreaterThanOrEqual(ranked[1].match.score);
    expect(ranked[0].topicIds).toEqual(['a', 'b']);
  });

  it('prefers filling a near-complete group when all else is equal', () => {
    const base = {
      topicIds: ['a', 'b'],
      availability: gridFrom([0, 1, 2, 3]),
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
      topicIds: ['a', 'b'],
      availability: gridFrom([0, 1]),
      memberCount: 3,
      maxMembers: 8,
    };
    const [scored] = rankCandidates(requester, [c]);
    expect(scored.match).toBeDefined();
    expect(scored.match.score).toBeCloseTo(compatibilityScore(requester, c), 10);
    // original candidate fields are preserved
    expect(scored.topicIds).toEqual(['a', 'b']);
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
  function member(id: string, topicIds: string[], slots: number[] = []): PartitionMember {
    return { id, profile: { topicIds, availability: gridFrom(slots) } };
  }

  it('groups nothing when the pool is empty', () => {
    expect(partitionIntoGroups([])).toEqual({ groups: [], waiting: [] });
  });

  it('leaves a lone student waiting — a group of one is impossible', () => {
    const { groups, waiting } = partitionIntoGroups([member('solo', ['a'])]);
    expect(groups).toEqual([]);
    expect(waiting).toEqual(['solo']);
  });

  it('forms a pair from exactly two students (the pair floor)', () => {
    const { groups, waiting } = partitionIntoGroups([
      member('a', ['t1']),
      member('b', ['t1']),
    ]);
    expect(waiting).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds.slice().sort()).toEqual(['a', 'b']);
  });

  it('makes one group when the whole pool fits under the max size', () => {
    const pool = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => member(id, ['t1']));
    const { groups, waiting } = partitionIntoGroups(pool); // n=6, default max 6
    expect(waiting).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds).toHaveLength(6);
  });

  it('shrinks a target that would strand exactly one (7, pick 6 -> sizes 5 + 2)', () => {
    const pool = Array.from({ length: 7 }, (_, i) => member(`u${i}`, ['t1']));
    const { groups, waiting } = partitionIntoGroups(pool, { pickSize: () => 6 });
    expect(waiting).toEqual([]);
    expect(groups.map((g) => g.memberIds.length).sort((a, b) => a - b)).toEqual([2, 5]);
  });

  it('splits 7 into 3 + 4 when the target is 3', () => {
    const pool = Array.from({ length: 7 }, (_, i) => member(`u${i}`, ['t1']));
    const { groups } = partitionIntoGroups(pool, { pickSize: () => 3 });
    expect(groups.map((g) => g.memberIds.length).sort((a, b) => a - b)).toEqual([3, 4]);
  });

  it("fills a group with the seed's best matches, not arbitrary students", () => {
    // One cohesive cluster (A/B/C share topics + time) and two unrelated strangers.
    const pool = [
      member('A', ['t1', 't2'], [0, 1]),
      member('B', ['t1', 't2'], [0, 1]),
      member('C', ['t1', 't2'], [0, 1]),
      member('X', ['t9'], [20]),
      member('Y', ['t8'], [24]),
    ];
    const { groups, waiting } = partitionIntoGroups(pool, {
      targetMin: 3,
      targetMax: 3,
      pickSize: () => 3,
    });
    expect(waiting).toEqual([]);
    expect(groups).toHaveLength(2);
    // Seed = A (most topics, lowest id); it pulls in the two topic/time sharers.
    expect(groups[0].seedId).toBe('A');
    expect(groups[0].memberIds.slice().sort()).toEqual(['A', 'B', 'C']);
    // The strangers are what's left, formed into the trailing pair.
    expect(groups[1].memberIds.slice().sort()).toEqual(['X', 'Y']);
    // A genuinely compatible group scores higher than the mismatched leftovers.
    expect(groups[0].cohesion).toBeGreaterThan(groups[1].cohesion);
  });

  it('covers every student exactly once across groups and waiting, with sane sizes', () => {
    for (let n = 0; n <= 25; n++) {
      const pool = Array.from({ length: n }, (_, i) =>
        member(`u${i}`, i % 2 === 0 ? ['t1', 't2'] : ['t3'], [i % 28])
      );
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
