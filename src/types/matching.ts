/**
 * Wire contract for the `find-group` Edge Function (Pathway One, system
 * matching). The client imports these to type the response; the function
 * returns exactly this shape.
 *
 * Privacy posture (mirrors the search_students RPC): suggested partners and
 * group members are exposed by name and department only — never email, never a
 * raw availability mask. The function returns pre-computed, human-readable
 * summaries (a score, shared counts, a slot description) so the client can
 * render a match card without ever holding another student's data.
 */

/** The requester's own inputs, echoed back so the UI can explain a weak match. */
export interface FindGroupRequester {
  course_id: string;
  /** How many availability slots the requester has for this course. */
  slot_count: number;
}

/** The score breakdown surfaced on a match card. All terms are in [0, 1]. */
export interface MatchSummary {
  score: number;
  schedule_score: number;
  fill_score: number;
  shared_slots: number;
}

/** A ranked existing group the requester could ask to join (request_to_join). */
export interface ScoredGroup {
  group_id: string;
  group_name: string;
  course_id: string;
  status: string;
  member_count: number;
  max_members: number;
  /** Common-availability summary for the group, e.g. "Mon evening, Wed morning". */
  availability_summary: string;
  /** True if the requester already has a pending join request for this group. */
  already_requested: boolean;
  match: MatchSummary;
}

/**
 * A ranked lone student the requester could form a NEW group with (create_group
 * + send_invitation). memberCount is always 1 for these — the other student.
 */
export interface ScoredStudent {
  user_id: string;
  full_name: string | null;
  department: string | null;
  availability_summary: string;
  match: MatchSummary;
}

/** The full find-group response. */
export interface FindGroupResponse {
  requester: FindGroupRequester;
  /** Existing joinable groups, best match first. */
  groups: ScoredGroup[];
  /** Lone students to form a new group with, best match first. */
  suggested_partners: ScoredStudent[];
}

/**
 * Wire contract for the `run-batch-matching` Edge Function (admin-initiated
 * system matching). Unlike find-group, this endpoint is service-role only — the
 * caller is a trusted operator, not a student — so it may return member names
 * and ids. It is NOT consumed by the student app; these types exist for tooling
 * and an eventual operator view.
 */

/** One group the batch run formed (or would form, when dry_run). */
export interface BatchMatchGroup {
  /** Present only for groups actually created (absent on a dry run). */
  group_id?: string;
  group_name: string;
  size: number;
  /** Member display names, seed first (nulls for students with no name set). */
  member_names: (string | null)[];
  /** Member user ids, aligned with member_names. */
  member_ids: string[];
  /** Mean compatibility of the group to its seed, in [0, 1]. */
  cohesion: number;
}

/** The batch run summary. */
export interface BatchMatchResult {
  /** False when the run was skipped (e.g. pool below min_pool); see `reason`. */
  ran: boolean;
  reason?: string;
  course_id: string;
  /** How many students were eligible (matching_pref='system', not yet grouped). */
  pool_size: number;
  /** True when nothing was written — groups are proposals only. */
  dry_run: boolean;
  groups: BatchMatchGroup[];
  /** Ids of students left over (at most one) to be matched on the next run. */
  waiting: string[];
}
