// ============================================================================
// StudySync — Stage 5: send-push Edge Function (the Expo Push sender)
// ----------------------------------------------------------------------------
// The last unwritten piece of Stage 5. 0019 built the delivery ledger, 0020's
// create_system_group writes `group_matched` rows in SQL, 0021 added the push
// marker (`pushed_at`), the withhold reason (`withheld`) and the student's
// timezone — this function is the consumer of all of it. One invocation is one
// sweep, and it is safe to run twice on the same rows:
//
//   PHASE 1 — PUSH what the ledger already holds. Every row with
//   `pushed_at is null` and no terminal withholding is evaluated through the
//   decision core (the mirrored _shared/pushRules.ts): master switch, per-kind
//   switch, quiet hours on the student's own clock (users.timezone, falling
//   back to DEFAULT_TIMEZONE), then the daily cap — which counts rows where
//   pushed_at is set, which is why 0021 separates "written" from "sent".
//   Deliverable rows go to Expo Push for each of the student's device tokens;
//   `pushed_at` is set only when Expo returned an 'ok' ticket for at least one
//   of them, exactly as 0021's column comment demands. A refusal is STORED as
//   the reason (`withheld`), so quiet hours are a delay and a switched-off
//   kind is a decision the student can see the shape of.
//
//   PHASE 2 — COMPOSE what the ledger is missing. Chat stays watermarked, not
//   row-per-message (0019's own argument): one digest row per member per group
//   per watermark, keyed `message_activity:<group_id>:<watermark ISO>` so a
//   retried run collides with itself while the next run passes. Everything
//   else keys on its subject id — a session, a file, an invitation — which the
//   unique (user_id, dedupe_key) index turns into at-most-once. The four
//   nudges bucket their cooldowns into the key (week / fortnight), the same
//   cooldownBucket the client computes.
//
//   Phase order is load-bearing: push runs FIRST, so a quiet-hours row that
//   just became deliverable at 07:00 is pushed before the compose phase looks
//   at the same watermark and sees a pushed row — which is its signal to
//   advance the watermark rather than update the delivered row's count.
//
// WHO CAN CALL IT: the same answer as run-batch-matching — whoever holds
// SUPABASE_SERVICE_ROLE_KEY, or a function-scoped SENDER_SECRET set via
// `supabase secrets set` for the scheduler to use. Anything else is 403.
// DEPLOY WITH --no-verify-jwt or the platform gate rejects the service key
// before this code runs:
//
//     supabase functions deploy send-push --no-verify-jwt --use-api
//
// DRY RUN: POST { dry_run: true } (or header x-dry-run: 1) evaluates the whole
// pipeline — compose writes rows, watermarks advance, withholding is stamped —
// but never calls Expo and never sets pushed_at. This is what the live
// verification uses, and what a "what would you send?" check wants.
//
// SCHEDULING is a cron on the operator side (pg_cron + pg_net with the secret
// in a Vault entry, or any external timer POSTing to this URL). Every five
// minutes is plenty: the digest tolerates skips by design, and the compose
// window below re-scans a little further back than one tick to cover clock
// skew between ticks.
//
// Secrets SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by the
// platform. SENDER_SECRET is optional and operator-set.
// ============================================================================

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.48.1';
import {
  DEFAULT_TIMEZONE,
  NOTIFICATION_URGENT,
  cooldownBucket,
  kindEnabledFromPrefs,
  notificationContent,
  notificationDedupeKey,
  shouldNotify,
  withNotificationDefaults,
  zonedClock,
  type NotificationKind,
  type NotificationPrefs,
} from '../_shared/pushRules.ts';
import { DAYS, SLOTS, decodeAvailability } from '../_shared/availability.ts';

// The compose window re-scans behind the clock so a tick that lands seconds
// late never straddles an event; the dedupe keys make the overlap harmless.
const COMPOSE_WINDOW_MS = 15 * 60 * 1000;
// "A group that has gone quiet" per HANDOFF §8's nudge table.
const QUIET_GROUP_DAYS = 7;
// An invitation is chased ~48 hours after it was sent, once ever.
const UNANSWERED_INVITATION_HOURS = 48;
// The free-slot nudge stands down for a week once a session is confirmed.
const FREE_SLOT_HORIZON_DAYS = 7;
// Expo accepts at most 100 messages per request.
const EXPO_CHUNK = 100;
// Hard ceiling on rows touched per run, the run-batch-matching guardrail shape.
const MAX_CANDIDATES = 500;

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

interface PendingRow {
  notification_id: string;
  user_id: string;
  group_id: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
  urgent: boolean;
  withheld: string | null;
}

interface UserProfile {
  notification_prefs: Partial<NotificationPrefs> | null;
  timezone: string | null;
}

interface CandidateUser {
  prefs: NotificationPrefs;
  timezone: string | null;
  tokens: string[];
  deliveredNonUrgentToday: number;
}

interface LedgerInsert {
  user_id: string;
  group_id: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
  urgent: boolean;
  dedupe_key: string;
}

interface RunSummary {
  dry_run: boolean;
  considered: number;
  pushed: number;
  withheld: Record<string, number>;
  no_tokens: number;
  tokens_removed: number;
  composed: Record<string, number>;
  watermarks_advanced: number;
  errors: string[];
}

export async function runSweep(dryRun: boolean): Promise<RunSummary> {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const now = new Date();
  const nowIso = now.toISOString();
  const summary: RunSummary = {
    dry_run: dryRun,
    considered: 0,
    pushed: 0,
    withheld: {},
    no_tokens: 0,
    tokens_removed: 0,
    composed: {},
    watermarks_advanced: 0,
    errors: [],
  };
  const errors = summary.errors;

  // ========================================================================
  // PHASE 1 — push what the ledger holds.
  // ========================================================================
  const { data: pending, error: pendingError } = await supabase
    .from('notifications')
    .select(
      'notification_id, user_id, group_id, kind, title, body, urgent, withheld'
    )
    .is('pushed_at', null)
    .or('withheld.is.null,withheld.eq.quiet_hours')
    .order('created_at')
    .limit(MAX_CANDIDATES);
  if (pendingError) {
    errors.push(`pending scan: ${pendingError.message}`);
    return summary;
  }
  const rows = (pending ?? []) as PendingRow[];
  summary.considered = rows.length;

  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const users = new Map<string, CandidateUser>();

  if (userIds.length > 0) {
    const [profilesRes, tokensRes, capRes] = await Promise.all([
      supabase
        .from('users')
        .select('user_id, notification_prefs, timezone')
        .in('user_id', userIds),
      supabase
        .from('device_push_tokens')
        .select('user_id, expo_token')
        .in('user_id', userIds),
      // The moving 24-hour window 0021's cap index comment describes. Urgent
      // rows are exempt by definition, and the partial index already excludes
      // them server-side; the filter here keeps the count honest regardless.
      supabase
        .from('notifications')
        .select('user_id')
        .in('user_id', userIds)
        .eq('urgent', false)
        .not('pushed_at', 'is', null)
        .gte('pushed_at', new Date(now.getTime() - 24 * 3600_000).toISOString()),
    ]);
    if (profilesRes.error) errors.push(`profiles: ${profilesRes.error.message}`);
    if (tokensRes.error) errors.push(`tokens: ${tokensRes.error.message}`);
    if (capRes.error) errors.push(`cap count: ${capRes.error.message}`);

    for (const p of profilesRes.data ?? []) {
      const profile = p as { user_id: string; notification_prefs: UserProfile['notification_prefs']; timezone: string | null };
      users.set(profile.user_id, {
        prefs: withNotificationDefaults(profile.notification_prefs),
        timezone: profile.timezone,
        tokens: [],
        deliveredNonUrgentToday: 0,
      });
    }
    for (const t of tokensRes.data ?? []) {
      users.get((t as { user_id: string }).user_id)?.tokens.push(
        (t as { expo_token: string }).expo_token
      );
    }
    for (const c of capRes.data ?? []) {
      const user = users.get((c as { user_id: string }).user_id);
      if (user) user.deliveredNonUrgentToday += 1;
    }
  }

  // Evaluate oldest-first so a student catching up after quiet hours gets the
  // day's notifications in the order they happened, and so the cap consumes
  // the allowance in that same order.
  interface Deliverable {
    userId: string;
    notificationIds: string[];
    messages: { to: string; title: string; body: string; data: Record<string, string> }[];
    wasWithheldQuiet: boolean;
  }
  const deliverable = new Map<string, Deliverable>();
  const flat: { userId: string; msg: { to: string; title: string; body: string; data: Record<string, string> } }[] = [];
  const toWithhold: { id: string; reason: string }[] = [];
  const toUnwithhold: string[] = [];

  for (const row of rows) {
    const user = users.get(row.user_id);
    if (!user) continue; // no profile row — nothing to evaluate against
    const decision = shouldNotify({
      kind: row.kind,
      prefs: user.prefs,
      deliveredNonUrgentToday: user.deliveredNonUrgentToday,
      at: zonedClock(now, user.timezone),
      kindEnabled: kindEnabledFromPrefs(user.prefs),
    });
    if (!decision.deliver) {
      if (decision.withheld && decision.withheld !== row.withheld) {
        toWithhold.push({ id: row.notification_id, reason: decision.withheld });
      }
      summary.withheld[decision.withheld ?? 'unknown'] =
        (summary.withheld[decision.withheld ?? 'unknown'] ?? 0) + 1;
      continue;
    }
    if (user.tokens.length === 0) {
      // Left pending forever by design (0021): the inbox keeps the row, and a
      // student who registers a device later is told on the next sweep. A
      // withheld stamp no longer reflects a live refusal, so it goes — the row
      // is pending on a device, not on the student's choices.
      if (row.withheld !== null) {
        toUnwithhold.push(row.notification_id);
      }
      summary.no_tokens += 1;
      continue;
    }
    let entry = deliverable.get(row.user_id);
    if (!entry) {
      entry = {
        userId: row.user_id,
        notificationIds: [],
        messages: [],
        wasWithheldQuiet: row.withheld === 'quiet_hours',
      };
      deliverable.set(row.user_id, entry);
    }
    entry.notificationIds.push(row.notification_id);
    entry.wasWithheldQuiet = entry.wasWithheldQuiet || row.withheld === 'quiet_hours';
    for (const token of user.tokens) {
      const msg = {
        to: token,
        title: row.title,
        body: row.body,
        data: {
          notification_id: row.notification_id,
          kind: row.kind,
          group_id: row.group_id ?? '',
        },
      };
      entry.messages.push(msg);
      // Expo answers with one ticket per message, in request order — this flat
      // list is what maps a ticket back to the student it was for.
      flat.push({ userId: row.user_id, msg });
    }
    if (!row.urgent) user.deliveredNonUrgentToday += 1;
  }

  // Send, then mark. Expo accepts 100 messages per request.
  const okByUser = new Map<string, number>();
  const badTokens = new Set<string>();

  if (!dryRun && flat.length > 0) {
    for (let i = 0; i < flat.length; i += EXPO_CHUNK) {
      const chunk = flat.slice(i, i + EXPO_CHUNK);
      try {
        const res = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify(chunk.map((f) => f.msg)),
        });
        if (!res.ok) {
          errors.push(`expo http ${res.status} on ${chunk.length} message(s)`);
          continue;
        }
        const body = await res.json();
        const tickets = (body?.data ?? []) as {
          status: string;
          message?: string;
          details?: { error?: string };
        }[];
        chunk.forEach((f, offset) => {
          const ticket = tickets[offset];
          if (!ticket) return;
          if (ticket.status === 'ok') {
            okByUser.set(f.userId, (okByUser.get(f.userId) ?? 0) + 1);
          } else if (ticket.details?.error === 'DeviceNotRegistered') {
            // A dead device would wedge its student's queue into a permanent
            // error loop; retire the token so the next sweep sees no tokens
            // instead of a failing one.
            badTokens.add(f.msg.to);
          } else {
            errors.push(`expo ticket: ${ticket.message ?? 'unknown error'}`);
          }
        });
      } catch (e) {
        errors.push(`expo fetch: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Mark pushed only where at least one ticket was 'ok' (0021's definition of
  // sent), clear the quiet-hours withholding on the same rows, and retire
  // tokens Expo says are gone.
  if (!dryRun) {
    const pushedIds: string[] = [];
    for (const d of deliverable.values()) {
      if ((okByUser.get(d.userId) ?? 0) > 0) {
        pushedIds.push(...d.notificationIds);
        summary.pushed += d.notificationIds.length;
      }
    }
    if (pushedIds.length > 0) {
      const { error } = await supabase
        .from('notifications')
        .update({ pushed_at: nowIso, withheld: null })
        .in('notification_id', pushedIds);
      if (error) errors.push(`mark pushed: ${error.message}`);
    }
    if (badTokens.size > 0) {
      const { error } = await supabase
        .from('device_push_tokens')
        .delete()
        .in('expo_token', [...badTokens]);
      if (error) errors.push(`retire tokens: ${error.message}`);
      summary.tokens_removed = badTokens.size;
    }
    // Batched by reason — one update per reason, not per row. No
    // `pushed_at is null` guard: these ids came out of the pending scan this
    // run, and the sweep is the only writer.
    const byReason = new Map<string, string[]>();
    for (const { id, reason } of toWithhold) {
      byReason.set(reason, [...(byReason.get(reason) ?? []), id]);
    }
    for (const [reason, ids] of byReason) {
      const { error } = await supabase
        .from('notifications')
        .update({ withheld: reason })
        .in('notification_id', ids);
      if (error) errors.push(`withhold: ${error.message}`);
    }
    if (toUnwithhold.length > 0) {
      const { error } = await supabase
        .from('notifications')
        .update({ withheld: null })
        .in('notification_id', toUnwithhold);
      if (error) errors.push(`unwithhold: ${error.message}`);
    }
  }

  // ========================================================================
  // PHASE 2 — compose what the ledger is missing.
  // ========================================================================
  const cutoffIso = new Date(now.getTime() - COMPOSE_WINDOW_MS).toISOString();
  const insertQueue: LedgerInsert[] = [];
  // Chat watermarks that must ADVANCE this run: every membership whose digest
  // exists (written, or already delivered) and whose member is not in quiet
  // hours right now. A quiet member's watermark stays so tonight's digest
  // keeps growing until it is delivered at 07:00 — HANDOFF §8's
  // minutesUntilQuietHoursEnd note.
  const advanceWatermarks: { user_id: string; group_id: string }[] = [];
  const holdQuiet = (userId: string) => {
    const user = users.get(userId);
    if (!user) return false;
    return shouldNotify({
      kind: 'message_activity',
      prefs: user.prefs,
      deliveredNonUrgentToday: 0,
      at: zonedClock(now, user.timezone),
      kindEnabled: kindEnabledFromPrefs(user.prefs),
    }).withheld === 'quiet_hours';
  };
  // The push half only loads profiles for students with pending rows; the
  // compose half needs everyone it composes for, so it loads as it goes.
  const profileLoaded = new Set<string>();
  const loadProfiles = async (ids: string[]) => {
    const missing = [...new Set(ids)].filter((id) => id && !users.has(id) && !profileLoaded.has(id));
    if (missing.length === 0) return;
    profileLoaded.add(...missing);
    const { data, error } = await supabase
      .from('users')
      .select('user_id, notification_prefs, timezone')
      .in('user_id', missing);
    if (error) {
      errors.push(`compose profiles: ${error.message}`);
      return;
    }
    for (const p of data ?? []) {
      const profile = p as { user_id: string; notification_prefs: UserProfile['notification_prefs']; timezone: string | null };
      users.set(profile.user_id, {
        prefs: withNotificationDefaults(profile.notification_prefs),
        timezone: profile.timezone,
        tokens: [],
        deliveredNonUrgentToday: 0,
      });
    }
  };

  const nameCache = new Map<string, string>();
  const nameOf = async (userId: string): Promise<string> => {
    const hit = nameCache.get(userId);
    if (hit !== undefined) return hit;
    const { data } = await supabase
      .from('users')
      .select('full_name')
      .eq('user_id', userId)
      .maybeSingle();
    const name = ((data as { full_name: string | null } | null)?.full_name ?? '').trim();
    nameCache.set(userId, name);
    return name;
  };

  /**
   * Session copy carries a wall-clock time, so it is composed on the
   * STUDENT's clock: both the start and `now` shift by the student's UTC
   * offset before the formatter sees them, leaving the day words
   * self-consistent. Tokenless/unknown students fall back to the default
   * zone inside the shift helper.
   */
  const composeSessionCopy = (
    uid: string,
    startsAt: string,
    subject: (
      startsAtShifted: string,
      nowShifted: Date
    ) => { title: string; body: string }
  ): { title: string; body: string } => {
    const tz = users.get(uid)?.timezone ?? null;
    return subject(studentShiftedIso(startsAt, tz), new Date(studentShiftedIso(now.toISOString(), tz)));
  };

  // ---- chat digest, per member per group, watermarked --------------------
  const { data: memberships, error: memberError } = await supabase
    .from('group_members')
    .select('user_id, group_id, last_pushed_at, groups!inner(group_name, status)')
    .limit(2000);
  if (memberError) errors.push(`memberships: ${memberError.message}`);

  for (const m of (memberships ?? []) as {
    user_id: string;
    group_id: string;
    last_pushed_at: string;
    groups: { group_name: string; status: string };
  }[]) {
    try {
      if (m.groups.status === 'archived' || m.groups.status === 'disbanded') continue;
      await loadProfiles([m.user_id]);
      const watermark = m.last_pushed_at ?? nowIso;
      const { data: msgs, error } = await supabase
        .from('messages')
        .select('sender_id, deleted_at')
        .eq('group_id', m.group_id)
        .gt('created_at', watermark)
        .order('created_at')
        .limit(500);
      if (error) throw new Error(`digest messages: ${error.message}`);
      const relevant = (msgs ?? []).filter(
        (x) => !(x as { deleted_at: string | null }).deleted_at &&
               (x as { sender_id: string }).sender_id !== m.user_id
      );
      if (relevant.length === 0) {
        if (!holdQuiet(m.user_id)) advanceWatermarks.push(m);
        continue;
      }
      const senders = [
        ...new Set(relevant.map((x) => (x as { sender_id: string }).sender_id)),
      ];
      const names: string[] = [];
      for (const sender of senders) names.push(await nameOf(sender));
      const { title, body } = notificationContent({
        kind: 'message_activity',
        groupName: m.groups.group_name,
        count: relevant.length,
        senderNames: names,
      }, now);
      insertQueue.push({
        user_id: m.user_id,
        group_id: m.group_id,
        kind: 'message_activity',
        title,
        body,
        urgent: false,
        dedupe_key: notificationDedupeKey({
          kind: 'message_activity',
          subjectId: m.group_id,
          bucket: new Date(watermark).toISOString(),
        }),
      });
      if (!holdQuiet(m.user_id)) advanceWatermarks.push(m);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // ---- a shared file ------------------------------------------------------
  const { data: newFiles, error: filesError } = await supabase
    .from('materials')
    .select('material_id, group_id, file_name, uploaded_by, groups!inner(group_name, status)')
    .gt('created_at', cutoffIso)
    .is('deleted_at', null)
    .limit(200);
  if (filesError) errors.push(`files: ${filesError.message}`);
  for (const f of (newFiles ?? []) as {
    material_id: string;
    group_id: string;
    file_name: string;
    uploaded_by: string;
    groups: { group_name: string; status: string };
  }[]) {
    try {
      if (f.groups.status === 'archived' || f.groups.status === 'disbanded') continue;
      const sharer = await nameOf(f.uploaded_by);
      for (const uid of await memberIdsOf(supabase, f.group_id)) {
        if (uid === f.uploaded_by) continue;
        const { title, body } = notificationContent({
          kind: 'file_shared',
          groupName: f.groups.group_name,
          sharerName: sharer,
          fileName: f.file_name,
        }, now);
        insertQueue.push({
          user_id: uid,
          group_id: f.group_id,
          kind: 'file_shared',
          title,
          body,
          urgent: NOTIFICATION_URGENT.file_shared,
          dedupe_key: notificationDedupeKey({ kind: 'file_shared', subjectId: f.material_id }),
        });
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // ---- study times: proposed / confirmed / cancelled / one-yes-short ------
  const { data: recentSessions, error: sessionsError } = await supabase
    .from('study_sessions')
    .select('session_id, group_id, proposed_by, starts_at, duration_min, location, status, created_at, groups!inner(group_name, status)')
    .gt('created_at', cutoffIso)
    .limit(200);
  if (sessionsError) errors.push(`sessions: ${sessionsError.message}`);

  // Confirmations need a wider net than the compose window — the flipping
  // response can land days after the proposal — so they are detected by
  // their responses: a confirmed, upcoming session with a response newer than
  // the cutoff is treated as "confirmed since the last tick".
  const { data: freshResponses, error: responsesError } = await supabase
    .from('session_responses')
    .select('session_id, responded_at')
    .gt('responded_at', cutoffIso)
    .limit(500);
  if (responsesError) errors.push(`responses: ${responsesError.message}`);
  const confirmedCandidates = [
    ...new Set((freshResponses ?? []).map((r) => (r as { session_id: string }).session_id)),
  ];
  const { data: confirmedSessions, error: confirmedError } = confirmedCandidates.length
    ? await supabase
        .from('study_sessions')
        .select('session_id, group_id, proposed_by, starts_at, duration_min, location, status, groups!inner(group_name, status)')
        .in('session_id', confirmedCandidates)
        .eq('status', 'confirmed')
        .gt('starts_at', nowIso)
        .limit(200)
    : { data: [], error: null };
  if (confirmedError) errors.push(`confirmed sessions: ${confirmedError.message}`);

  for (const s of (recentSessions ?? []) as never[]) {
    try {
      const session = s as {
        session_id: string;
        group_id: string;
        proposed_by: string;
        starts_at: string;
        duration_min: number;
        location: string | null;
        status: string;
        groups: { group_name: string; status: string };
      };
      if (session.groups.status === 'archived' || session.groups.status === 'disbanded') continue;
      if (session.status !== 'proposed') continue; // born-and-died inside the window: skip
      const proposer = await nameOf(session.proposed_by);
      const proposedMembers = await memberIdsOf(supabase, session.group_id);
      await loadProfiles(proposedMembers);
      for (const uid of proposedMembers) {
        if (uid === session.proposed_by) continue;
        const { title, body } = composeSessionCopy(uid, session.starts_at, (starts, nowS) =>
          notificationContent({
            kind: 'session_proposed',
            groupName: session.groups.group_name,
            proposerName: proposer,
            startsAt: starts,
            durationMin: session.duration_min,
          }, nowS));
        insertQueue.push({
          user_id: uid,
          group_id: session.group_id,
          kind: 'session_proposed',
          title,
          body,
          urgent: NOTIFICATION_URGENT.session_proposed,
          dedupe_key: notificationDedupeKey({ kind: 'session_proposed', subjectId: session.session_id }),
        });
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  for (const s of (confirmedSessions ?? []) as never[]) {
    try {
      const session = s as {
        session_id: string;
        group_id: string;
        proposed_by: string;
        starts_at: string;
        duration_min: number;
        location: string | null;
        groups: { group_name: string; status: string };
      };
      if (session.groups.status === 'archived' || session.groups.status === 'disbanded') continue;
      const confirmedMembers = await memberIdsOf(supabase, session.group_id);
      await loadProfiles(confirmedMembers);
      for (const uid of confirmedMembers) {
        if (uid === session.proposed_by) continue;
        const { title, body } = composeSessionCopy(uid, session.starts_at, (starts, nowS) =>
          notificationContent({
            kind: 'session_confirmed',
            groupName: session.groups.group_name,
            startsAt: starts,
            durationMin: session.duration_min,
            location: session.location,
          }, nowS));
        insertQueue.push({
          user_id: uid,
          group_id: session.group_id,
          kind: 'session_confirmed',
          title,
          body,
          urgent: NOTIFICATION_URGENT.session_confirmed,
          dedupe_key: notificationDedupeKey({ kind: 'session_confirmed', subjectId: session.session_id }),
        });
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // Cancelled: the table has no cancelled_at, so a cancellation is detected
  // shape-wise — status 'cancelled' on a session that has not started yet (or
  // started within a day, so the news is not ancient). The dedupe key keeps
  // every sweep from re-announcing it.
  const { data: cancelledSessions, error: cancelledError } = await supabase
    .from('study_sessions')
    .select('session_id, group_id, proposed_by, starts_at, duration_min, groups!inner(group_name, status)')
    .eq('status', 'cancelled')
    .gt('starts_at', new Date(now.getTime() - 24 * 3600_000).toISOString())
    .lt('created_at', cutoffIso)
    .limit(200);
  if (cancelledError) errors.push(`cancelled sessions: ${cancelledError.message}`);
  for (const s of (cancelledSessions ?? []) as never[]) {
    try {
      const session = s as {
        session_id: string;
        group_id: string;
        proposed_by: string;
        starts_at: string;
        duration_min: number;
        groups: { group_name: string; status: string };
      };
      if (session.groups.status === 'archived' || session.groups.status === 'disbanded') continue;
      const cancelledMembers = await memberIdsOf(supabase, session.group_id);
      await loadProfiles(cancelledMembers);
      for (const uid of cancelledMembers) {
        if (uid === session.proposed_by) continue;
        const { title, body } = composeSessionCopy(uid, session.starts_at, (starts, nowS) =>
          notificationContent({
            kind: 'session_cancelled',
            groupName: session.groups.group_name,
            startsAt: starts,
            durationMin: session.duration_min,
          }, nowS));
        insertQueue.push({
          user_id: uid,
          group_id: session.group_id,
          kind: 'session_cancelled',
          title,
          body,
          urgent: NOTIFICATION_URGENT.session_cancelled,
          dedupe_key: notificationDedupeKey({ kind: 'session_cancelled', subjectId: session.session_id }),
        });
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // One yes from confirmed: a proposed, upcoming session whose tally sits
  // exactly one below its threshold, chasing only the members who have not
  // answered. The tally and threshold come from group_sessions — the same RPC
  // the card renders from, because the client must not re-derive them and
  // neither must the sender.
  const { data: proposedSessions, error: proposedError } = await supabase
    .from('study_sessions')
    .select('session_id, group_id, proposed_by, starts_at, duration_min, groups!inner(group_name, status)')
    .eq('status', 'proposed')
    .gt('starts_at', nowIso)
    .limit(200);
  if (proposedError) errors.push(`proposed sessions: ${proposedError.message}`);
  for (const s of (proposedSessions ?? []) as never[]) {
    try {
      const session = s as {
        session_id: string;
        group_id: string;
        proposed_by: string;
        starts_at: string;
        duration_min: number;
        groups: { group_name: string; status: string };
      };
      if (session.groups.status === 'archived' || session.groups.status === 'disbanded') continue;
      // The tally comes from session_agreement — the same pure helper
      // group_sessions renders from — because the sender must not re-derive
      // the threshold (0012's rule) the card displays.
      const { data: tally, error: tallyError } = await supabase
        .rpc('session_agreement', { p_session_id: session.session_id });
      if (tallyError) throw new Error(`session_agreement: ${tallyError.message}`);
      const row = (tally ?? [])[0] as
        | { yes_count: number; confirm_threshold: number; members_counted: number }
        | undefined;
      if (!row) continue;
      if (row.confirm_threshold < 2) continue; // a one-member group confirms alone
      if (row.yes_count !== row.confirm_threshold - 1) continue;
      const { data: waiting, error: attError } = await supabase
        .rpc('sender_session_waiting', { p_session_id: session.session_id });
      if (attError) throw new Error(`sender_session_waiting: ${attError.message}`);
      const waitingIds = (waiting ?? []).map((w) => (w as { user_id: string }).user_id);
      await loadProfiles(waitingIds);
      for (const uid of waitingIds) {
        const { title, body } = composeSessionCopy(uid, session.starts_at, (starts, nowS) =>
          notificationContent({
            kind: 'session_needs_one_yes',
            groupName: session.groups.group_name,
            startsAt: starts,
            durationMin: session.duration_min,
          }, nowS));
        insertQueue.push({
          user_id: uid,
          group_id: session.group_id,
          kind: 'session_needs_one_yes',
          title,
          body,
          urgent: NOTIFICATION_URGENT.session_needs_one_yes,
          dedupe_key: notificationDedupeKey({ kind: 'session_needs_one_yes', subjectId: session.session_id }),
        });
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // ---- the group-level nudges --------------------------------------------
  const { data: groups, error: groupsError } = await supabase
    .from('groups')
    .select('group_id, group_name, status, last_activity_at')
    .in('status', ['forming', 'active'])
    .limit(500);
  if (groupsError) errors.push(`groups: ${groupsError.message}`);

  const weekBucket = cooldownBucket('group_free_slot', now);
  const fortnightBucket = cooldownBucket('group_quiet', now);

  for (const g of (groups ?? []) as {
    group_id: string;
    group_name: string;
    status: string;
    last_activity_at: string;
  }[]) {
    try {
      const memberIds = await memberIdsOf(supabase, g.group_id);
      if (memberIds.length === 0) continue;

      // quiet: nothing has happened here in QUIET_GROUP_DAYS
      const quietMs = now.getTime() - new Date(g.last_activity_at).getTime();
      if (quietMs > QUIET_GROUP_DAYS * 24 * 3600_000) {
        const quietDays = Math.max(1, Math.floor(quietMs / (24 * 3600_000)));
        for (const uid of memberIds) {
          const { title, body } = notificationContent({
            kind: 'group_quiet',
            groupName: g.group_name,
            quietDays,
          }, now);
          insertQueue.push({
            user_id: uid,
            group_id: g.group_id,
            kind: 'group_quiet',
            title,
            body,
            urgent: NOTIFICATION_URGENT.group_quiet,
            dedupe_key: notificationDedupeKey({
              kind: 'group_quiet',
              subjectId: g.group_id,
              bucket: fortnightBucket,
            }),
          });
        }
      }

      // free slot: the group's shared availability, promoted at last — and
      // stood down for the week once something is confirmed.
      const { data: upcoming, error: upcomingError } = await supabase
        .from('study_sessions')
        .select('session_id')
        .eq('group_id', g.group_id)
        .eq('status', 'confirmed')
        .gt('starts_at', nowIso)
        .lt('starts_at', new Date(now.getTime() + FREE_SLOT_HORIZON_DAYS * 24 * 3600_000).toISOString())
        .limit(1);
      if (upcomingError) throw new Error(`upcoming sessions: ${upcomingError.message}`);
      if ((upcoming ?? []).length > 0) continue;

      const { data: common, error: commonError } = await supabase
        .rpc('sender_group_common', { p_group_id: g.group_id });
      if (commonError) throw new Error(`sender_group_common: ${commonError.message}`);
      const commonRow = (common ?? [])[0] as
        | { common_mask: string; members_counted: number; meet_threshold: number }
        | undefined;
      if (!commonRow || commonRow.members_counted < 2) continue;
      const grid = decodeAvailability(commonRow.common_mask);
      const firstFree = grid.findIndex((free) => free);
      if (firstFree < 0) continue;
      await loadProfiles(memberIds);

      const day = Math.floor(firstFree / SLOTS_PER_DAY_COUNT);
      const slot = firstFree % SLOTS_PER_DAY_COUNT;
      for (const uid of memberIds) {
        const user = users.get(uid);
        const slotLabel = await freeSlotLabel(
          now,
          DAYS[day],
          SLOTS[slot].label,
          user?.timezone ?? null
        );
        const { title, body } = notificationContent({
          kind: 'group_free_slot',
          groupName: g.group_name,
          slotLabel,
          othersFree: Math.max(0, commonRow.members_counted - 1),
        }, now);
        insertQueue.push({
          user_id: uid,
          group_id: g.group_id,
          kind: 'group_free_slot',
          title,
          body,
          urgent: NOTIFICATION_URGENT.group_free_slot,
          dedupe_key: notificationDedupeKey({
            kind: 'group_free_slot',
            subjectId: g.group_id,
            bucket: weekBucket,
          }),
        });
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // ---- invitations ---------------------------------------------------------
  const { data: freshInvites, error: invitesError } = await supabase
    .from('invitations')
    .select('invitation_id, group_id, inviter_id, invitee_id, groups!inner(group_name)')
    .eq('status', 'pending')
    .gt('created_at', cutoffIso)
    .limit(200);
  if (invitesError) errors.push(`invitations: ${invitesError.message}`);
  const { data: staleInvites, error: staleError } = await supabase
    .from('invitations')
    .select('invitation_id, group_id, inviter_id, invitee_id, groups!inner(group_name)')
    .eq('status', 'pending')
    .lt('created_at', new Date(now.getTime() - UNANSWERED_INVITATION_HOURS * 3600_000).toISOString())
    .limit(200);
  if (staleError) errors.push(`stale invitations: ${staleError.message}`);

  for (const inv of (freshInvites ?? []) as never[]) {
    await composeInvitation(inv as InvitationRow, 'invitation', insertQueue, nameOf, now);
  }
  for (const inv of (staleInvites ?? []) as never[]) {
    await composeInvitation(inv as InvitationRow, 'invitation_unanswered', insertQueue, nameOf, now);
  }

  // ---- write everything the ledger was missing -----------------------------
  if (insertQueue.length > 0) {
    // ignoreDuplicates turns the unique (user_id, dedupe_key) index into the
    // at-most-once rule. message_activity is the one kind whose words can
    // legitimately change after the fact — more messages arrived overnight —
    // so its conflicts are updated rather than swallowed.
    const { error: insertError } = await supabase
      .from('notifications')
      .upsert(insertQueue, {
        onConflict: 'user_id,dedupe_key',
        ignoreDuplicates: true,
      });
    if (insertError) {
      errors.push(`compose insert: ${insertError.message}`);
    } else {
      for (const row of insertQueue) {
        summary.composed[row.kind] = (summary.composed[row.kind] ?? 0) + 1;
      }
    }
    const digests = insertQueue.filter((r) => r.kind === 'message_activity');
    for (const digest of digests) {
      const { data: existing } = await supabase
        .from('notifications')
        .select('notification_id, pushed_at, title, body')
        .eq('user_id', digest.user_id)
        .eq('dedupe_key', digest.dedupe_key)
        .maybeSingle();
      const existingRow = existing as
        | { notification_id: string; pushed_at: string | null; title: string; body: string }
        | null;
      if (existingRow && existingRow.pushed_at === null &&
          (existingRow.title !== digest.title || existingRow.body !== digest.body)) {
        const { error } = await supabase
          .from('notifications')
          .update({ title: digest.title, body: digest.body })
          .eq('notification_id', existingRow.notification_id);
        if (error) errors.push(`digest update: ${error.message}`);
      }
    }
  }

  // Watermark advances are compose-half state, so they happen in dry runs too
  // (idempotent, monotonic, and re-derived every sweep). Only the Expo call
  // and the pushed_at marker are dry-run's no-go — that is what lets the live
  // verification see the full compose path without sending anything.
  if (advanceWatermarks.length > 0) {
    // Monotonic by construction: nowIso is this run's instant, the schedule
    // never overlaps itself, and only this function writes the watermark.
    for (const m of advanceWatermarks) {
      const { error } = await supabase
        .from('group_members')
        .update({ last_pushed_at: nowIso })
        .eq('user_id', m.user_id)
        .eq('group_id', m.group_id);
      if (error) errors.push(`watermark: ${error.message}`);
      else summary.watermarks_advanced += 1;
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const SLOTS_PER_DAY_COUNT = 4;

/**
 * Shifts an instant so the client-copied formatters — which read the process
 * clock, UTC here — say the STUDENT's wall clock. `Africa/Lagos` words must
 * not come out an hour behind because the server happens to sit on UTC; the
 * shift moves both the moment and `now` by the same offset, so the
 * Today/Tomorrow arithmetic stays self-consistent. Unknown zone: unshifted,
 * same fail-open answer as zonedClock.
 */
function studentShiftedIso(iso: string, timezone: string | null | undefined): string {
  const tz = (timezone ?? '').trim() || DEFAULT_TIMEZONE;
  try {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(d);
    const read = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const year = read('year');
    const month = read('month');
    const day = read('day');
    if (!year || !month || !day) return iso;
    const asUTC = Date.UTC(year, month - 1, day, read('hour'), read('minute'), read('second'));
    return new Date(d.getTime() + (asUTC - d.getTime())).toISOString();
  } catch {
    return iso;
  }
}

interface InvitationRow {
  invitation_id: string;
  group_id: string;
  inviter_id: string;
  invitee_id: string;
  groups: { group_name: string };
}

async function memberIdsOf(supabase: SupabaseClient, groupId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('group_members')
    .select('user_id')
    .eq('group_id', groupId)
    .limit(100);
  if (error) throw new Error(`members: ${error.message}`);
  return (data ?? []).map((m) => (m as { user_id: string }).user_id);
}

type NameOf = (userId: string) => Promise<string>;

async function composeInvitation(
  inv: InvitationRow,
  kind: 'invitation' | 'invitation_unanswered',
  queue: LedgerInsert[],
  nameOf: NameOf,
  now: Date
): Promise<void> {
  const inviter = await nameOf(inv.inviter_id);
  const { title, body } = notificationContent({
    kind,
    groupName: inv.groups.group_name,
    inviterName: inviter,
  }, now);
  queue.push({
    user_id: inv.invitee_id,
    group_id: inv.group_id,
    kind,
    title,
    body,
    urgent: NOTIFICATION_URGENT[kind],
    dedupe_key: notificationDedupeKey({ kind, subjectId: inv.invitation_id }),
  });
}

/**
 * "tomorrow afternoon" — the weekday and block words come from
 * _shared/availability.ts's own DAYS and SLOTS so a banner cannot disagree
 * with the grid the student filled in. The day is resolved in the student's
 * timezone: "today" for them is not "today" for the server.
 */
async function freeSlotLabel(
  now: Date,
  dayName: string,
  slotLabel: string,
  timeZone: string | null
): Promise<string> {
  const clock = zonedClock(now, timeZone);
  // Rebuild a Date carrying the student's wall clock as if it were UTC, so
  // the weekday arithmetic below runs on THEIR calendar day.
  const wall = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
      (clock as { getHours(): number }).getHours(), (clock as { getMinutes(): number }).getMinutes())
  );
  const jsDayIndex = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const target = jsDayIndex.indexOf(dayName);
  if (target < 0) return '';
  const daysAhead = (target - wall.getUTCDay() + 7) % 7;
  const dayWord = daysAhead === 0 ? 'today' : daysAhead === 1 ? 'tomorrow' : dayName;
  return `${dayWord} ${slotLabel.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = req.headers.get('authorization') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const senderSecret = Deno.env.get('SENDER_SECRET') ?? '';
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  if (!(senderSecret && bearer === senderSecret) && bearer !== serviceKey) {
    return json({ error: 'Not authorised' }, 403);
  }

  let dryRun = req.headers.get('x-dry-run') === '1';
  try {
    const payload = await req.json();
    if (payload && typeof payload === 'object' && (payload as { dry_run?: boolean }).dry_run === true) {
      dryRun = true;
    }
  } catch {
    // no body — header flag only
  }

  try {
    const summary = await runSweep(dryRun);
    return json(summary);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
