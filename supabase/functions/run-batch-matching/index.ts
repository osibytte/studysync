// ============================================================================
// StudySync — Stage 2: run-batch-matching Edge Function
//                       (admin-initiated system matching)
// ----------------------------------------------------------------------------
// POST { course_id, dry_run?, min_pool?, target_min?, target_max? }
//
// The opposite pole of find-group. Where find-group is pull/read-only/one
// student, this is push/write/whole-pool: an operator triggers group FORMATION
// over a course's pool of students waiting to be system-matched, once enough
// have enrolled ("signify to the system when to begin the group matching").
//
// WHO CAN CALL IT — "admin" = whoever holds the service_role key:
// There is deliberately no admin user or role in the schema. This function
// authorises by requiring the Authorization bearer token to equal
// SUPABASE_SERVICE_ROLE_KEY; anything else is 403. Because the check is entirely
// in-function, DEPLOY IT WITH --no-verify-jwt (otherwise the platform's own JWT
// gate rejects the service key before this code runs):
//
//     supabase functions deploy run-batch-matching --no-verify-jwt
//
// THE POOL — who gets matched:
//   user_courses on this course with applied_at set — the students who asked to
//   be matched during a registration window, via the request_matching RPC
//   (migration 0020) — minus anyone already in a group on this course. Students
//   who never applied, or who already self-organised into a group, are excluded:
//   "the self-matching students are not among".
//
//   Being in the pool is one timestamped fact, not a preference. There is no
//   withdrawal, and matched state is DERIVED from group membership rather than
//   stored — so a student who leaves a system group re-enters the pool and the
//   next run picks them up.
//
// It reuses the SAME scoring the client and find-group use (the mirrored
// _shared/matching.ts) via partitionIntoGroups, then writes each group through
// the service-role-only create_system_group RPC (migration 0007, rewritten in
// 0020) — the only write path; this function never inserts into group tables
// directly. That RPC also writes each new member's 'group_matched' notification
// in the same transaction, so a run that dies here can never leave a student
// placed in a group and never told.
//
// Unlike find-group there is no privacy masking: the caller IS the trusted
// operator (service role), so the run summary may name members and ids.
//
// Secrets SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
// ============================================================================

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.48.1';
import { decodeAvailability } from '../_shared/availability.ts';
import { partitionIntoGroups, type PartitionMember } from '../_shared/matching.ts';

// Guardrails. The pool scan is capped so one enormous course can't turn a batch
// run into a runaway query; groups form with capacity 5 (the product's group
// cap, matching find-group and the groups CHECK in 0027).
const MAX_POOL = 500;
const GROUP_MAX_MEMBERS = 5;

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

/**
 * Response contract — the server's copy of BatchMatchResult / BatchMatchGroup in
 * src/types/matching.ts. Duplicated here rather than imported for the same
 * reason the scoring is mirrored: the functions tree does not reach up into src/.
 */
interface BatchMatchGroup {
  group_id?: string;
  group_name: string;
  size: number;
  member_names: (string | null)[];
  member_ids: string[];
  cohesion: number;
}
interface BatchMatchResult {
  ran: boolean;
  reason?: string;
  course_id: string;
  pool_size: number;
  dry_run: boolean;
  groups: BatchMatchGroup[];
  waiting: string[];
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Use POST.' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server is not configured for matching.' }, 500);
  }

  // ---- 1. Authorise: the caller must hold the service_role key --------------
  // "admin" is whoever presents that key. The token is a shared server secret on
  // both sides, so a plain compare is acceptable here; deploy --no-verify-jwt so
  // this is the only gate.
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token || token !== serviceKey) {
    return json({ error: 'This endpoint requires the service_role key.' }, 403);
  }

  // ---- 2. Parse + validate input -------------------------------------------
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Send a JSON body with a course_id.' }, 400);
  }

  const courseId = typeof body?.course_id === 'string' ? body.course_id : undefined;
  if (!courseId) {
    return json({ error: 'course_id is required.' }, 400);
  }
  const dryRun = body?.dry_run === true;

  const minPool = intOr(body?.min_pool, 0);
  if (minPool < 0) {
    return json({ error: 'min_pool must be 0 or more.' }, 400);
  }

  // target_min/target_max default to the product's 3–5. target_min must be >= 3:
  // the partitioner's "never strand a single" shrink can drop a target by one, so
  // a floor of 3 guarantees no group smaller than a pair. Cap at the group size.
  const targetMin = intOr(body?.target_min, 3);
  const targetMax = intOr(body?.target_max, 5);
  if (!(targetMin >= 3 && targetMax >= targetMin && targetMax <= GROUP_MAX_MEMBERS)) {
    return json(
      {
        error: `target_min/target_max must satisfy 3 <= target_min <= target_max <= ${GROUP_MAX_MEMBERS}.`,
      },
      400
    );
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    // ---- 3. Load the course (for group naming) ----------------------------
    const { data: course, error: courseErr } = await admin
      .from('courses')
      .select('course_id, course_code, course_title')
      .eq('course_id', courseId)
      .maybeSingle();
    if (courseErr) throw courseErr;
    if (!course) {
      return json({ error: 'No such course.' }, 404);
    }

    // ---- 4. Load the pool -------------------------------------------------
    const { members, byId } = await loadPool(admin, courseId);

    // ---- 5. Min-pool guard: let the operator hold for "a good number" ------
    if (members.length < minPool) {
      const result: BatchMatchResult = {
        ran: false,
        reason: `Only ${members.length} student(s) waiting; min_pool is ${minPool}. Nothing was formed.`,
        course_id: courseId,
        pool_size: members.length,
        dry_run: dryRun,
        groups: [],
        waiting: members.map((m) => m.id),
      };
      return json(result);
    }

    // ---- 6. Partition into groups (mirrored scoring) ----------------------
    const partition = partitionIntoGroups(members, { targetMin, targetMax });

    // ---- 7. Write (unless dry_run), sequentially --------------------------
    // Sequential so a mid-run error leaves already-created groups intact and we
    // can report how far we got. Re-running is self-healing: formed members drop
    // out of the next pool, so only the still-ungrouped are regrouped.
    const groups: BatchMatchGroup[] = [];
    let writeError: string | null = null;
    let k = 1;
    for (const g of partition.groups) {
      const name = `${course.course_code} Study Group ${k}`;
      if (dryRun) {
        groups.push(toBatchGroup(g, name, byId));
      } else {
        const groupId = crypto.randomUUID();
        const { error } = await admin.rpc('create_system_group', {
          p_group_id: groupId,
          p_group_name: name,
          p_course_id: courseId,
          p_member_ids: g.memberIds,
          p_creator_id: g.seedId,
          p_max_members: GROUP_MAX_MEMBERS,
        });
        if (error) {
          writeError = `group ${k} ("${name}"): ${error.message}`;
          break;
        }
        groups.push(toBatchGroup(g, name, byId, groupId));
      }
      k++;
    }

    // ---- 8. Respond -------------------------------------------------------
    const result: BatchMatchResult = {
      ran: true,
      course_id: courseId,
      pool_size: members.length,
      dry_run: dryRun,
      groups,
      waiting: partition.waiting,
    };
    if (writeError) {
      result.reason =
        `Stopped after a write error — formed ${groups.length} group(s), then ${writeError}. ` +
        `Already-formed groups are kept; re-run to finish the rest.`;
    }
    return json(result);
  } catch (err) {
    console.error('run-batch-matching failed:', err);
    return json({ error: 'Could not run batch matching right now.' }, 500);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Per-pool-member data kept alongside the scoring profile for naming/output. */
interface MemberInfo {
  name: string | null;
}

/**
 * The matching pool for a course: everyone who applied to be matched (applied_at
 * is not null) and is not already in a group on this course. Returns both the
 * scoring inputs (PartitionMember[]) and a lookup of name per user id for the
 * write phase and the response.
 *
 * `proficiency` rides along in the profile: 0020's CHECK means an applied row
 * always has one, but older enrolments that never applied may not, and the
 * scorer's neutral fallback handles those rather than this query filtering them
 * out.
 */
async function loadPool(
  admin: SupabaseClient,
  courseId: string
): Promise<{ members: PartitionMember[]; byId: Map<string, MemberInfo> }> {
  const { data: enrolments, error } = await admin
    .from('user_courses')
    .select('user_id, availability, proficiency, applied_at, users ( full_name )')
    .eq('course_id', courseId)
    .not('applied_at', 'is', null)
    // Longest wait first, so if MAX_POOL ever truncates a course it truncates the
    // students who only just applied rather than the ones who have waited a week.
    .order('applied_at', { ascending: true })
    .limit(MAX_POOL);
  if (error) throw error;

  const grouped = await loadGroupedUserIdsForCourse(admin, courseId);

  const byId = new Map<string, MemberInfo>();
  const members: PartitionMember[] = [];
  for (const r of (enrolments ?? []) as any[]) {
    if (grouped.has(r.user_id)) continue; // already in a group on this course
    byId.set(r.user_id, { name: r.users?.full_name ?? null });
    members.push({
      id: r.user_id,
      profile: {
        availability: decodeAvailability(r.availability),
        proficiency:
          typeof r.proficiency === 'number' && Number.isFinite(r.proficiency)
            ? r.proficiency
            : null,
      },
    });
  }
  return { members, byId };
}

/** Every user already in some group on this course (excluded from the pool). */
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

/** Shape one partitioned group into the wire contract. Seed leads memberIds. */
function toBatchGroup(
  g: { memberIds: string[]; seedId: string; cohesion: number },
  name: string,
  byId: Map<string, MemberInfo>,
  groupId?: string
): BatchMatchGroup {
  return {
    ...(groupId ? { group_id: groupId } : {}),
    group_name: name,
    size: g.memberIds.length,
    member_names: g.memberIds.map((id) => byId.get(id)?.name ?? null),
    member_ids: g.memberIds,
    cohesion: g.cohesion,
  };
}

/** Parse a JSON number as an integer, falling back when absent/not finite. */
function intOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
}
