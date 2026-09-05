/**
 * Hand-written types mirroring the Stage 1 SQL schema.
 *
 * These are maintained by hand for now rather than generated, so that the
 * migrations stay the single source of truth and you are not required to have
 * the Supabase CLI wired up to get type safety. Once the schema settles after
 * Stage 2, `supabase gen types typescript` is the better long-term answer.
 *
 * If you change a migration, change this file in the same commit.
 */

/** Row shapes. `Insert`/`Update` variants omit DB-generated columns. */

export interface Course {
  course_id: string;
  course_code: string;
  course_title: string;
  department: string | null;
  created_at: string;
}

export interface NotificationPrefs {
  /** 'HH:MM' 24h. Quiet hours may wrap midnight (22:00 -> 07:00). */
  quiet_hours_start: string;
  quiet_hours_end: string;
  /** Non-urgent notifications per rolling day. Urgent alerts ignore this. */
  daily_cap: number;
  push_enabled: boolean;
}

export interface AppUser {
  user_id: string;
  full_name: string | null;
  email: string;
  department: string | null;
  notification_prefs: NotificationPrefs;
  onboarding_complete: boolean;
  created_at: string;
  updated_at: string;
}

export type AppUserUpdate = Partial<
  Pick<
    AppUser,
    'full_name' | 'department' | 'notification_prefs' | 'onboarding_complete'
  >
>;

/**
 * How a student wants to be grouped for a course. Defaults to 'system' on
 * enrolment, so a new student is in the batch-matching pool. Set to
 * 'self_organized' (via the set_matching_pref RPC) when they'd rather find their
 * own group — that removes them from admin-initiated batch matching.
 */
export type MatchingPref = 'system' | 'self_organized';

export interface UserCourse {
  user_course_id: string;
  user_id: string;
  course_id: string;
  /** 28-char '0'/'1' string. Use src/lib/availability.ts to read or write it. */
  availability: string;
  matching_pref: MatchingPref;
  created_at: string;
}

export type DevicePlatform = 'ios' | 'android';

export interface DevicePushToken {
  token_id: string;
  user_id: string;
  expo_token: string;
  platform: DevicePlatform;
  created_at: string;
  last_seen_at: string;
}

/**
 * Composite shape the UI actually renders — a course plus the student's
 * enrolment detail for it (availability, matching preference). Assembled
 * client-side from joined queries.
 */
export interface UserCourseWithDetail extends UserCourse {
  course: Course;
}

/** Defaults for a fresh profile, matching the SQL column default. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  quiet_hours_start: '22:00',
  quiet_hours_end: '07:00',
  daily_cap: 3,
  push_enabled: true,
};

// ===========================================================================
// Stage 2 — Group Formation. Mirrors migrations 0004–0012. Kept in sync with
// the SQL by hand (see the header note): change a migration, change this file.
// ===========================================================================

/**
 * The five stored lifecycle states from 0004. `status` is a queryable column,
 * never computed on read — set by the daily sweep (0006) and the membership
 * trigger (0005, disband on empty).
 */
export type GroupStatus =
  | 'forming'
  | 'active'
  | 'dormant'
  | 'archived'
  | 'disbanded';

export type GroupFormationType = 'system' | 'self_organized';
export type GroupRole = 'creator' | 'member';
export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';
export type JoinRequestStatus = 'pending' | 'approved' | 'declined' | 'cancelled';

export interface Group {
  group_id: string;
  group_name: string;
  course_id: string;
  formation_type: GroupFormationType;
  status: GroupStatus;
  is_discoverable: boolean;
  max_members: number;
  /** Audit pointer to the original creator; null if that account was deleted. */
  created_by: string | null;
  last_activity_at: string;
  created_at: string;
}

export interface GroupMember {
  member_id: string;
  group_id: string;
  user_id: string;
  role: GroupRole;
  joined_at: string;
}

export interface Invitation {
  invitation_id: string;
  group_id: string;
  inviter_id: string;
  invitee_id: string;
  status: InvitationStatus;
  created_at: string;
  responded_at: string | null;
}

export interface JoinRequest {
  request_id: string;
  group_id: string;
  requester_id: string;
  status: JoinRequestStatus;
  responded_by: string | null;
  created_at: string;
  responded_at: string | null;
}

/**
 * Return row of the `discover_groups(p_course_id, p_only_open)` RPC in 0005
 * (topic filtering removed in 0009). Not a table — a server-side projection that
 * exposes safe aggregates (member_count) without leaking the member roster.
 */
export interface DiscoverGroupRow {
  group_id: string;
  group_name: string;
  course_id: string;
  status: GroupStatus;
  member_count: number;
  max_members: number;
  already_requested: boolean;
}

/**
 * Return row of the `search_students(p_query, p_course_id, p_group_id)` RPC in
 * 0005. Name + department only — never email, per that function's privacy note.
 */
export interface StudentSearchRow {
  user_id: string;
  full_name: string | null;
  department: string | null;
}

// ---------------------------------------------------------------------------
// Read RPCs added in 0010, for the Stage 2 client screens.
//
// These exist because RLS on public.users is own-row only: a member can read
// `group_members` (ids and roles) but not the names behind those ids. Each of
// these is SECURITY DEFINER, gated on membership, and returns name + department
// only — the same privacy posture as search_students.
// ---------------------------------------------------------------------------

/** Return row of `group_members_detail(p_group_id)` — the roster, with names. */
export interface GroupMemberDetailRow {
  user_id: string;
  full_name: string | null;
  department: string | null;
  role: GroupRole;
  joined_at: string;
}

/** Return row of `my_invitations()` — the invitee's inbox, fully resolved. */
export interface InvitationDetailRow {
  invitation_id: string;
  group_id: string;
  group_name: string;
  course_id: string;
  course_code: string;
  course_title: string;
  inviter_id: string;
  inviter_name: string | null;
  member_count: number;
  max_members: number;
  group_status: GroupStatus;
  created_at: string;
}

/** Return row of `group_join_requests(p_group_id)` — who is asking to join. */
export interface JoinRequestDetailRow {
  request_id: string;
  requester_id: string;
  full_name: string | null;
  department: string | null;
  created_at: string;
}

/**
 * Return row of `group_common_availability(p_group_id)` — the group's shared
 * free time, plus the two numbers behind it (return shape widened in 0012).
 *
 * `common_mask` is a 28-character '0'/'1' string, character position = bit index
 * (day * 4 + slot); read it with decodeAvailability(). `members_counted` is how
 * many members were enrolled in the group's course, and `meet_threshold` how
 * many of them had to be free for a slot to count — equal to the count below
 * four members, a majority at four or more. Both come back so the screen can
 * name the rule in force instead of assuming one.
 */
export interface GroupCommonAvailabilityRow {
  common_mask: string;
  members_counted: number;
  meet_threshold: number;
}

/**
 * A group the signed-in student belongs to, as the groups list renders it.
 *
 * Assembled client-side from one nested select over group_members → groups →
 * courses (all three readable to a member under the 0005 policies), so it needs
 * no RPC. `role` is the caller's own role in that group.
 *
 * `member_count` is filled by a second small query for the rosters of exactly
 * these groups — allowed by group_members_select_member, since the caller is in
 * every one of them — rather than by the discover_groups RPC, which deliberately
 * excludes groups you are already in.
 */
export interface MyGroupRow extends Group {
  role: GroupRole;
  joined_at: string;
  member_count: number;
  course: Course | null;
}

// ===========================================================================
// Stage 3 — the group timeline. Mirrors migrations 0013–0018.
//
// One table, `messages`, carries three kinds of thing: what somebody typed, a
// study time somebody proposed, and a file somebody shared. Sessions and
// materials live in their own tables and the message row points at them, so the
// chat screen can page one ordered list and render three cards from it.
//
// Every write here goes through a SECURITY DEFINER RPC; `authenticated` holds
// SELECT and nothing else on all three tables (0015, 0016, 0017). There are
// deliberately no Insert/Update variants below.
// ===========================================================================

/**
 * Which card a message renders as. The `messages_kind_shape` CHECK (added with the
 * kind/session_id columns in 0016, widened for materials in 0017) ties each kind to
 * exactly one referent: 'text' carries neither, 'session' carries session_id, 'file'
 * carries material_id.
 */
export type MessageKind = 'text' | 'session' | 'file';

export interface Message {
  /** Generated on the device, so an optimistic bubble and its row are one thing. */
  message_id: string;
  group_id: string;
  sender_id: string;
  /** Empty string exactly when deleted_at is set — deleting really deletes text. */
  body: string;
  kind: MessageKind;
  session_id: string | null;
  material_id: string | null;
  created_at: string;
  deleted_at: string | null;
}

/**
 * Return row of `my_unread_counts()` (0014) — every badge in the app in one
 * round trip, for the caller's own memberships only.
 *
 * `last_*` describe the newest message that has not been deleted, so deleting
 * the last thing you said reveals the one before it instead of blanking the row.
 * Null when the group has no messages yet. Own messages never count as unread.
 */
export interface UnreadCountRow {
  group_id: string;
  unread_count: number;
  last_message_at: string | null;
  last_sender_id: string | null;
  last_body: string | null;
}

// ---------------------------------------------------------------------------
// Study times (0016). Proposed from the chat, agreed by the group, and managed
// there too — there is no separate sessions screen.
// ---------------------------------------------------------------------------

/**
 * 'proposed' -> 'confirmed' happens by itself: the handle_session_response
 * trigger flips it the moment enough members have said yes. 'cancelled' is
 * terminal and only the proposer or the group's creator can set it.
 */
export type SessionStatus = 'proposed' | 'confirmed' | 'cancelled';

export type SessionResponseValue = 'yes' | 'no' | 'maybe';

export interface StudySession {
  /** Client-generated, like message_id and for the same reason. */
  session_id: string;
  group_id: string;
  proposed_by: string;
  starts_at: string;
  /** 15 to 480 minutes. A length, not an ends_at, so it cannot precede the start. */
  duration_min: number;
  /** Free text: a room, someone's flat, a meeting link. Null if unspecified. */
  location: string | null;
  status: SessionStatus;
  created_at: string;
  cancelled_at: string | null;
  cancelled_by: string | null;
}

/**
 * One member's answer. Composite primary key (session_id, user_id), so changing
 * your mind updates in place rather than appending. Deny-all RLS: read these
 * through `group_sessions` or `session_attendees`, never directly.
 */
export interface SessionResponse {
  session_id: string;
  user_id: string;
  response: SessionResponseValue;
  responded_at: string;
}

/**
 * Return row of `group_sessions(p_group_id, p_include_past)` (0016) — one card
 * per proposal, with the tally already computed.
 *
 * `confirm_threshold` and `members_counted` come back so the card can name the
 * rule in force ("3 of 3 needed", "3 of 5 needed") rather than assuming one; the
 * threshold is everybody below four members and a majority at four or more, the
 * same shape as group_common_availability's meet_threshold. `my_response` is the
 * caller's own answer, null if they have not said anything yet. `message_id` is
 * the timeline card this session belongs to.
 *
 * Past sessions are excluded by default, where "past" means it started more than
 * an hour ago — a session in progress is still the thing you want on screen.
 */
export interface GroupSessionRow {
  session_id: string;
  message_id: string | null;
  starts_at: string;
  duration_min: number;
  location: string | null;
  status: SessionStatus;
  proposed_by: string;
  proposer_name: string | null;
  members_counted: number;
  yes_count: number;
  no_count: number;
  maybe_count: number;
  confirm_threshold: number;
  my_response: SessionResponseValue | null;
}

/**
 * Return row of `session_attendees(p_session_id)` (0016) — the whole roster, not
 * just the people who answered: a member who has said nothing appears with
 * `response` null, which is what makes "waiting on Ada" renderable. The proposer
 * sorts first, then by name.
 */
export interface SessionAttendeeRow {
  user_id: string;
  full_name: string | null;
  department: string | null;
  is_proposer: boolean;
  response: SessionResponseValue | null;
  responded_at: string | null;
}

// ---------------------------------------------------------------------------
// Shared files (0017, with the Storage read-back fix in 0018).
//
// The bytes live in the private `group-materials` Storage bucket, never in
// Postgres. The path is always `<group_id>/<material_id>/<file_name>` and that
// path is the permission: the Storage INSERT policy reads the first folder to
// decide whether you may write there, and attach_material refuses any path that
// does not start with the group and material it claims to be.
// ---------------------------------------------------------------------------

/** The bucket every group's files live in. Private; download via a signed URL. */
export const MATERIALS_BUCKET = 'group-materials';

/** 25 MB, matching the bucket's file_size_limit and the size_bytes CHECK. */
export const MATERIALS_MAX_BYTES = 26_214_400;

export interface Material {
  /** Client-generated: it is half of the storage path, so it exists before upload. */
  material_id: string;
  group_id: string;
  uploaded_by: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  /**
   * Soft delete. Setting this revokes the download for everybody at once,
   * including whoever uploaded it, because the Storage read policy asks this
   * table. The bytes must therefore be removed through the Storage API BEFORE
   * delete_material is called — after it, nobody can reach them to clean up.
   */
  deleted_at: string | null;
  deleted_by: string | null;
}

/**
 * Return row of `group_materials(p_group_id, p_include_deleted)` (0017) — the
 * files tab, newest first.
 *
 * Removed files are included by default and marked, rather than hidden, so the
 * tab explains a gap instead of leaving one; pass false for the live-only list.
 * `storage_path` is here because the client needs it to ask for a signed URL, and
 * `uploader_name` because RLS on public.users is own-row only — the same reason
 * every other Stage 2 read RPC resolves names server-side.
 */
export interface GroupMaterialRow {
  material_id: string;
  message_id: string | null;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string;
  uploader_name: string | null;
  created_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}





