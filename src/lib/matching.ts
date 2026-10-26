/**
 * Compatibility scoring for group matching.
 *
 * This module is pure and deterministic — no I/O, no Supabase, no clock. That
 * is deliberate: the exact same scoring runs in two places, and they must agree
 * to the decimal.
 *
 *   * here, on the client, so a match card can show a score/breakdown; and
 *   * in the `find-group` Edge Function, via a hand-kept copy at
 *     `supabase/functions/_shared/matching.ts`.
 *
 * The Edge Function copy carries a "change one, change both" header, mirroring
 * the existing availability.ts <-> SQL `availability_overlap()` precedent. The
 * copy exists because `supabase functions deploy` bundling of files outside
 * `supabase/functions/` isn't something we can rely on; a mirror is the safe
 * hand-over. Keep the scoring logic in these two files identical.
 *
 * Matching is by course + availability + how the student rates themselves on it.
 * The compatibility score is a weighted sum of three terms:
 *
 *     score = 0.65 * scheduleOverlap
 *           + 0.25 * proficiencyMix
 *           + 0.10 * groupFillBonus
 *
 * Every term is normalised to [0, 1], so the score is too. Course isn't a score
 * term — it's the grouping key: only same-course students are ever compared.
 *
 * The proficiency term is what makes this "intelligent grouping" rather than a
 * shared-calendar lookup, and it deliberately does NOT reward sameness: a group
 * where somebody is a step ahead has an explainer, so one band apart scores
 * best. It has a limit though — a struggling student parked among confident ones
 * is being tutored, not studying — and that limit is a property of the whole
 * group rather than of any pair in it, so it lives in `isolatedByProficiency`
 * and is applied when groups are formed. See the two functions for the detail.
 *
 * Alongside it sit two HARD composition caps (`violatesComposition`), also
 * whole-group properties applied at formation: at most one brilliant student
 * per group, and struggling students capped at one below five members and two
 * at five. Caps do not score candidates — they refuse them.
 */

import {
  type AvailabilityGrid,
  countSelected,
  overlapCount,
  scheduleOverlapScore,
} from './availability';

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
 *   maxMembers    the group's cap (the soft 5, or whatever the group was made
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

/**
 * Hard composition caps for automatic grouping.
 *
 * The product decision is "every group must be effective to study in", and the
 * failure modes it names are both about the extremes of the scale:
 *
 *   * AT MOST ONE BRILLIANT student per group. The brilliant student is the
 *     explainer; a second one takes a seat another student needed. Absolute —
 *     a second brilliant joins only when the pool offers nothing else (see
 *     partitionIntoGroups' relaxation pass).
 *   * STRUGGLING students capped by size: one in a group of up to four, two in
 *     a group of five. Ideally never two anywhere — even a pair of strugglers
 *     has nobody to explain — so the cap of one runs all the way down, and the
 *     two-at-five allowance exists so a full group can still carry a pair.
 *
 * The middle band (band 2, and anyone unrated) is unlimited: those students are
 * the bridge that keeps a group from splitting into a tutor and a class.
 */
export const MAX_BRILLIANT_PER_GROUP = 1;
export const STRUGGLING_CAP_FULL_GROUP = 2;

/** How many struggling students a group of `size` may carry. */
export function strugglingCap(size: number): number {
  return size >= 5 ? STRUGGLING_CAP_FULL_GROUP : 1;
}

/**
 * Whether a group of `size` holding `levels` breaks the composition caps.
 *
 * Unrated members are ignored rather than guessed at, same as
 * `isolatedByProficiency`: a blank is not evidence of a band. Levels are
 * individual students' ratings — the caps COUNT strugglers and brilliant
 * students, so a group mean would hide them; `band` still clamps, so junk
 * input cannot push the count off the scale.
 */
export function violatesComposition(
  levels: readonly (number | null | undefined)[],
  size: number
): boolean {
  const rated = levels
    .filter((level) => level != null && Number.isFinite(level))
    .map((level) => band(level));
  if (rated.length === 0) return false;
  const brilliant = rated.filter((level) => level >= 3).length;
  if (brilliant > MAX_BRILLIANT_PER_GROUP) return true;
  const struggling = rated.filter((level) => level <= 1).length;
  return struggling > strugglingCap(size);
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
  /** Largest random target group size. Default 5 (the product's group cap). */
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
 * Fill is composition-aware: the caps in `violatesComposition` (at most one
 * brilliant student; strugglers capped by size) are hard while the pool offers
 * an alternative. Candidates the caps reject wait in order and are only taken
 * when compliant filling would leave a one-member group or strand exactly one
 * student — the caps' stated exception, "unless there is no more available".
 *
 * After each group is filled it is checked against `isolatedByProficiency` and
 * one swap is attempted if it fails, so "mix levels" does not quietly produce
 * the single arrangement the mix was meant to rule out — a swap that would
 * break the composition caps is not an improvement and is not taken.
 *
 * Pure: the caller's array is never mutated. Every input id appears exactly once
 * across `groups` and `waiting`.
 */
export function partitionIntoGroups(
  members: PartitionMember[],
  opts: PartitionOptions = {}
): { groups: PartitionGroup[]; waiting: string[] } {
  const targetMin = opts.targetMin ?? 3;
  const targetMax = opts.targetMax ?? 5;
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

    // The group's levels so far, optionally with one candidate's added — the
    // shape `violatesComposition` reads. Individual levels, never a mean: the
    // caps COUNT strugglers and brilliant students, and a mean would hide them.
    const groupLevels = (
      chosen: typeof ranked,
      extra?: (typeof ranked)[number]
    ): (number | null | undefined)[] => [
      seed.profile.proficiency,
      ...chosen.map((f) => f.proficiency),
      ...(extra ? [extra.proficiency] : []),
    ];

    // Composition-aware fill. Walk the ranked list in score order and take only
    // candidates whose addition keeps the group inside the caps at its TARGET
    // size; the rest wait in order as the relaxation pool below. Demoted and
    // passed-over candidates were never removed from the pool, so unless they
    // are chosen below they simply fall to the next groups.
    let fillers: typeof ranked = [];
    const passedOver: typeof ranked = [];
    for (const cand of ranked) {
      if (fillers.length >= size - 1) break;
      if (violatesComposition(groupLevels(fillers, cand), size)) {
        passedOver.push(cand);
      } else {
        fillers.push(cand);
      }
    }

    // Groups often end smaller than the target when the pool runs thin, and the
    // struggling cap depends on size: a second struggler taken at a target of
    // five can violate the cap in a group that stops at three or four. Give the
    // lowest-ranked strugglers back until the ACTUAL size is compliant.
    while (
      fillers.length + 1 < size &&
      violatesComposition(groupLevels(fillers), fillers.length + 1)
    ) {
      const lastStruggler = fillers
        .map((f) => band(f.proficiency) <= 1)
        .lastIndexOf(true);
      if (lastStruggler < 0) break; // unreachable: only strugglers can newly violate
      passedOver.push(fillers.splice(lastStruggler, 1)[0]);
    }

    // Relaxation: the caps are absolute "unless there is no more available".
    // When compliant filling would leave a ONE-member group (not a group at
    // all) or strand exactly one student for the next round — which can never
    // place a lone student — fall back to the best candidates the caps passed
    // over, in rank order.
    while (
      passedOver.length > 0 &&
      (fillers.length === 0 || pool.length - fillers.length === 1)
    ) {
      fillers.push(passedOver.shift()!);
    }

    // The caps do not subsume the isolation rule: {1, 1, 3} in a group of five
    // passes them (two strugglers and one brilliant at full size) yet still
    // strands two strugglers with a single explainer and no bridge. One swap
    // fixes every case that is fixable: give up the weakest chosen filler for
    // the best unchosen student who breaks the isolation without breaking the
    // caps. If nobody does, the pool has nothing better to offer and the group
    // stands as scored; the alternative is leaving students ungrouped, which
    // the tail rules exist to avoid.
    const isolated = (chosenFillers: typeof fillers) =>
      isolatedByProficiency([
        seed.profile.proficiency,
        ...chosenFillers.map((f) => f.proficiency),
      ]);

    if (isolated(fillers)) {
      const chosenIds = new Set(fillers.map((f) => f.id));
      const kept = fillers.slice(0, -1);
      for (const swap of ranked) {
        if (chosenIds.has(swap.id)) continue;
        if (
          !isolated([...kept, swap]) &&
          !violatesComposition(groupLevels(kept, swap), fillers.length + 1)
        ) {
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
