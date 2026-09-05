import { makeActionId } from './ids';
import { supabase } from './supabase';
import type {
  DiscoverGroupRow,
  GroupCommonAvailabilityRow,
  GroupMemberDetailRow,
  InvitationDetailRow,
  JoinRequestDetailRow,
  MatchingPref,
  StudentSearchRow,
} from '@/types/database';
import type { FindGroupResponse } from '@/types/matching';

/**
 * Typed wrappers over the Stage 2 group RPCs (migrations 0005, 0007, 0009–0012)
 * and the `find-group` Edge Function.
 *
 * WHY A WRAPPER LAYER. Three things would otherwise be repeated in every screen
 * and get one of them wrong:
 *
 *   1. `p_client_action_id`. Every write RPC takes one and records it via
 *      claim_client_action, so a replayed call is a no-op instead of a second
 *      group. The caller passes an id when the action came off the outbox (so
 *      the replay carries the SAME id it was queued with); otherwise one is
 *      generated here.
 *   2. Argument names. PostgREST matches RPC arguments by name, so a typo in
 *      `p_group_id` is a runtime 404 rather than a compile error. Naming them
 *      once here is the only place that can go wrong.
 *   3. Error shape. `.rpc()` returns `{ data, error }`; a screen that forgets to
 *      check `error` silently does nothing. These throw, so a caller's try/catch
 *      is the single path.
 *
 * Every function here is online-only by itself. Offline capability for the three
 * actions that have it (`group.create`, `group.leave`, `matching.pref`) lives in
 * outbox.ts, which calls back into these with the queued action's id.
 */

/** Thrown for a failed RPC. Screens map it with friendlyError(). */
function unwrap<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw result.error;
  return result.data;
}

// ---------------------------------------------------------------------------
// Writes — group lifecycle
// ---------------------------------------------------------------------------

export interface CreateGroupArgs {
  /** Generated client-side so an optimistic row and the server row share an id. */
  groupId: string;
  groupName: string;
  courseId: string;
  isDiscoverable?: boolean;
  /** Supplied when replaying a queued action, so the replay is idempotent. */
  clientActionId?: string;
}

/**
 * Create a self-organized group; the caller becomes its creator.
 *
 * `groupId` is deliberately a client-generated uuid (see create_group's note in
 * 0005): the optimistic card the student sees and the row Postgres writes are
 * then the same object, so nothing has to be reconciled when the write lands.
 */
export async function createGroup(args: CreateGroupArgs): Promise<string> {
  return unwrap(
    await supabase.rpc('create_group', {
      p_client_action_id: args.clientActionId ?? makeActionId(),
      p_group_id: args.groupId,
      p_group_name: args.groupName,
      p_course_id: args.courseId,
      p_formation_type: 'self_organized',
      p_is_discoverable: args.isDiscoverable ?? true,
    })
  );
}

/** Leave a group. The 0005 trigger handles creator transfer and disband-on-empty. */
export async function leaveGroup(
  groupId: string,
  clientActionId?: string
): Promise<void> {
  unwrap(
    await supabase.rpc('leave_group', {
      p_client_action_id: clientActionId ?? makeActionId(),
      p_group_id: groupId,
    })
  );
}

/** Creator-only: rename. */
export async function renameGroup(groupId: string, groupName: string): Promise<void> {
  unwrap(
    await supabase.rpc('rename_group', {
      p_client_action_id: makeActionId(),
      p_group_id: groupId,
      p_group_name: groupName,
    })
  );
}

/** Creator-only: show the group on discover, or hide it (invite-only). */
export async function setGroupDiscoverable(
  groupId: string,
  isDiscoverable: boolean
): Promise<void> {
  unwrap(
    await supabase.rpc('set_group_discoverable', {
      p_client_action_id: makeActionId(),
      p_group_id: groupId,
      p_is_discoverable: isDiscoverable,
    })
  );
}

/** Creator-only: archive. Members keep read access; the group leaves discovery. */
export async function archiveGroup(groupId: string): Promise<void> {
  unwrap(
    await supabase.rpc('archive_group', {
      p_client_action_id: makeActionId(),
      p_group_id: groupId,
    })
  );
}

/** Creator-only: remove someone else. Creators leave via leaveGroup instead. */
export async function removeMember(
  groupId: string,
  targetUserId: string
): Promise<void> {
  unwrap(
    await supabase.rpc('remove_member', {
      p_client_action_id: makeActionId(),
      p_group_id: groupId,
      p_target_user_id: targetUserId,
    })
  );
}

// ---------------------------------------------------------------------------
// Writes — invitations and join requests (Pathway Two)
// ---------------------------------------------------------------------------

/** Invite a specific student. Returns the new invitation id, or null on replay. */
export async function sendInvitation(
  groupId: string,
  inviteeId: string
): Promise<string | null> {
  return unwrap(
    await supabase.rpc('send_invitation', {
      p_client_action_id: makeActionId(),
      p_group_id: groupId,
      p_invitee_id: inviteeId,
    })
  );
}

/** Accept or decline an invitation addressed to you. Returns the new status. */
export async function respondInvitation(
  invitationId: string,
  accept: boolean
): Promise<string | null> {
  return unwrap(
    await supabase.rpc('respond_invitation', {
      p_client_action_id: makeActionId(),
      p_invitation_id: invitationId,
      p_accept: accept,
    })
  );
}

/** Ask to join a discoverable group. Returns the new request id, or null on replay. */
export async function requestToJoin(groupId: string): Promise<string | null> {
  return unwrap(
    await supabase.rpc('request_to_join', {
      p_client_action_id: makeActionId(),
      p_group_id: groupId,
    })
  );
}

/**
 * Approve or decline an incoming join request.
 *
 * Creator-only server-side (respond_join_request follows the spec's roles table
 * rather than its Pathway Two prose), so a plain member sees requests but the
 * call fails for them — the UI hides the buttons rather than relying on that.
 */
export async function respondJoinRequest(
  requestId: string,
  approve: boolean
): Promise<string | null> {
  return unwrap(
    await supabase.rpc('respond_join_request', {
      p_client_action_id: makeActionId(),
      p_request_id: requestId,
      p_approve: approve,
    })
  );
}

/**
 * Opt this course in or out of admin-initiated batch matching.
 *
 * Takes an optional `clientActionId` for the same reason createGroup does: this
 * is the third action the outbox can replay, so the queued id has to survive
 * into the RPC or the replay would claim a fresh ledger row.
 */
export async function setMatchingPref(
  courseId: string,
  pref: MatchingPref,
  clientActionId?: string
): Promise<void> {
  unwrap(
    await supabase.rpc('set_matching_pref', {
      p_client_action_id: clientActionId ?? makeActionId(),
      p_course_id: courseId,
      p_pref: pref,
    })
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Discoverable groups on a course, excluding ones the caller is already in. */
export async function discoverGroups(
  courseId: string,
  onlyOpen = false
): Promise<DiscoverGroupRow[]> {
  const data = unwrap(
    await supabase.rpc('discover_groups', {
      p_course_id: courseId,
      p_only_open: onlyOpen,
    })
  );
  return (data ?? []) as DiscoverGroupRow[];
}

/** The roster of a group you belong to, with names (0010). */
export async function groupMembersDetail(
  groupId: string
): Promise<GroupMemberDetailRow[]> {
  const data = unwrap(
    await supabase.rpc('group_members_detail', { p_group_id: groupId })
  );
  return (data ?? []) as GroupMemberDetailRow[];
}

/**
 * The group's shared availability, with the rule that produced it (0010, shape
 * widened in 0012).
 *
 * An aggregate, not each member's grid — read `common_mask` with
 * decodeAvailability(). `meet_threshold` is how many members had to be free for
 * a slot to count: everyone below four members, a majority at four or more.
 *
 * A set-returning function, so PostgREST hands back an array of one row. A
 * missing row (only possible if the read itself is empty) degrades to an empty
 * mask counted over nobody, which the screen renders as "no availability yet"
 * rather than as a claim about the group.
 */
export async function groupCommonAvailability(
  groupId: string
): Promise<GroupCommonAvailabilityRow> {
  const data = unwrap(
    await supabase.rpc('group_common_availability', { p_group_id: groupId })
  );
  const row = (data as GroupCommonAvailabilityRow[] | null)?.[0];
  return row ?? { common_mask: '', members_counted: 0, meet_threshold: 0 };
}

/** Your pending invitations, with group, course and inviter resolved (0010). */
export async function myInvitations(): Promise<InvitationDetailRow[]> {
  const data = unwrap(await supabase.rpc('my_invitations', {}));
  return (data ?? []) as InvitationDetailRow[];
}

/** Pending join requests for a group you belong to, with names (0010). */
export async function groupJoinRequests(
  groupId: string
): Promise<JoinRequestDetailRow[]> {
  const data = unwrap(
    await supabase.rpc('group_join_requests', { p_group_id: groupId })
  );
  return (data ?? []) as JoinRequestDetailRow[];
}

/**
 * Find a student to invite, by name, within the group's course.
 *
 * Server-side search rather than a client filter because RLS hides other
 * students entirely — there is no local list to filter.
 */
export async function searchStudents(
  query: string,
  courseId: string,
  groupId: string
): Promise<StudentSearchRow[]> {
  const data = unwrap(
    await supabase.rpc('search_students', {
      p_query: query,
      p_course_id: courseId,
      p_group_id: groupId,
    })
  );
  return (data ?? []) as StudentSearchRow[];
}

// ---------------------------------------------------------------------------
// Edge Function — the matching brain
// ---------------------------------------------------------------------------

/**
 * Ask for ranked suggestions on a course: existing groups to join, plus lone
 * students to start a new group with.
 *
 * This is an Edge Function rather than an RPC because matching has to read other
 * students' availability, which RLS hides from the client — so it runs with the
 * service_role key server-side and returns only privacy-safe summaries. The
 * caller's JWT is attached automatically by supabase-js (`verify_jwt` is on for
 * this function), so an anonymous call never reaches the body.
 *
 * Read-only: it suggests. Acting on a suggestion is requestToJoin, or
 * createGroup + sendInvitation.
 */
export async function findGroup(courseId: string): Promise<FindGroupResponse> {
  const { data, error } = await supabase.functions.invoke<FindGroupResponse>(
    'find-group',
    { body: { course_id: courseId } }
  );
  if (error) throw error;
  if (!data) throw new Error('Matching returned no result. Please try again.');
  return data;
}
