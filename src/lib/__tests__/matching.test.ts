import {
  type Candidate,
  NEUTRAL_PROFICIENCY,
  type PartitionMember,
  type ScoringProfile,
  WEIGHTS,
  compatibilityScore,
  groupFillBonus,
  isolatedByProficiency,
  partitionIntoGroups,
  proficiencyMixScore,
  rankCandidates,
  scoreBreakdown,
  strugglingCap,
  violatesComposition,
} from '../matching';
import { type AvailabilityGrid, emptyGrid } from '../availability';

/**
 * Matching is by course + availability + how the student rates themselves on it.
 * Course is the grouping key (only same-course students are ever compared); the
 * other two are what compatibility means. The score is a weighted sum of three
 * terms, each in [0, 1]:
 *
 *     score = 0.65 * scheduleOverlap
 *           + 0.25 * proficiencyMix
 *           + 0.10 * groupFillBonus
 *
 * These tests pin the intent:
 *
 *   1. zero schedule overlap — a candidate free at no shared time scores 0 on
 *      the schedule term (not NaN), and a fuller-but-never-free group must not
 *      outrank an open group you can actually meet. Schedule still dominates.
 *   2. zero candidates — ranking an empty list returns [], the caller's cue to
 *      show the no-match fallback.
 *   3. the three weights are applied exactly, and the mix term's anchors are the
 *      product decision rather than a curve that happened to be convenient: one
 *      band apart is the best pairing there is, two apart is a tutorial.
 *   4. `isolatedByProficiency` states a rule about a whole group that no pairwise
 *      term can, and partitionIntoGroups actually acts on it.
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

describe('proficiencyMixScore', () => {
  it('puts one band apart above every other pairing', () => {
    // "Mix levels, capped gap", in four numbers. A group learns most when
    // somebody is a step ahead; the same band is workable but flat, since nobody
    // is ahead to explain; two apart is a tutorial rather than a study group, so
    // it lands between the other two instead of on top.
    expect(proficiencyMixScore(1, 2)).toBe(1);
    expect(proficiencyMixScore(2, 3)).toBe(1);
    expect(proficiencyMixScore(1, 3)).toBe(0.75);
    expect(proficiencyMixScore(2, 2)).toBe(0.5);
  });

  it('is symmetric, because a pairing has no direction', () => {
    expect(proficiencyMixScore(3, 1)).toBe(proficiencyMixScore(1, 3));
    expect(proficiencyMixScore(3, 2)).toBe(proficiencyMixScore(2, 3));
  });

  it('interpolates a fractional level, because a group mean is one', () => {
    // A band 1 student looking at a {2, 3} group is scored against 2.5. Without
    // interpolation every group mean would snap to a band and the term would
    // stop telling groups apart.
    expect(proficiencyMixScore(1, 2.5)).toBeCloseTo(0.875, 10);
    expect(proficiencyMixScore(2, 2.5)).toBeCloseTo(0.75, 10);
  });

  it('reads an unrated student as the middle band, so they rank on schedule alone', () => {
    // Every enrolment made before 0020 is null here. Reading a blank as
    // struggling would seed it into every mixed group as the member to explain
    // things to; reading it as confident would make it everybody's explainer.
    // Neither is a claim the student made.
    expect(NEUTRAL_PROFICIENCY).toBe(2);
    for (const blank of [null, undefined, Number.NaN]) {
      expect(proficiencyMixScore(blank, 2)).toBe(proficiencyMixScore(2, 2));
      expect(proficiencyMixScore(blank, 1)).toBe(proficiencyMixScore(2, 1));
      expect(proficiencyMixScore(blank, blank)).toBe(proficiencyMixScore(2, 2));
    }
  });

  it('clamps a level from outside the bands instead of scoring it off the scale', () => {
    // A widened CHECK or a hand-written row must not push the term out of [0, 1]
    // — the weighted sum is only in range because each term is.
    expect(proficiencyMixScore(0, 3)).toBe(proficiencyMixScore(1, 3));
    expect(proficiencyMixScore(9, 1)).toBe(proficiencyMixScore(3, 1));
  });

  it('never drops below 0.5, however far apart two students are', () => {
    // Which is why no score in the app is ever below 0.125. The match card's
    // copy has to stay a ranking rather than a percentage of "how good this
    // group is for you": there is no such thing here as a 0% match.
    for (const a of [1, 2, 3]) {
      for (const b of [1, 2, 3]) {
        expect(proficiencyMixScore(a, b)).toBeGreaterThanOrEqual(0.5);
        expect(proficiencyMixScore(a, b)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('scoreBreakdown', () => {
  const requester: ScoringProfile = {
    availability: gridFrom([0, 1, 2, 3]), // free all Monday
  };

  it('applies the 0.65 / 0.25 / 0.10 weights exactly', () => {
    const candidate: Candidate = {
      availability: gridFrom([0, 1, 2, 3]), // scheduleScore 1
      proficiency: 3, // one band above the requester -> proficiencyScore 1
      memberCount: 4, // fillScore 4/8 = 0.5
      maxMembers: 8,
    };
    const b = scoreBreakdown({ ...requester, proficiency: 2 }, candidate);
    expect(b.scheduleScore).toBe(1);
    expect(b.proficiencyScore).toBe(1);
    expect(b.fillScore).toBeCloseTo(0.5, 10);
    expect(b.score).toBeCloseTo(
      WEIGHTS.schedule * 1 + WEIGHTS.proficiency * 1 + WEIGHTS.fill * 0.5,
      10
    );
  });

  it('sums the weights to 1, so nothing can score above a perfect match', () => {
    expect(WEIGHTS.schedule + WEIGHTS.proficiency + WEIGHTS.fill).toBeCloseTo(1, 10);
    const perfect: Candidate = {
      availability: gridFrom([0, 1, 2, 3]),
      proficiency: 3,
      memberCount: 7,
      maxMembers: 8,
    };
    // 7/8 full rather than 8/8, because a full group scores 0 on fill: it cannot
    // be joined, so an exact 1 is unreachable by construction.
    expect(compatibilityScore({ ...requester, proficiency: 2 }, perfect)).toBeLessThan(1);
  });

  it('floors at the mix term rather than 0', () => {
    // Nothing shared, nobody rated: the schedule and fill terms are both 0 and
    // the mix term still pays 0.5 for two unrated students in the same band.
    // 0.125 is the lowest score this scorer can return.
    const nothingShared: Candidate = {
      availability: gridFrom([27]),
      memberCount: 0,
      maxMembers: 8,
    };
    expect(compatibilityScore(requester, nothingShared)).toBeCloseTo(0.125, 10);
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
    // Score is the other two terms: neither student rated the course, so the mix
    // term pays its same-band 0.5.
    expect(b.score).toBeCloseTo(
      WEIGHTS.proficiency * 0.5 + WEIGHTS.fill * groupFillBonus(1, 8),
      10
    );
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

  it('does not let a promising level mix rescue a group that can never meet', () => {
    // 0.25 is a real weight, and must not become a back door. The ideal mix is
    // worth 0.25 where a shared schedule is worth 0.65, so a group you can never
    // sit down with stays below one you can — even when its levels are perfect
    // against yours and the other group's are flat.
    const idealMixNoTime: Candidate = {
      availability: gridFrom([20]), // no shared slot
      proficiency: 3, // one band above -> mix 1
      memberCount: 4,
      maxMembers: 8,
    };
    const sharedTimeFlatMix: Candidate = {
      availability: gridFrom([0, 1, 2, 3]), // scheduleScore 1
      proficiency: 2, // same band -> mix 0.5
      memberCount: 4,
      maxMembers: 8,
    };
    const ranked = rankCandidates({ ...requester, proficiency: 2 }, [
      idealMixNoTime,
      sharedTimeFlatMix,
    ]);
    expect(ranked[0].proficiency).toBe(2);
    expect(ranked[0].match.sharedSlots).toBe(4);
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
 * The other half of "mix levels, capped gap", and the half no score can express:
 * every pair in a {1, 3, 3, 3} group scores respectably on its own, and the band 1
 * student still spends every session as the only one who is lost.
 */
describe('isolatedByProficiency', () => {
  it('catches one struggling student among the confident', () => {
    expect(isolatedByProficiency([1, 3, 3])).toBe(true);
    expect(isolatedByProficiency([1, 3, 3, 3])).toBe(true);
  });

  it('catches the mirror, one confident student among strugglers', () => {
    // The stated requirement named only the struggling student. This shape costs
    // the group the one member who could have carried it: they do all the
    // explaining, learn nothing, and leave.
    expect(isolatedByProficiency([3, 1, 1])).toBe(true);
    expect(isolatedByProficiency([1, 1, 1, 3])).toBe(true);
  });

  it('accepts a group with somebody in the middle band', () => {
    // The bridge. Their presence is what stops the group splitting into a tutor
    // and a class, so one of them makes the group fine by definition.
    expect(isolatedByProficiency([1, 2, 3])).toBe(false);
    expect(isolatedByProficiency([1, 3, 3, 2])).toBe(false);
    expect(isolatedByProficiency([2, 2, 2])).toBe(false);
  });

  it('accepts an even split, and a group all at one level', () => {
    // Two either side is a study group. All at one level is flat rather than
    // lopsided — the mix term already ranks it low, and it is not this rule's to
    // refuse.
    expect(isolatedByProficiency([1, 1, 3, 3])).toBe(false);
    expect(isolatedByProficiency([1, 1, 1])).toBe(false);
    expect(isolatedByProficiency([3, 3, 3])).toBe(false);
  });

  it('never isolates a pair — that is a tutor pairing, often the best on offer', () => {
    expect(isolatedByProficiency([1, 3])).toBe(false);
    expect(isolatedByProficiency([3, 1])).toBe(false);
    expect(isolatedByProficiency([1])).toBe(false);
    expect(isolatedByProficiency([])).toBe(false);
  });

  it('ignores unrated members rather than guessing at them', () => {
    // A blank is not evidence. Drop them and the rule reads the same as it would
    // for a group that size: two rated members left is a pair, whoever else is in
    // the room.
    expect(isolatedByProficiency([1, 3, null])).toBe(false);
    expect(isolatedByProficiency([null, null, null])).toBe(false);
    expect(isolatedByProficiency([1, 3, 3, null, undefined])).toBe(true);
  });
});

/**
 * partitionIntoGroups powers admin-initiated batch (system) matching: it carves a
 * course's waiting pool into study groups. The risky properties are (a) nobody is
 * ever silently dropped, (b) the "random 3-5, never strand a single" sizing
 * rule the product decided, and (c) the hard composition caps — at most one
 * brilliant student per group, strugglers capped by size — hold whenever the
 * pool offers an alternative. Randomness is injected via pickSize so these are
 * deterministic. This logic is mirrored to the Deno side — mirror.test.ts guards
 * that copy; these tests guard the behaviour.
 */
describe('partitionIntoGroups', () => {
  function member(
    id: string,
    slots: number[] = [],
    proficiency?: number
  ): PartitionMember {
    return { id, profile: { availability: gridFrom(slots), proficiency } };
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
    const pool = ['a', 'b', 'c', 'd', 'e'].map((id) => member(id, [0]));
    const { groups, waiting } = partitionIntoGroups(pool); // n=5, default max 5
    expect(waiting).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds).toHaveLength(5);
  });

  it('shrinks a target that would strand exactly one (7, pick 5 -> sizes 5 + 2)', () => {
    const pool = Array.from({ length: 7 }, (_, i) => member(`u${i}`, [0]));
    const { groups, waiting } = partitionIntoGroups(pool, { pickSize: () => 5 });
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

  it('gives up its weakest filler rather than form the group the mix rules out', () => {
    // The greedy pick lands on exactly the arrangement the product decision
    // forbids. Seed 'a' is struggling; 'hi1' and 'hi2' are confident and share
    // its whole schedule, so at 0.65 for schedule they outrank 'mid' — who is one
    // band away (the ideal mix) but only half-overlapping. Taking the top two
    // gives {1, 3, 3}, and one swap trades 'hi2' for 'mid'.
    const pool = [
      member('a', [0, 1, 2, 3], 1),
      member('hi1', [0, 1, 2, 3], 3),
      member('hi2', [0, 1, 2, 3], 3),
      member('mid', [0, 4], 2),
      member('x', [20], 2),
      member('y', [24], 2),
    ];
    const levelOf = new Map(pool.map((m) => [m.id, m.profile.proficiency]));
    const { groups, waiting } = partitionIntoGroups(pool, {
      targetMin: 3,
      targetMax: 4,
      pickSize: () => 3,
    });

    expect(waiting).toEqual([]);
    expect(groups[0].seedId).toBe('a');
    expect(groups[0].memberIds.slice().sort()).toEqual(['a', 'hi1', 'mid']);
    // The point of the swap, stated as the rule rather than as the roster.
    expect(
      isolatedByProficiency(groups[0].memberIds.map((id) => levelOf.get(id)))
    ).toBe(false);
    // And it cost something: 'hi2' outscored 'mid' and was still passed over.
    expect(groups[0].memberIds).not.toContain('hi2');
  });

  it('lets an unfixable group stand rather than leave students ungrouped', () => {
    // Nothing but confident students to reach for, so the swap loop runs out of
    // candidates. Forming {1, 3, 3} anyway is the deliberate call: the
    // alternative is a struggling student waiting for a run that will never have
    // anybody better in it.
    const pool = [
      member('a', [0, 1], 1),
      member('b', [0, 1], 3),
      member('c', [0, 1], 3),
    ];
    const { groups, waiting } = partitionIntoGroups(pool, {
      targetMin: 3,
      targetMax: 3,
      pickSize: () => 3,
    });
    expect(waiting).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds.slice().sort()).toEqual(['a', 'b', 'c']);
  });

  it('covers every student exactly once across groups and waiting, with sane sizes', () => {
    for (let n = 0; n <= 25; n++) {
      const pool = Array.from({ length: n }, (_, i) => member(`u${i}`, [i % 28]));
      // Deterministic pseudo-random target size in [3, 5].
      let k = 0;
      const pickSize = (lo: number, hi: number) => lo + (k++ % (hi - lo + 1));
      const { groups, waiting } = partitionIntoGroups(pool, { pickSize });

      const seen = [...groups.flatMap((g) => g.memberIds), ...waiting];
      expect(seen.slice().sort()).toEqual(pool.map((m) => m.id).sort());
      expect(new Set(seen).size).toBe(n); // no duplicates, nothing lost

      for (const g of groups) {
        expect(g.memberIds.length).toBeGreaterThanOrEqual(2);
        expect(g.memberIds.length).toBeLessThanOrEqual(5);
        expect(g.memberIds[0]).toBe(g.seedId); // seed always leads the list
      }
      // Only a lone pool waits; any pool of >= 2 is fully grouped.
      expect(waiting.length).toBe(n === 1 ? 1 : 0);
    }
  });
});

/**
 * The hard composition caps, as a product decision rather than a score: at most
 * one brilliant student per group, and struggling students capped by size (one
 * below five members, two at five — ideally never two anywhere). The middle
 * band is unlimited: those students are the bridge.
 */
describe('violatesComposition / strugglingCap', () => {
  it('allows one brilliant student, refuses a second', () => {
    expect(violatesComposition([2, 3, 2], 5)).toBe(false);
    expect(violatesComposition([3, 2, 1, 2], 5)).toBe(false);
    expect(violatesComposition([3, 3, 2], 5)).toBe(true);
    expect(violatesComposition([2, 3, 3, 3], 5)).toBe(true);
  });

  it('caps strugglers at one below five members, two at five', () => {
    expect(strugglingCap(2)).toBe(1);
    expect(strugglingCap(3)).toBe(1);
    expect(strugglingCap(4)).toBe(1);
    expect(strugglingCap(5)).toBe(2);
    expect(violatesComposition([1, 2, 2], 3)).toBe(false);
    expect(violatesComposition([1, 1, 2], 3)).toBe(true);
    expect(violatesComposition([1, 1, 2, 2], 4)).toBe(true);
    expect(violatesComposition([1, 1, 2, 2, 2], 5)).toBe(false);
    expect(violatesComposition([1, 1, 1, 2, 2], 5)).toBe(true);
  });

  it('ignores unrated members rather than guessing at them', () => {
    expect(violatesComposition([1, null, 2], 3)).toBe(false);
    expect(violatesComposition([3, undefined, 3], 4)).toBe(true);
    expect(violatesComposition([null, undefined, Number.NaN], 3)).toBe(false);
  });
});

/**
 * partitionIntoGroups acting on the caps. The caps are hard while the pool
 * offers an alternative; the relaxation pass exists for the "no more
 * available" case, and the demote pass for groups that stop short of five
 * after taking a second struggler at the target size.
 */
describe('partitionIntoGroups: composition caps', () => {
  function member(
    id: string,
    slots: number[] = [],
    proficiency?: number
  ): PartitionMember {
    return { id, profile: { availability: gridFrom(slots), proficiency } };
  }
  const levelOf = (pool: PartitionMember[]) =>
    new Map(pool.map((m) => [m.id, m.profile.proficiency] as const));

  it('never puts two brilliant students in one group while the pool offers an alternative', () => {
    // n0 has the widest schedule so it seeds; the two brilliant students share
    // that schedule and would both be top-ranked fillers. The cap refuses the
    // second, who goes on to anchor a group of their own.
    const pool = [
      member('n0', [0, 1, 2, 3, 4, 5]),
      member('hi1', [0, 1, 2, 3], 3),
      member('hi2', [0, 1, 2, 3], 3),
      member('n1', [0], 2),
      member('n2', [0], 2),
      member('n3', [0], 2),
      member('n4', [0], 2),
      member('n5', [0], 2),
    ];
    const levels = levelOf(pool);
    const { groups, waiting } = partitionIntoGroups(pool, {
      targetMin: 3,
      targetMax: 5,
      pickSize: () => 5,
    });

    expect(waiting).toEqual([]);
    expect(groups.filter((g) => g.memberIds.includes('hi1'))).not.toEqual(
      groups.filter((g) => g.memberIds.includes('hi2'))
    );
    for (const g of groups) {
      expect(
        violatesComposition(
          g.memberIds.map((id) => levels.get(id)),
          g.memberIds.length
        )
      ).toBe(false);
    }
  });

  it('caps strugglers at one until the group reaches five', () => {
    // A full group of five may carry two strugglers — the cap's stated
    // allowance. n1..n3 outscore s1 (mix 1 beats mix 0.5 against a struggling
    // seed) but s1 still lands: two strugglers at five is allowed.
    const pool = [
      member('s0', [0, 1, 2, 3, 4, 5], 1),
      member('s1', [0, 1, 2, 3], 1),
      member('n1', [0, 1, 2, 3], 2),
      member('n2', [0, 1, 2, 3], 2),
      member('n3', [0, 1, 2, 3], 2),
    ];
    const levels = levelOf(pool);
    const { groups, waiting } = partitionIntoGroups(pool, { pickSize: () => 5 });

    expect(waiting).toEqual([]);
    expect(groups).toHaveLength(1);
    const ids = groups[0].memberIds;
    expect(ids).toHaveLength(5);
    expect(ids.filter((id) => levels.get(id) === 1).sort()).toEqual(['s0', 's1']);
    expect(violatesComposition(ids.map((id) => levels.get(id)), 5)).toBe(false);
  });

  it('gives a second struggler back when the group stops short of five', () => {
    // s1 is taken at the target of five, where two strugglers are allowed; the
    // compliant candidates then run out, the group stops at three, and the cap
    // for a group of three is one. The demote pass returns s1 to the pool,
    // where the next round pairs them with a brilliant student instead.
    const pool = [
      member('s0', [0, 1, 2, 3, 4, 5], 1),
      member('s1', [0, 1, 2, 3, 4, 5], 1),
      member('b1', [0, 1, 2, 3, 4, 5], 3),
      member('b2', [0, 1, 2, 3, 4, 5], 3),
      member('b3', [0, 1, 2, 3, 4, 5], 3),
      member('b4', [0, 1, 2, 3, 4, 5], 3),
      member('n1', [20], 2),
    ];
    const { groups, waiting } = partitionIntoGroups(pool, { pickSize: () => 5 });

    expect(waiting).toEqual([]);
    const s0Group = groups.find((g) => g.memberIds.includes('s0'))!;
    const s1Group = groups.find((g) => g.memberIds.includes('s1'))!;
    expect(s0Group).not.toBe(s1Group);
    for (const g of groups) {
      const strugglers = g.memberIds.filter((id) =>
        ['s0', 's1'].includes(id)
      ).length;
      expect(strugglers).toBeLessThanOrEqual(g === s0Group && g.memberIds.length === 5 ? 2 : 1);
    }
    expect(s1Group.memberIds).toContain('b2'); // paired with an explainer, not abandoned
  });

  it('relaxes rather than strand people when the pool has nothing else', () => {
    // Two brilliant students and nobody else: any pairing breaks the
    // one-brilliant cap. Grouping them anyway is the stated exception — the
    // alternative is students who wait for a run that will never place them.
    const pool = [member('b1', [0], 3), member('b2', [0], 3)];
    const { groups, waiting } = partitionIntoGroups(pool);

    expect(waiting).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds.slice().sort()).toEqual(['b1', 'b2']);
  });
});
