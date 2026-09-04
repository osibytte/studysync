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
 * The compatibility score is the spec's weighted sum:
 *
 *     score = 0.5 * topicOverlap + 0.3 * scheduleOverlap + 0.2 * groupFillBonus
 *
 * All three terms are normalised to [0, 1], so the score is too.
 */

import {
  type AvailabilityGrid,
  overlapCount,
  scheduleOverlapScore,
} from './availability';

// === MIRROR START ===
// Everything between these sentinels is byte-identical to the same region in
// supabase/functions/_shared/matching.ts. The two files differ ONLY in the
// import line above (Deno uses './availability.ts'). mirror.test.ts compares
// the enclosed text and fails the build on any drift. Change one, change both.

/**
 * Spec weights. Topic fit matters most (you're there to study the same thing),
 * schedule next (you have to actually meet), and a small nudge toward filling a
 * group that's nearly complete.
 */
export const WEIGHTS = { topic: 0.5, schedule: 0.3, fill: 0.2 } as const;

/** The requesting student, reduced to what scoring needs. */
export interface ScoringProfile {
  topicIds: string[];
  availability: AvailabilityGrid;
}

/**
 * A thing the requester could be matched to — an existing group, or a
 * hypothetical pairing with another lone student. Scoring treats them
 * uniformly; the caller shapes DB rows into this and carries any identity
 * (group id, name, …) alongside separately.
 *
 *   topicIds      the group's topics (or the other student's)
 *   availability  a representative availability grid for the candidate — for a
 *                 group, the slots its members can commonly meet; for a lone
 *                 student, that student's own grid. The caller decides how to
 *                 derive it; scoring just overlaps against it.
 *   memberCount   how many are already in (1 for a hypothetical pairing = the
 *                 other student; the current size for a real group)
 *   maxMembers    the group's cap (the soft 8, or whatever the group was made
 *                 with)
 */
export interface Candidate {
  topicIds: string[];
  availability: AvailabilityGrid;
  memberCount: number;
  maxMembers: number;
}

/**
 * Topic overlap in [0, 1], normalised by the SMALLER topic set — the same
 * reasoning as scheduleOverlapScore's min-count denominator. A student who
 * lists 2 topics and shares both with a group that lists 8 is a perfect topic
 * fit *from that student's point of view*; dividing by the larger set would
 * unfairly punish focused students against broad groups.
 *
 * Returns 0 when either side lists no topics — no shared basis to score on, and
 * it keeps the divisor non-zero.
 */
export function topicOverlapScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const bSet = new Set(b);
  let shared = 0;
  for (const t of a) if (bSet.has(t)) shared++;
  return shared / Math.min(a.length, b.length);
}

/** Count of shared topics — for the human-readable breakdown on a match card. */
export function sharedTopicCount(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const bSet = new Set(b);
  let shared = 0;
  for (const t of a) if (bSet.has(t)) shared++;
  return shared;
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
  topicScore: number;
  scheduleScore: number;
  fillScore: number;
  sharedTopics: number;
  sharedSlots: number;
}

/** Full breakdown of one requester-vs-candidate comparison. */
export function scoreBreakdown(
  requester: ScoringProfile,
  candidate: Candidate
): MatchBreakdown {
  const topicScore = topicOverlapScore(requester.topicIds, candidate.topicIds);
  const scheduleScore = scheduleOverlapScore(requester.availability, candidate.availability);
  const fillScore = groupFillBonus(candidate.memberCount, candidate.maxMembers);

  const score =
    WEIGHTS.topic * topicScore +
    WEIGHTS.schedule * scheduleScore +
    WEIGHTS.fill * fillScore;

  return {
    score,
    topicScore,
    scheduleScore,
    fillScore,
    sharedTopics: sharedTopicCount(requester.topicIds, candidate.topicIds),
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
 * Score and rank candidates, best first. Ties break by shared topics then
 * shared slots then fuller group, so ordering is stable and explainable rather
 * than dependent on input order. Returns [] for no candidates — the caller's
 * cue to show the no-match fallback.
 */
export function rankCandidates<T extends Candidate>(
  requester: ScoringProfile,
  candidates: T[]
): ScoredCandidate<T>[] {
  return candidates
    .map((c) => ({ ...c, match: scoreBreakdown(requester, c) }))
    .sort((a, b) => {
      if (b.match.score !== a.match.score) return b.match.score - a.match.score;
      if (b.match.sharedTopics !== a.match.sharedTopics)
        return b.match.sharedTopics - a.match.sharedTopics;
      if (b.match.sharedSlots !== a.match.sharedSlots)
        return b.match.sharedSlots - a.match.sharedSlots;
      return b.match.fillScore - a.match.fillScore;
    });
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

/** Index of the seed: most topics anchors the group; id breaks ties for stable runs. */
function pickSeedIndex(pool: PartitionMember[]): number {
  let best = 0;
  for (let i = 1; i < pool.length; i++) {
    const iTopics = pool[i].profile.topicIds.length;
    const bTopics = pool[best].profile.topicIds.length;
    if (iTopics > bTopics || (iTopics === bTopics && pool[i].id < pool[best].id)) {
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
 * seed (the student with the most topics, so the group is anchored on clear
 * interests), fill it with that seed's best matches via rankCandidates, remove
 * them, repeat. A star-shaped heuristic (members are scored to the seed, not
 * pairwise across the whole group): good enough for a pilot, and cheap (O(n^2)).
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
    // ranking — topic + schedule fit to the seed does.
    const ranked = rankCandidates(
      seed.profile,
      pool.map((m) => ({
        id: m.id,
        topicIds: m.profile.topicIds,
        availability: m.profile.availability,
        memberCount: 1,
        maxMembers: targetMax,
      }))
    );
    const fillers = ranked.slice(0, size - 1);
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
