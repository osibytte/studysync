import type {
  GroupMemberDetailRow,
  GroupRole,
  GroupStatus,
  MatchingWindowState,
  MyGroupRow,
  Proficiency,
} from '@/types/database';
import { dayLabel, formatClock, localDayKey } from './chatRules';

/**
 * Pure presentation and permission logic for groups.
 *
 * Split out of the screens deliberately. "Can this student invite?" and "is
 * this group joinable?" are rules the SQL already enforces in the RPCs; the UI
 * needs the same answers to decide what to show, and duplicating them inline
 * across five screens is how the two drift apart. Keeping them here — pure
 * functions over plain rows — means they are unit-tested rather than only
 * reachable by tapping through the app against a live database.
 *
 * These are for DISPLAY only. Every one of them is re-checked server-side by
 * the RPC that performs the action; a stale client must never be the thing
 * standing between a student and a rule.
 */

/** Lifecycle states a group can still be joined into. Mirrors the SQL filters. */
export const JOINABLE_STATUSES: readonly GroupStatus[] = [
  'forming',
  'active',
  'dormant',
];

/** Wording for a lifecycle state. Plain, and never blames the student. */
export const STATUS_LABEL: Record<GroupStatus, string> = {
  forming: 'Forming',
  active: 'Active',
  dormant: 'Quiet lately',
  archived: 'Archived',
  disbanded: 'Disbanded',
};

/**
 * One-line explanation of what a state means, for the group detail screen.
 * `dormant` and `archived` are the two that surprise people, so they say what
 * brings the group back rather than only naming the state.
 */
export const STATUS_HINT: Record<GroupStatus, string> = {
  forming: 'Still filling up — invite someone or approve a request.',
  active: 'This group is up and running.',
  dormant: 'No activity for a couple of weeks. Anything you do here revives it.',
  archived: 'Archived. Members can still read it, but it no longer appears in search.',
  disbanded: 'Everyone left, so this group is closed.',
};

export function isJoinable(status: GroupStatus): boolean {
  return JOINABLE_STATUSES.includes(status);
}

export function isLive(status: GroupStatus): boolean {
  return status !== 'archived' && status !== 'disbanded';
}

/** "3 of 8 members" — the phrasing used on every card that shows capacity. */
export function capacityLabel(memberCount: number, maxMembers: number): string {
  return `${memberCount} of ${maxMembers} member${maxMembers === 1 ? '' : 's'}`;
}

/** Seats left, floored at 0 — an over-full group is a bug, not a negative. */
export function seatsLeft(memberCount: number, maxMembers: number): number {
  return Math.max(0, maxMembers - memberCount);
}

export function isFull(memberCount: number, maxMembers: number): boolean {
  return seatsLeft(memberCount, maxMembers) === 0;
}

/**
 * Whether the student may ask to join a group they can see on discover.
 *
 * Mirrors request_to_join (0005): the group must be live, joinable, have room,
 * and not already hold a pending request from this student.
 */
export function canRequestToJoin(group: {
  status: GroupStatus;
  member_count: number;
  max_members: number;
  already_requested: boolean;
}): boolean {
  return (
    isJoinable(group.status) &&
    !isFull(group.member_count, group.max_members) &&
    !group.already_requested
  );
}

/**
 * Whether `role` may invite into a group.
 *
 * Mirrors send_invitation (0005): the creator may always invite; a plain member
 * may invite only while the group is discoverable. Both need the group live and
 * with a free seat — inviting into a full group would only fail on accept.
 */
export function canInvite(
  role: GroupRole,
  group: {
    status: GroupStatus;
    is_discoverable: boolean;
    max_members: number;
  },
  memberCount: number
): boolean {
  if (!isLive(group.status)) return false;
  if (isFull(memberCount, group.max_members)) return false;
  return role === 'creator' || group.is_discoverable;
}

/** Creator-only powers: rename, discoverability, archive, remove, approve. */
export function isCreator(role: GroupRole | null | undefined): boolean {
  return role === 'creator';
}

/**
 * A student's name for display, with a fallback.
 *
 * full_name is nullable in the schema (a student can finish auth before
 * onboarding writes their profile), and rendering an empty string leaves a
 * blank row that looks like a loading bug.
 */
export function displayName(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  return trimmed.length > 0 ? trimmed : 'Unnamed student';
}

/** "Ada Obi (creator)" — roster line, role only when it carries information. */
export function memberLine(member: GroupMemberDetailRow): string {
  const name = displayName(member.full_name);
  return member.role === 'creator' ? `${name} (creator)` : name;
}

/**
 * Groups the student is in, ordered the way the list screen wants them:
 * live groups before closed ones, then most recently active first.
 *
 * Sorting client-side rather than in the query because the useful ordering is
 * by a computed liveness bucket, and this list is a handful of rows.
 */
export function sortMyGroups(groups: MyGroupRow[]): MyGroupRow[] {
  return [...groups].sort((a, b) => {
    const liveDiff = Number(isLive(b.status)) - Number(isLive(a.status));
    if (liveDiff !== 0) return liveDiff;
    return (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? '');
  });
}

/**
 * Default name for a new group, e.g. "CSC 201 Study Group".
 *
 * Matches the shape run-batch-matching uses for system groups (which appends a
 * number), so a course's groups read consistently however they were formed.
 */
export function defaultGroupName(courseCode: string | null | undefined): string {
  const code = (courseCode ?? '').trim();
  return code.length > 0 ? `${code} Study Group` : 'Study Group';
}

/** Percent of a match score, for a compact "78% match" badge. */
export function scorePercent(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.round(Math.min(1, Math.max(0, score)) * 100);
}

// ---------------------------------------------------------------------------
// "When you can all meet" (group_common_availability, migrations 0010 + 0012)
// ---------------------------------------------------------------------------

/**
 * How the group's shared grid was computed, in words.
 *
 * `group_common_availability` marks a slot when `free >= meet_threshold`, and
 * since 0012 that threshold is the member count below four members and a
 * majority at four or more. The caption has to say which, because "3 slots
 * work" means something different under each — and the client must not
 * re-derive the rule from the roster length: the RPC counts members enrolled in
 * the group's COURSE, which is a smaller number for a member who has since
 * dropped it. Both numbers come back from the RPC for exactly that reason.
 *
 * Returns the phrase alone (no leading count) so the caller controls the
 * sentence: "3 slots where all 3 of you are free."
 */
export function meetRuleLabel(membersCounted: number, meetThreshold: number): string {
  if (membersCounted <= 0) return 'where the group is free';
  if (meetThreshold >= membersCounted) {
    return membersCounted === 1
      ? 'where you are free'
      : `where all ${membersCounted} of you are free`;
  }
  return `where at least ${meetThreshold} of ${membersCounted} are free`;
}

/**
 * Whether a slot needs EVERY counted member free, i.e. the group is small
 * enough that "when you can all meet" is literal. Drives the empty-state
 * wording, which otherwise promises an answer the rule cannot give.
 */
export function requiresEveryone(
  membersCounted: number,
  meetThreshold: number
): boolean {
  return membersCounted > 0 && meetThreshold >= membersCounted;
}

// ---------------------------------------------------------------------------
// How you rate yourself (user_courses.proficiency, migration 0020)
// ---------------------------------------------------------------------------

/**
 * The three bands, in the student's words rather than the column's.
 *
 * 0020's §1 comment points at this table by name — change one, change both.
 *
 * Three bands and not a 1–10 slider: the scorer only ever asks how far apart two
 * students are, so precision it cannot use is precision that invites people to
 * round themselves upward. Three is also answerable honestly in one tap.
 *
 * Worded as how the course is GOING, never as how good the student is, because
 * "struggling" has to be a safe thing to pick. It is the answer that gets you a
 * group with somebody who can explain; a student who picks the top band to look
 * competent gets matched as the explainer instead.
 */
export const PROFICIENCY_LABEL: Record<Proficiency, string> = {
  1: 'Struggling',
  2: 'Getting by',
  3: 'Fairly confident',
};

export const PROFICIENCY_HINT: Record<Proficiency, string> = {
  1: 'Lost in most of it, or behind and trying to catch up.',
  2: 'Following along, but parts of it still do not click.',
  3: 'Comfortable enough to explain most of it to someone else.',
};

/** Render order for the band chips: lowest first, so none of them reads as the default. */
export const PROFICIENCY_CHOICES: readonly Proficiency[] = [1, 2, 3];

/** Narrow an unknown/legacy column value to a band, or null. */
export function asProficiency(value: unknown): Proficiency | null {
  return value === 1 || value === 2 || value === 3 ? value : null;
}

// ---------------------------------------------------------------------------
// Applying to be matched (user_courses.applied_at + matching_windows, 0020)
// ---------------------------------------------------------------------------

/** Whether a registration period is open, coming, or not scheduled at all. */
export type WindowPhase = 'open' | 'upcoming' | 'none';

export function windowPhase(state: MatchingWindowState | null | undefined): WindowPhase {
  if (!state || !state.window_id) return 'none';
  return state.is_open ? 'open' : 'upcoming';
}

/**
 * The instant to date everything against: the SERVER's, not the device's.
 *
 * `matching_window_state()` returns `server_now` for exactly this reason. A phone
 * whose clock is a day out would otherwise read an open window's deadline as
 * "Yesterday" and leave the student staring at a live Apply button under text
 * telling them they are too late. The timezone stays the device's — that part it
 * is right about — so only the instant comes from the server.
 *
 * Exported because the Apply screen dates `applied_at` with it too: two clocks on
 * one screen is how "applied Today" ends up under "open until Yesterday".
 */
export function serverNow(state: MatchingWindowState | null | undefined): Date {
  const parsed = new Date(state?.server_now ?? '');
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/** "Today, 5pm" / "12 September, 11:30am" — when a window opens or shuts. */
export function windowWhenLabel(
  iso: string | null | undefined,
  now: Date = new Date()
): string {
  if (!iso) return '';
  const day = dayLabel(localDayKey(iso), now);
  const clock = formatClock(iso);
  if (!day) return clock;
  return clock ? `${day}, ${clock}` : day;
}

/**
 * One line about the registration period, for the top of the Apply screen.
 *
 * The 'none' wording is load-bearing: a closed window is not a closed app. It
 * says what still works, because everything except automatic matching does.
 */
export function windowBanner(state: MatchingWindowState | null | undefined): string {
  const now = serverNow(state);
  switch (windowPhase(state)) {
    case 'open':
      return `${state?.label ?? 'Matching'} is open until ${windowWhenLabel(
        state?.closes_at,
        now
      )}.`;
    case 'upcoming':
      return `${state?.label ?? 'Matching'} opens ${windowWhenLabel(state?.opens_at, now)}.`;
    case 'none':
      return 'No matching period is scheduled. You can still browse groups, ask to join one, or start your own.';
  }
}

/**
 * Where one enrolment stands in the matching flow.
 *
 * Precedence matters and 'grouped' comes first on purpose: `request_matching`
 * never clears `applied_at` and nothing else does either, because matched state
 * is DERIVED from group membership rather than stored. Resolved in the other
 * order, a student who had already been placed would be told they were still
 * waiting. The same derivation is what lets leaving a group put you back in the
 * pool with nothing to re-submit.
 */
export type MatchingStep =
  | 'grouped'
  | 'applied'
  | 'needs_rating'
  | 'needs_availability'
  | 'ready';

export function matchingStep(
  enrolment: { proficiency: Proficiency | null; applied_at: string | null },
  slotCount: number,
  isGroupedOnCourse: boolean
): MatchingStep {
  if (isGroupedOnCourse) return 'grouped';
  if (enrolment.applied_at) return 'applied';
  if (enrolment.proficiency == null) return 'needs_rating';
  if (slotCount <= 0) return 'needs_availability';
  return 'ready';
}

export const MATCHING_STEP_TITLE: Record<MatchingStep, string> = {
  grouped: 'You are in a group for this course',
  applied: 'You are in the pool, waiting to be matched',
  needs_rating: 'Say how this course is going',
  needs_availability: 'Pick some free time',
  ready: 'Ready to be matched',
};

/**
 * The paragraph under that title. The window only changes the wording of one
 * step — 'ready' — because it only ever gated one action.
 */
export function matchingStepBody(step: MatchingStep, phase: WindowPhase): string {
  switch (step) {
    case 'grouped':
      return 'Nothing left to do here. If you leave the group you go back in the pool, and the next matching run will place you again.';
    case 'applied':
      return 'Matching runs once the period closes, and you cannot withdraw — so leave your rating and free time as they are. They are what you will be matched on.';
    case 'needs_rating':
      return 'Matching puts students at different levels together, so that somebody in the group can explain. It needs your own answer before it can do that.';
    case 'needs_availability':
      return 'Matching starts from when you are free. A course with no free time picked has nothing to match on.';
    case 'ready':
      return phase === 'open'
        ? 'Applying puts you in the pool for this course. It only goes one way: once you are in, you wait for the run.'
        : 'You have everything matching needs. It opens when a coordinator schedules the next period — until then you can browse groups for this course, ask to join one, or wait to be invited.';
  }
}

/** Mirrors `request_matching`'s own gate: ready, and a window actually open. */
export function canApplyForMatching(step: MatchingStep, phase: WindowPhase): boolean {
  return step === 'ready' && phase === 'open';
}
