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
  /**
   * Per-kind switches, all OPTIONAL and all defaulting to ON when absent.
   *
   * `notification_prefs` is jsonb and 0001's default does not contain these keys,
   * so every account created before Stage 5 is missing all of them. Absence is
   * therefore the normal case, not an edge case, and it has to mean something
   * sensible without a backfill — which is why the fallback lives in one place
   * (`notificationRules.ts`) rather than at each read site. Adding keys here needs
   * no migration at all; that is the reason the column was jsonb in the first
   * place.
   *
   * `push_enabled` above is the master switch and wins over all of them. The
   * 30-minute study alarm is governed by none of this: it is scheduled by the
   * device, is urgent, and the student turns it off through the OS.
   */
  notify_chat?: boolean;
  notify_files?: boolean;
  notify_sessions?: boolean;
  notify_invitations?: boolean;
  /** The four nudges, switchable one at a time because that is how a student keeps the ones they like. */
  nudge_needs_one_yes?: boolean;
  nudge_free_slot?: boolean;
  nudge_group_quiet?: boolean;
  nudge_unanswered_invitation?: boolean;
}

/**
 * The jsonb keys that switch a category of notification off, derived from
 * `NotificationPrefs` rather than typed out again.
 *
 * Derived on purpose: add a `notify_*` or `nudge_*` key above and it joins this
 * union automatically, which breaks `NOTIFICATION_PREF_KEY` and
 * `NOTIFICATION_SWITCH` in `notificationRules.ts` until the new switch has been
 * given a kind to govern and wording for the prefs screen. A hand-written union
 * would instead let a key exist that no screen ever shows and no sender ever
 * reads — which is the same silent-drift failure the availability bitmask and the
 * `kind` CHECK are both mirrored against.
 *
 * `quiet_hours_*`, `daily_cap` and `push_enabled` are deliberately excluded: they
 * are not per-category switches, and each has its own control.
 */
export type NotificationSwitchKey = Extract<
  keyof NotificationPrefs,
  `notify_${string}` | `nudge_${string}`
>;

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
 * How well the student reckons they understand a course, in their own words rather
 * than a mark: 1 struggling, 2 getting by, 3 fairly confident.
 *
 * Three bands, not five, chosen on 2026-09-05: a self-rating on a five-point scale
 * clusters on the middle and the extra precision is noise, whereas three are
 * answerable in one tap. Ordered, because the mixing rule in `src/lib/matching.ts`
 * subtracts one band from another — which is also why it is a number and not a
 * string. The words for each band live in `src/lib/groupRules.ts`
 * (`PROFICIENCY_LABEL`); change one, change both.
 */
export type Proficiency = 1 | 2 | 3;

export interface UserCourse {
  user_course_id: string;
  user_id: string;
  course_id: string;
  /** 28-char '0'/'1' string. Use src/lib/availability.ts to read or write it. */
  availability: string;
  /**
   * Null means the student has never said — NOT "average". Every row written
   * before 0020 has one, and the scorer reads an unknown as the middle band so
   * ranking degrades to schedule-only. Required before applying (0020's
   * `user_courses_applied_ready` check).
   */
  proficiency: Proficiency | null;
  /**
   * When they asked the system to match them on this course. Null = not in the
   * pool, which is the resting state: nothing enrols a student on their behalf.
   *
   * Set only by the `request_matching` RPC — `authenticated` holds no column
   * privilege on it (0020 §4), and there is no withdrawal (0020 §5 refuses the
   * delete that would fake one). Being *matched* is not stored: that is group
   * membership on the course.
   */
  applied_at: string | null;
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
 * enrolment detail for it (availability, proficiency, whether they have applied).
 * Assembled client-side from joined queries.
 */
export interface UserCourseWithDetail extends UserCourse {
  course: Course;
}

/**
 * One registration period (0020 §6). Non-overlapping by an exclusion constraint,
 * so "the open one" and "the next one" are single rows rather than a judgement call.
 *
 * It gates exactly one action, `request_matching`. Browsing discoverable groups,
 * asking to join one, being invited, starting your own and the find-group
 * suggestions all work identically whether a window is open, closed or has never
 * existed — the owner's rule on 2026-09-05: "the registration window only matters
 * to students that want the system to match them".
 */
export interface MatchingWindow {
  window_id: string;
  label: string;
  opens_at: string;
  closes_at: string;
  created_at: string;
}

/**
 * Return row of `matching_window_state()` — always exactly one row.
 *
 * `server_now` is the point of the RPC. Whether applications are open depends on a
 * clock, and the only clock the client has is the device's; a phone a day out would
 * otherwise disable the Apply button through an open window with nothing on screen
 * to explain it. So the screen compares two instants the server handed it.
 *
 * The window described is the open one if there is one, else the next one to open.
 * Everything but `server_now` is null when no window is open or pending — which is
 * the normal state before an admin has ever opened one, not an error.
 */
export interface MatchingWindowState {
  server_now: string;
  is_open: boolean;
  window_id: string | null;
  label: string | null;
  opens_at: string | null;
  closes_at: string | null;
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

// ---------------------------------------------------------------------------
// Stage 5 — notifications (0019)
// ---------------------------------------------------------------------------

/**
 * Every kind of notification the app can send. One definition, imported by
 * `notificationRules.ts`, which keys five exhaustive `Record`s on it — so adding a
 * member here fails the typecheck until the copy, the urgency, the
 * local-vs-remote answer, the cooldown and the pref switch that silences it have
 * all been supplied for it. That is deliberate.
 *
 * `'session_reminder'` is in the union but **cannot appear in the notifications
 * table** — see the check constraint in `0019`. It is scheduled on the device by
 * `notifier.ts` and fires from the OS with no server involved, so there is no
 * sender to write a ledger row, and a phone in airplane mode could not write one
 * anyway. `NOTIFICATION_LOCAL` in `notificationRules.ts` is the machine-readable
 * form of that split; the sender must never push a kind it marks true.
 *
 * The last four are the nudges the owner chose on 2026-09-05 for "whatever
 * notification is smart to indulge students to study". All non-urgent and capped,
 * because an engagement notification that ignores a student's stated limit is how
 * notifications get switched off at the OS level — taking the 30-minute study
 * alarm they actually wanted with them.
 *
 * `'group_matched'` (0020 §8) is the odd one out in a different way: it is the only
 * kind whose **words are composed in SQL**, inside `create_system_group`, because it
 * has to be written in the same transaction that creates the group — a run that
 * died in between would leave students grouped and never told, and nothing would
 * retry it. So it has no `NotificationSubject` arm in `notificationRules.ts`; that
 * file still owns its label, its urgency and its cooldown.
 */
export type NotificationKind =
  | 'session_reminder'
  | 'session_proposed'
  | 'session_confirmed'
  | 'session_cancelled'
  | 'message_activity'
  | 'file_shared'
  | 'invitation'
  | 'group_matched'
  | 'session_needs_one_yes'
  | 'group_free_slot'
  | 'group_quiet'
  | 'invitation_unanswered';

/** The subset `notifications.kind` accepts: everything a SERVER sends. */
export type SentNotificationKind = Exclude<NotificationKind, 'session_reminder'>;

/**
 * One row per notification the sender delivered to one student (0019).
 *
 * `title` and `body` are stored as sent rather than re-derived, so the inbox shows
 * what the phone showed: "4 new messages" stays true after a fifth arrives, and a
 * session whose time later moves does not silently rewrite the notification that
 * named the old one.
 *
 * `read_at` is the inbox's own cursor and is **not** `group_members.last_read_at`
 * — dismissing a notification is not reading the conversation.
 */
export interface Notification {
  notification_id: string;
  user_id: string;
  group_id: string | null;
  kind: SentNotificationKind;
  title: string;
  body: string;
  /** Exempt from `daily_cap`. Never true for a nudge. */
  urgent: boolean;
  dedupe_key: string;
  created_at: string;
  read_at: string | null;
}





