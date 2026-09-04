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

export interface Topic {
  topic_id: string;
  course_id: string;
  topic_name: string;
  sort_order: number;
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

export interface UserCourseTopic {
  user_course_id: string;
  topic_id: string;
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
 * Composite shapes the UI actually renders — a course plus the student's
 * selections for it. Assembled client-side from joined queries.
 */
export interface UserCourseWithDetail extends UserCourse {
  course: Course;
  topic_ids: string[];
}

export interface CourseWithTopics extends Course {
  topics: Topic[];
}

/** Defaults for a fresh profile, matching the SQL column default. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  quiet_hours_start: '22:00',
  quiet_hours_end: '07:00',
  daily_cap: 3,
  push_enabled: true,
};

// ===========================================================================
// Stage 2 — Group Formation. Mirrors migrations 0004–0006. Kept in sync with
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

export interface GroupTopic {
  group_id: string;
  topic_id: string;
}

/**
 * Return row of the `discover_groups(p_course_id, p_topic_ids, p_only_open)`
 * RPC in 0005. Not a table — a server-side projection that exposes safe
 * aggregates (member_count, matched_topics) without leaking the member roster.
 */
export interface DiscoverGroupRow {
  group_id: string;
  group_name: string;
  course_id: string;
  status: GroupStatus;
  member_count: number;
  max_members: number;
  /** Count of the caller's supplied topic filter that this group shares. */
  matched_topics: number;
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
