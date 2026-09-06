/**
 * Compatibility scoring for group matching — Deno mirror.
 *
 * MIRROR of src/lib/matching.ts. The region between `=== MIRROR START ===` and
 * `=== MIRROR END ===` below is byte-identical to the same region in that file,
 * and src/lib/__tests__/mirror.test.ts fails the build if they ever drift.
 *
 * The ONLY difference between the two files is the import line just below: Deno
 * resolves the sibling module by explicit relative path with a `.ts` extension,
 * whereas the React Native / Metro copy imports from `'./availability'`.
 *
 * Why a hand-kept copy rather than a shared import: `supabase functions deploy`
 * bundles from within `supabase/functions/`, and reaching up into `src/` is not
 * something we can rely on across CLI versions. Keeping the scoring identical in
 * both trees, guarded by a test, is the safe hand-over.
 */

import {
  type AvailabilityGrid,
  countSelected,
  overlapCount,
  scheduleOverlapScore,
} from './availability.ts';

// === MIRROR START ===
// Everything between these sentinels is byte-identical to the same region in
// supabase/functions/_shared/matching.ts. The two files differ ONLY in the
// import line above (Deno uses './availability.ts'). mirror.test.ts compares
// the enclosed text and fails the build on any drift. Change one, change both.

/**
 * Spec weights. Schedule overlap still dominates: no amount of a promising level
 * mix rescues a group that can never sit down together. Proficiency mix is the
 * second term and the one that makes the grouping intelligent rather than merely
 * simultaneous. Filling a near-complete group stays the small nudge it always
 * was. The three weights sum to 1, keeping score in [0, 1].
 */
export const WEIGHTS = { schedule: 0.65, proficiency: 0.25, fill: 0.1 } as const;

/**
 * What an absent self-rating counts as when scoring.
 *
 * `user_courses.proficiency` is null for every course added before students were
 * asked, and stays null until one answers. Treating those as the middle band
 * makes them rank on schedule alone. The alternatives are both worse than
 * neutral: reading a blank as "struggling" would seed it into every mixed group
 * as the member to explain things to, and reading it as "confident" would make it
 * everybody's explainer. Neither is a claim the student ever made.
 */
export const NEUTRAL_PROFICIENCY = 2;

/** A rating clamped into the 1..3 band range, with the neutral fallback. */
function band(level: number | null | undefined): number {
  if (level == null || !Number.isFinite(level)) return NEUTRAL_PROFICIENCY;
  if (level < 1) return 1;
  if (level > 3) return 3;
  return level;
}

/**
 * How well two proficiency levels sit together, in [0, 1].
 *
 * The product decision was "mix levels, capped gap". A group learns most when
 * somebody is a step ahead: one band apart is the best pairing there is. The
 * same band is workable but flat — nobody is ahead, so nobody explains. Two
 * bands apart, struggling beside confident, is a tutorial rather than a study
 * group, so it lands between the other two instead of on top:
 *
 *     gap 0  ->  0.50    same level; fine, but nobody is ahead
 *     gap 1  ->  1.00    ideal: one can explain, one needs it
 *     gap 2  ->  0.75    workable, but lopsided
 *
 * It interpolates linearly between those anchors, because a candidate's level
 * can be a GROUP MEAN and therefore fractional — a band 1 student looking at a
 * {2, 3} group is scored against 2.5.
 *
 * This is a pairwise term and structurally cannot see a group's shape: three
 * students all at band 1 each score 0.5 here, in a group where nobody can
 * explain anything. `isolatedByProficiency` is where that gets caught.
 */
export function proficiencyMixScore(
  a: number | null | undefined,
  b: number | null | undefined
): number {
  const gap = Math.abs(band(a) - band(b));
  return gap <= 1 ? 0.5 + 0.5 * gap : 1 - 0.25 * (gap - 1);
}

/** The requesting student, reduced to what scoring needs. */
export interface ScoringProfile {
  availability: AvailabilityGrid;
  /**
   * Self-rated proficiency on the course being matched: 1 struggling, 2 getting
   * by, 3 fairly confident. Null/absent for a student who has never said, which
   * scores as NEUTRAL_PROFICIENCY.
   */
  proficiency?: number | null;
}

/**
 * A thing the requester could be matched to — an existing group, or a
 * hypothetical pairing with another lone student. Scoring treats them
 * uniformly; the caller shapes DB rows into this and carries any identity
 * (group id, name, …) alongside separately.
 *
 *   availability  a representative availability grid for the candidate — for a
 *                 group, the slots its members can commonly meet; for a lone
 *                 student, that student's own grid. The caller decides how to
 *                 derive it; scoring just overlaps against it.
 *   proficiency   a representative level for the candidate — for a group, the
 *                 MEAN of its members' ratings (fractional is expected and
 *                 handled); for a lone student, that student's own rating. Null
 *                 or absent when nobody in it has rated the course.
 *   memberCount   how many are already in (1 for a hypothetical pairing = the
 *                 other student; the current size for a real group)
 *   maxMembers    the group's cap (the soft 8, or whatever the group was made
 *                 with)
 */
export interface Candidate {
  availability: AvailabilityGrid;
  proficiency?: number | null;
  memberCount: number;
  maxMembers: number;
}

/**
 * Group-fill bonus in [0, 1]. The spec asks matching to "prefer filling a
 * near-complete group", so a fuller group scores a higher bonus: bonus is the
 * group's fullness fraction, memberCount / maxMembers.
 *
 * A group already at (or over) capacity returns 0 — it can't be joined, so
 * there's nothing to prefer. Defensive guards keep the term in range for junk
 * input (non-positive cap).
 */
export function groupFillBonus(memberCount: number, maxMembers: number): number {
  if (maxMembers <= 0) return 0;
  if (memberCount >= maxMembers) return 0; // full: not joinable
  if (memberCount <= 0) return 0;
  return memberCount / maxMembers;
}

/** The score plus its parts, for display and for tests to pin. */
export interface MatchBreakdown {
  score: number;
  scheduleScore: number;
  proficiencyScore: number;
  fillScore: number;
  sharedSlots: number;
}

/** Full breakdown of one requester-vs-candidate comparison. */
export function scoreBreakdown(
  requester: ScoringProfile,
  candidate: Candidate
): MatchBreakdown {
  const scheduleScore = scheduleOverlapScore(requester.availability, candidate.availability);
  const proficiencyScore = proficiencyMixScore(requester.proficiency, candidate.proficiency);
  const fillScore = groupFillBonus(candidate.memberCount, candidate.maxMembers);

  const score =
    WEIGHTS.schedule * scheduleScore +
    WEIGHTS.proficiency * proficiencyScore +
    WEIGHTS.fill * fillScore;

  return {
    score,
    scheduleScore,
    proficiencyScore,
    fillScore,
    sharedSlots: overlapCount(requester.availability, candidate.availability),
  };
}

/** Just the scalar score, when the breakdown isn't needed. */
export function compatibilityScore(
  requester: ScoringProfile,
  candidate: Candidate
): number {
  return scoreBreakdown(requester, candidate).score;
}

/** A candidate carried through scoring with its breakdown attached. */
export type ScoredCandidate<T extends Candidate> = T & { match: MatchBreakdown };

/**
 * Score and rank candidates, best first. Ties break by shared slots then fuller
 * group, so ordering is stable and explainable rather than dependent on input
 * order. Returns [] for no candidates — the caller's cue to show the no-match
 * fallback.
 */
export function rankCandidates<T extends Candidate>(
  requester: ScoringProfile,
  candidates: T[]
): ScoredCandidate<T>[] {
  return candidates
    .map((c) => ({ ...c, match: scoreBreakdown(requester, c) }))
    .sort((a, b) => {
      if (b.match.score !== a.match.score) return b.match.score - a.match.score;
      if (b.match.sharedSlots !== a.match.sharedSlots)
        return b.match.sharedSlots - a.match.sharedSlots;
      return b.match.fillScore - a.match.fillScore;
    });
}

/**
 * Does this group leave exactly one student stranded at one end of the scale?
 *
 * The other half of "mix levels, capped gap": never a lone struggling student
 * among confident ones. No pairwise term can express that, because every pair in
 * a {1, 3, 3, 3} group scores well on its own — and the band 1 student still
 * spends every session as the only one who is lost.
 *
 * True when the group has three or more members and, ignoring anyone who has not
 * rated the course, every rated member sits at one extreme except a single
 * student at the other. A member in the middle band makes it false by definition:
 * that student is the bridge, and their presence is exactly what stops the group
 * splitting into a tutor and a class.
 *
 * BOTH DIRECTIONS COUNT. The stated requirement named only the struggling
 * student, but the mirror — one confident student among strugglers — is the same
 * shape with the same cost: they do all the explaining, learn nothing, and leave.
 * That is how a group loses the one member who could have carried it.
 *
 * A pair is never isolated. Two students, one either side, is a tutor pairing:
 * a fine outcome, and often the best a small pool can do.
 */
export function isolatedByProficiency(
  levels: readonly (number | null | undefined)[]
): boolean {
  if (levels.length < 3) return false;

  const rated = levels
    .filter((level) => level != null && Number.isFinite(level))
    .map((level) => band(level));
  if (rated.length < 3) return false;

  const low = rated.filter((level) => level <= 1).length;
  const high = rated.filter((level) => level >= 3).length;
  if (low + high !== rated.length) return false; // somebody bridges the middle

  return (low === 1 && high >= 2) || (high === 1 && low >= 2);
}

/** A student in the matching pool: their id plus the profile scoring needs. */
export interface PartitionMember {
  id: string;
  profile: ScoringProfile;
}

/** One formed group produced by partitionIntoGroups. */
export interface PartitionGroup {
  /** Member ids, seed first, then fillers in descending compatibility. */
  memberIds: string[];
  seedId: string;
  /** Mean compatibility of the fillers to the seed, in [0, 1] (0 for a lone seed). */
  cohesion: number;
}

/**
 * Tuning for partitionIntoGroups. Randomness is INJECTED (pickSize) so the
 * function itself stays pure and deterministically testable — the only source
 * of non-determinism is whatever pickSize does.
 */
export interface PartitionOptions {
  /** Smallest random target group size. Default 3. */
  targetMin?: number;
  /** Largest random target group size. Default 6. */
  targetMax?: number;
  /** Picks a target size in [lo, hi] inclusive. Default: uniform random. */
  pickSize?: (lo: number, hi: number) => number;
}

function uniformSize(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function clampSize(v: number, lo: number, hi: number): number {
  const r = Math.round(v);
  if (!Number.isFinite(r) || r < lo) return lo;
  if (r > hi) return hi;
  return r;
}

/**
 * Index of the seed: the student with the most availability anchors the group,
 * giving fillers the widest schedule to overlap against; id breaks ties so runs
 * are stable.
 */
function pickSeedIndex(pool: PartitionMember[]): number {
  let best = 0;
  for (let i = 1; i < pool.length; i++) {
    const iSlots = countSelected(pool[i].profile.availability);
    const bSlots = countSelected(pool[best].profile.availability);
    if (iSlots > bSlots || (iSlots === bSlots && pool[i].id < pool[best].id)) {
      best = i;
    }
  }
  return best;
}

/**
 * Partition a pool of students into study groups by mutual compatibility.
 *
 * Used by admin-initiated batch (system) matching: given everyone waiting to be
 * matched on a course, carve them into groups. Greedy seed-and-fill — pick a
 * seed (the student with the most availability, so the group is anchored on the
 * widest schedule), fill it with that seed's best matches via rankCandidates,
 * remove them, repeat. A star-shaped heuristic (members are scored to the seed,
 * not pairwise across the whole group): good enough for a pilot, and cheap
 * (O(n^2)).
 *
 * Group size varies: a random target in [targetMin, targetMax] per group. Two
 * rules keep the tail sane, per the product decision:
 *   * a remainder that already fits one group (<= targetMax) becomes that single
 *     group, down to a pair — a 2..targetMax tail is never split; and
 *   * a target that would strand exactly one student is shrunk by one, so at
 *     least two remain for the next (pair-or-larger) group.
 * The upshot: any pool of >= 2 is fully grouped (no one waits); only a pool of
 * exactly one returns that student in `waiting`, for the next run to collect.
 *
 * After each group is filled it is checked against `isolatedByProficiency` and
 * one swap is attempted if it fails, so "mix levels" does not quietly produce the
 * single arrangement the mix was meant to rule out.
 *
 * Pure: the caller's array is never mutated. Every input id appears exactly once
 * across `groups` and `waiting`.
 */
export function partitionIntoGroups(
  members: PartitionMember[],
  opts: PartitionOptions = {}
): { groups: PartitionGroup[]; waiting: string[] } {
  const targetMin = opts.targetMin ?? 3;
  const targetMax = opts.targetMax ?? 6;
  const pickSize = opts.pickSize ?? uniformSize;

  const pool = members.slice(); // mutable working copy; caller's array untouched
  const groups: PartitionGroup[] = [];

  while (pool.length >= 2) {
    const n = pool.length;
    let size: number;
    if (n <= targetMax) {
      // 2..targetMax remaining: take them all as one final group (pair allowed).
      size = n;
    } else {
      size = clampSize(pickSize(targetMin, targetMax), targetMin, targetMax);
      if (n - size === 1) size -= 1; // never strand exactly one for the next round
    }

    const seed = pool.splice(pickSeedIndex(pool), 1)[0];

    // Score the rest against the seed. memberCount/maxMembers are a constant
    // fill context here (the group is still forming), so they don't change the
    // ranking — schedule fit to the seed does, and now so does level mix.
    const ranked = rankCandidates(
      seed.profile,
      pool.map((m) => ({
        id: m.id,
        availability: m.profile.availability,
        proficiency: m.profile.proficiency,
        memberCount: 1,
        maxMembers: targetMax,
      }))
    );
    let fillers = ranked.slice(0, size - 1);

    // The greedy pick above can land on precisely the group the product decision
    // forbids — one struggling student among confident ones — because each of
    // those pairings scores well against the seed in isolation. One swap fixes
    // every case that is fixable at this point: give up the weakest chosen filler
    // for the best-ranked student left who breaks the isolation. If nobody does,
    // the pool has nothing better to offer and the group stands as scored; the
    // alternative is leaving students ungrouped, which the tail rules exist to
    // avoid.
    const isolated = (chosenFillers: typeof fillers) =>
      isolatedByProficiency([
        seed.profile.proficiency,
        ...chosenFillers.map((f) => f.proficiency),
      ]);

    if (isolated(fillers)) {
      const kept = fillers.slice(0, -1);
      for (const swap of ranked.slice(size - 1)) {
        if (!isolated([...kept, swap])) {
          fillers = [...kept, swap];
          break;
        }
      }
    }

    const fillerIds = fillers.map((f) => f.id);

    const chosen = new Set(fillerIds);
    for (let i = pool.length - 1; i >= 0; i--) {
      if (chosen.has(pool[i].id)) pool.splice(i, 1);
    }

    const cohesion =
      fillers.length === 0
        ? 0
        : fillers.reduce((sum, f) => sum + f.match.score, 0) / fillers.length;

    groups.push({ memberIds: [seed.id, ...fillerIds], seedId: seed.id, cohesion });
  }

  return { groups, waiting: pool.map((m) => m.id) };
}
// === MIRROR END ===
