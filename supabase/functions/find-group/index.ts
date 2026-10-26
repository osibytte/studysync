// ============================================================================
// StudySync — Stage 2: find-group Edge Function (Pathway One, system matching)
// ----------------------------------------------------------------------------
// POST { course_id }, authenticated by the caller's JWT.
//
// WHY THIS RUNS SERVER-SIDE (not in the app):
// RLS restricts public.users and public.user_courses to the owner — a student
// cannot read anyone else's availability. Matching needs exactly that data
// across many students, so it must run with the service_role key, which
// bypasses RLS. That key is an Edge Function secret and never ships in the app.
// The function reads privileged data, scores it with the SAME logic the client
// uses (the mirrored _shared/matching.ts), and returns ONLY privacy-safe fields
// (name + department, a score, shared counts) — never another student's email
// or raw availability mask.
//
// The function is READ-ONLY: it suggests. Acting on a suggestion (request_to_join,
// or create_group + send_invitation) is the client's job, through the RPCs in
// migration 0005.
//
// Secrets SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
// injected automatically by the Supabase platform — nothing to configure.
// ============================================================================

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.48.1';
import {
  decodeAvailability,
  describeSelection,
  groupScheduleProfile,
  type AvailabilityGrid,
} from '../_shared/availability.ts';
import {
  rankCandidates,
  violatesComposition,
  type Candidate,
  type ScoringProfile,
} from '../_shared/matching.ts';

// Group lifecycle states a requester can still join into. Mirrors the SQL
// filters in discover_groups / the RLS SELECT policy (0005).
const JOINABLE_STATUSES = ['forming', 'active', 'dormant'];

// Cap how many candidates we score, so one huge course can't turn a match into
// a slow, expensive query. Scoring itself is cheap; the DB reads are the cost.
const MAX_GROUPS_SCANNED = 100;
const MAX_LONE_STUDENTS_SCANNED = 200;
const MAX_RESULTS = 20;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** The score breakdown reshaped into the wire contract's snake_case summary. */
function toSummary(match: {
  score: number;
  scheduleScore: number;
  proficiencyScore: number;
  fillScore: number;
  sharedSlots: number;
}) {
  return {
    score: match.score,
    schedule_score: match.scheduleScore,
    proficiency_score: match.proficiencyScore,
    fill_score: match.fillScore,
    shared_slots: match.sharedSlots,
  };
}

/**
 * A candidate's representative level: the mean of whoever has rated the course.
 *
 * Null when nobody in it has, which the scorer reads as the neutral middle band
 * rather than as a claim. A mean rather than a min or a max because the pairwise
 * term measures the gap the requester would be joining across, and one confident
 * member does not make a group confident.
 */
function meanLevel(levels: number[]): number | null {
  if (levels.length === 0) return null;
  return levels.reduce((sum, level) => sum + level, 0) / levels.length;
}

/** A proficiency column value from the DB, kept only if it is a real rating. */
function readLevel(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Use POST.' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) {
    // A misconfigured deployment, not a client error.
    return json({ error: 'Server is not configured for matching.' }, 500);
  }

  // ---- 1. Identify the caller from their JWT ----------------------------
  // An anon-key client that forwards the caller's Authorization header resolves
  // auth.uid() exactly as the app would; we never trust a user id from the body.
  const authHeader = req.headers.get('Authorization') ?? '';
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const {
    data: { user },
    error: userError,
  } = await authClient.auth.getUser();
  if (userError || !user) {
    return json({ error: 'You must be signed in.' }, 401);
  }
  const uid = user.id;

  // ---- 2. Parse input ---------------------------------------------------
  let courseId: string | undefined;
  try {
    const body = await req.json();
    courseId = typeof body?.course_id === 'string' ? body.course_id : undefined;
  } catch {
    return json({ error: 'Send a JSON body with a course_id.' }, 400);
  }
  if (!courseId) {
    return json({ error: 'course_id is required.' }, 400);
  }

  // ---- 3. Privileged reads with the service-role client -----------------
  // This client bypasses RLS. It is used ONLY to read the data matching needs
  // and shape safe output; it never returns raw rows to the caller.
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const requester = await loadRequester(admin, uid, courseId);
    if (!requester) {
      return json(
        { error: 'Enrol in this course before finding a group for it.' },
        400
      );
    }

    const [groups, suggestedPartners] = await Promise.all([
      scoreExistingGroups(admin, uid, courseId, requester.profile),
      scoreLoneStudents(admin, uid, courseId, requester.profile),
    ]);

    return json({
      requester: {
        course_id: courseId,
        slot_count: countTrue(requester.profile.availability),
      },
      groups,
      suggested_partners: suggestedPartners,
    });
  } catch (err) {
    console.error('find-group failed:', err);
    return json({ error: 'Could not run matching right now.' }, 500);
  }
});

// ---------------------------------------------------------------------------
// Data loading + scoring. Kept as small named helpers so the request handler
// reads as the four-step flow it is.
// ---------------------------------------------------------------------------

interface RequesterData {
  userCourseId: string;
  profile: ScoringProfile;
}

/** The requester's own enrolment for this course: availability + self-rating. */
async function loadRequester(
  admin: SupabaseClient,
  uid: string,
  courseId: string
): Promise<RequesterData | null> {
  const { data, error } = await admin
    .from('user_courses')
    .select('user_course_id, availability, proficiency')
    .eq('user_id', uid)
    .eq('course_id', courseId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    userCourseId: data.user_course_id,
    profile: {
      availability: decodeAvailability(data.availability),
      proficiency: readLevel(data.proficiency),
    },
  };
}

/** Existing joinable groups on the course, scored and ranked. */
async function scoreExistingGroups(
  admin: SupabaseClient,
  uid: string,
  courseId: string,
  requester: ScoringProfile
) {
  // Groups the requester is already in — excluded from suggestions.
  const myGroupIds = await loadMyGroupIds(admin, uid, courseId);

  const { data: groupRows, error } = await admin
    .from('groups')
    .select('group_id, group_name, course_id, status, max_members')
    .eq('course_id', courseId)
    .eq('is_discoverable', true)
    .in('status', JOINABLE_STATUSES)
    .limit(MAX_GROUPS_SCANNED);
  if (error) throw error;

  const candidates = groupRows ?? [];
  const eligible = candidates.filter((g: any) => !myGroupIds.has(g.group_id));
  if (eligible.length === 0) return [];

  const groupIds = eligible.map((g: any) => g.group_id);

  // Members (for the count and for their per-course availability grids) and any
  // pending join requests the caller already has — two batched reads over the
  // eligible set rather than per-group round trips.
  const [membersByGroup, requestedGroupIds] = await Promise.all([
    loadMembersByGroup(admin, groupIds, courseId),
    loadRequestedGroupIds(admin, uid, groupIds),
  ]);

  type GroupCandidate = Candidate & {
    group_id: string;
    group_name: string;
    course_id: string;
    status: string;
    availability_summary: string;
    already_requested: boolean;
    /** Members' individual ratings — the composition caps count, not a mean. */
    levels: number[];
  };

  const shaped: GroupCandidate[] = eligible.map((g: any) => {
    const members = membersByGroup.get(g.group_id) ?? { count: 0, grids: [], levels: [] };
    const commonGrid = groupScheduleProfile(members.grids);
    return {
      group_id: g.group_id,
      group_name: g.group_name,
      course_id: g.course_id,
      status: g.status,
      availability_summary: describeSelection(commonGrid, 4),
      already_requested: requestedGroupIds.has(g.group_id),
      availability: commonGrid,
      proficiency: meanLevel(members.levels),
      levels: members.levels,
      // A member row should always exist (the creator), but fall back to the
      // real count if the members read returned nothing for this group.
      memberCount: members.count,
      maxMembers: g.max_members,
    };
  });

  // Drop full groups: a full group scores fillScore 0 and can't be joined, so
  // it is noise on a "find a group to join" list.
  const joinable = shaped.filter((g) => g.memberCount < g.maxMembers);

  // The composition caps govern automatic matching, and this IS automatic
  // matching: a group the requester would push over a cap — a second brilliant
  // student, one struggler too many for the size they would make it — is not
  // suggested, however good the schedule fit. They can still find it on
  // discover and ask by hand; this only governs what matching proposes.
  const compliant = joinable.filter(
    (g) =>
      !violatesComposition(
        [...g.levels, requester.proficiency],
        g.memberCount + 1
      )
  );

  return rankCandidates(requester, compliant)
    .slice(0, MAX_RESULTS)
    .map((c) => ({
      group_id: c.group_id,
      group_name: c.group_name,
      course_id: c.course_id,
      status: c.status,
      member_count: c.memberCount,
      max_members: c.maxMembers,
      availability_summary: c.availability_summary,
      already_requested: c.already_requested,
      match: toSummary(c.match),
    }));
}

/**
 * Lone students on the course — enrolled, not the requester, and not already in
 * any group on this course — as candidates to form a NEW group with.
 */
async function scoreLoneStudents(
  admin: SupabaseClient,
  uid: string,
  courseId: string,
  requester: ScoringProfile
) {
  // Everyone enrolled in this course (with their availability + name).
  const { data: enrolments, error } = await admin
    .from('user_courses')
    .select('user_id, availability, proficiency, users ( full_name, department )')
    .eq('course_id', courseId)
    .neq('user_id', uid)
    .limit(MAX_LONE_STUDENTS_SCANNED);
  if (error) throw error;

  const rows = enrolments ?? [];
  if (rows.length === 0) return [];

  // Anyone who is already in a group on this course is not "lone".
  const groupedUserIds = await loadGroupedUserIdsForCourse(admin, courseId);

  type StudentCandidate = Candidate & {
    user_id: string;
    full_name: string | null;
    department: string | null;
    availability_summary: string;
  };

  const shaped: StudentCandidate[] = rows
    .filter((r: any) => !groupedUserIds.has(r.user_id))
    // Composition caps for the hypothetical pairing too: matching never
    // suggests a pair of two strugglers (nobody to explain) or two brilliant
    // students (one explainer too many).
    .filter(
      (r: any) =>
        !violatesComposition(
          [requester.proficiency, readLevel(r.proficiency)],
          2
        )
    )
    .map((r: any) => {
      const grid = decodeAvailability(r.availability);
      return {
        user_id: r.user_id,
        full_name: r.users?.full_name ?? null,
        department: r.users?.department ?? null,
        availability_summary: describeSelection(grid, 4),
        availability: grid,
        proficiency: readLevel(r.proficiency),
        // A hypothetical pairing: the other student is the sole existing member.
        memberCount: 1,
        maxMembers: 5, // the product's group cap for a new group
      };
    });

  return rankCandidates(requester, shaped)
    .slice(0, MAX_RESULTS)
    .map((c) => ({
      user_id: c.user_id,
      full_name: c.full_name,
      department: c.department,
      availability_summary: c.availability_summary,
      match: toSummary(c.match),
    }));
}

// ---- small batched reads --------------------------------------------------

/** Group ids on this course that the caller already belongs to. */
async function loadMyGroupIds(
  admin: SupabaseClient,
  uid: string,
  courseId: string
): Promise<Set<string>> {
  const { data, error } = await admin
    .from('group_members')
    .select('group_id, groups!inner ( course_id )')
    .eq('user_id', uid)
    .eq('groups.course_id', courseId);
  if (error) throw error;
  return new Set((data ?? []).map((r: any) => r.group_id));
}

interface GroupMembership {
  count: number;
  grids: AvailabilityGrid[];
  /** Members' self-ratings on this course; unrated members are simply absent. */
  levels: number[];
}

/**
 * For each group id, its member count and the members' availability grids FOR
 * THIS COURSE (the grid is per-enrolment, so we join member -> that member's
 * user_course on the same course). A member with no enrolment row contributes
 * to the count but not the grid set.
 */
async function loadMembersByGroup(
  admin: SupabaseClient,
  groupIds: string[],
  courseId: string
): Promise<Map<string, GroupMembership>> {
  const result = new Map<string, GroupMembership>();
  if (groupIds.length === 0) return result;

  const { data: members, error } = await admin
    .from('group_members')
    .select('group_id, user_id')
    .in('group_id', groupIds);
  if (error) throw error;

  const memberRows = members ?? [];
  const memberUserIds = Array.from(new Set(memberRows.map((m: any) => m.user_id)));

  // One read of every relevant member's enrolment on this course.
  const availabilityByUser = new Map<string, AvailabilityGrid>();
  const levelByUser = new Map<string, number>();
  if (memberUserIds.length > 0) {
    const { data: courses, error: cErr } = await admin
      .from('user_courses')
      .select('user_id, availability, proficiency')
      .eq('course_id', courseId)
      .in('user_id', memberUserIds);
    if (cErr) throw cErr;
    for (const c of courses ?? []) {
      availabilityByUser.set((c as any).user_id, decodeAvailability((c as any).availability));
      const level = readLevel((c as any).proficiency);
      if (level !== null) levelByUser.set((c as any).user_id, level);
    }
  }

  for (const m of memberRows) {
    const gid = (m as any).group_id;
    const entry = result.get(gid) ?? { count: 0, grids: [], levels: [] };
    entry.count += 1;
    const grid = availabilityByUser.get((m as any).user_id);
    if (grid) entry.grids.push(grid);
    const level = levelByUser.get((m as any).user_id);
    if (level !== undefined) entry.levels.push(level);
    result.set(gid, entry);
  }
  return result;
}

/** Of the given group ids, those the caller has a pending join request for. */
async function loadRequestedGroupIds(
  admin: SupabaseClient,
  uid: string,
  groupIds: string[]
): Promise<Set<string>> {
  if (groupIds.length === 0) return new Set();
  const { data, error } = await admin
    .from('join_requests')
    .select('group_id')
    .eq('requester_id', uid)
    .eq('status', 'pending')
    .in('group_id', groupIds);
  if (error) throw error;
  return new Set((data ?? []).map((r: any) => r.group_id));
}

/** Every user already in some group on this course (to exclude from "lone"). */
async function loadGroupedUserIdsForCourse(
  admin: SupabaseClient,
  courseId: string
): Promise<Set<string>> {
  const { data, error } = await admin
    .from('group_members')
    .select('user_id, groups!inner ( course_id )')
    .eq('groups.course_id', courseId);
  if (error) throw error;
  return new Set((data ?? []).map((r: any) => r.user_id));
}

function countTrue(grid: AvailabilityGrid): number {
  return grid.reduce((n, free) => (free ? n + 1 : n), 0);
}
