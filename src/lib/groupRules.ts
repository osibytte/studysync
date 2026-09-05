import type {
  GroupMemberDetailRow,
  GroupRole,
  GroupStatus,
  MyGroupRow,
} from '@/types/database';

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
