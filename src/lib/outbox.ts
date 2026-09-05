import AsyncStorage from '@react-native-async-storage/async-storage';
import { proposeSession, respondToSession, sendMessage } from './chat';
import { createGroup, leaveGroup, setMatchingPref } from './groups';
import { makeActionId } from './ids';
import { supabase, isNetworkError } from './supabase';
import type { MatchingPref, SessionResponseValue } from '@/types/database';

/**
 * Offline write queue.
 *
 * The other half of the offline requirement. `cache.ts` makes reads work
 * without a connection; this makes writes work. A student on hostel wifi taps
 * Save, the write is appended here, the UI updates optimistically, and the
 * queue drains whenever connectivity returns — including after a full app
 * restart, since the queue lives in AsyncStorage rather than memory.
 *
 * DECISION (2026-09-03): full queue-and-sync rather than a read-only cache.
 * Chosen over my own recommendation because weak wifi is a core constraint of
 * the product, not an edge case.
 *
 * Design notes:
 *
 *   Idempotency. Every action carries a uuid generated at enqueue time. The
 *   handler sends it to Postgres, which records it in
 *   `applied_client_actions` (primary key on that uuid). If a write actually
 *   succeeded but the response was lost — very common on flaky wifi — the
 *   retry hits a duplicate-key error, which we treat as success. Without this,
 *   "save profile" on a bad connection creates duplicate rows.
 *
 *   Ordering. Strictly FIFO, and a failed action blocks the ones behind it.
 *   Later actions routinely depend on earlier ones (add a course, then set
 *   its availability), so draining out of order would apply an availability
 *   update to a user_course row that does not exist yet.
 *
 *   Failure classification. Network errors requeue and retry forever with
 *   backoff. Everything else (an RLS rejection, a constraint violation, bad
 *   data) is permanent: retrying cannot help, so the action is moved to a
 *   dead-letter list for the UI to surface. A permanent failure that silently
 *   retried forever would block the whole queue behind it.
 */

const QUEUE_KEY = 'studysync:outbox:v1';
const DEAD_KEY = 'studysync:outbox:dead:v1';

/**
 * Actions the queue knows how to replay. Extended as later stages land.
 *
 * Stage 2 adds only the three group actions that are useful offline: creating a
 * group, leaving one, and changing how you want to be matched on a course. The
 * rest (invite, respond, approve) are deliberately online-only — each one
 * depends on server state that may have changed while the device was offline (a
 * group filling up, an invitation being cancelled), so queueing them would
 * mostly produce dead-lettered actions and a confusing optimistic UI.
 *
 * `matching.pref` is queueable on the opposite reasoning: it hands out no seat
 * and nobody else has to answer it. It is a private, last-write-wins setting
 * that only takes effect the next time an admin runs batch matching, so landing
 * it minutes later is honoured exactly as if it had landed at once.
 *
 * Stage 3 adds three more, and the test is the same one: does landing late
 * change what the action means?
 *
 *   `chat.send` — no. A message is a statement, not a claim on anything, and it
 *   carries its own device-generated `message_id`, so the bubble on screen and
 *   the row that eventually lands are one object. This is the action the offline
 *   requirement is really about: a student on hostel wifi types a message and it
 *   sends when it can.
 *
 *   `session.propose` — no, with one honest failure. The proposal is a question
 *   put to the group, and asking it late is still asking it. But `propose_session`
 *   refuses a start time in the past, so a time that expires while the queue sits
 *   dead-letters. `validateSessionProposal` is what keeps that rare: it refuses a
 *   past time at the picker, so the only way to hit it is a queue that sat longer
 *   than the gap the student left.
 *
 *   `session.respond` — no. An RSVP is last-write-wins on one
 *   `(session_id, user_id)` row and hands out nothing finite; the server refuses
 *   one that arrives after the session started rather than recording it late.
 *   (0016's own header calls this online-only. HANDOFF §8 revisits it and this
 *   is the settled answer.)
 *
 * Still deliberately online-only: `session.cancel`, because it is the one action
 * other people act on — "the meeting is off" landing an hour late, after
 * everybody has travelled, is worse than a cancel that refused to queue. Both
 * material actions, because an upload needs bytes on the wire and a delete needs
 * the bucket to answer. And `mark_group_read`, which is never queued at all: a
 * read cursor replayed on reconnect would mark as read everything that arrived
 * while the phone was face-down.
 */
export type OutboxActionType =
  | 'profile.update'
  | 'course.add'
  | 'course.remove'
  | 'availability.set'
  | 'group.create'
  | 'group.leave'
  | 'matching.pref'
  | 'chat.send'
  | 'session.propose'
  | 'session.respond';

export interface OutboxAction {
  /** uuid — doubles as the server-side idempotency key. */
  id: string;
  type: OutboxActionType;
  payload: Record<string, unknown>;
  userId: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

export interface DeadAction extends OutboxAction {
  failedAt: number;
  reason: string;
}

/**
 * Re-exported so `enqueue`'s id generator and the outbox stay one import for
 * callers. The implementation lives in ids.ts to keep groups.ts out of a
 * require cycle with this module — see the note there.
 */
export { makeActionId };

async function readQueue(): Promise<OutboxAction[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OutboxAction[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue: OutboxAction[]): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // If persistence fails the action is lost, which is bad but not fatal —
    // the UI already applied it optimistically and a later refresh corrects it.
  }
}

export async function enqueue(
  type: OutboxActionType,
  payload: Record<string, unknown>,
  userId: string
): Promise<OutboxAction> {
  const action: OutboxAction = {
    id: makeActionId(),
    type,
    payload,
    userId,
    createdAt: Date.now(),
    attempts: 0,
  };
  const queue = await readQueue();
  queue.push(action);
  await writeQueue(queue);
  return action;
}

export async function pendingCount(): Promise<number> {
  return (await readQueue()).length;
}

export async function pendingActions(): Promise<OutboxAction[]> {
  return readQueue();
}

export async function deadActions(): Promise<DeadAction[]> {
  try {
    const raw = await AsyncStorage.getItem(DEAD_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DeadAction[]) : [];
  } catch {
    return [];
  }
}

async function moveToDead(action: OutboxAction, reason: string): Promise<void> {
  const dead = await deadActions();
  dead.push({ ...action, failedAt: Date.now(), reason });
  // Cap the dead list so a pathological loop can't fill the device.
  const trimmed = dead.slice(-50);
  try {
    await AsyncStorage.setItem(DEAD_KEY, JSON.stringify(trimmed));
  } catch {
    /* ignore */
  }
}

export async function clearDead(): Promise<void> {
  try {
    await AsyncStorage.removeItem(DEAD_KEY);
  } catch {
    /* ignore */
  }
}

/** Postgres unique-violation — for us, proof the write already landed. */
function isDuplicateKey(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  if (err?.code === '23505') return true;
  return /duplicate key value|already exists/i.test(err?.message ?? '');
}

/**
 * Actions whose server-side write claims the ledger row ITSELF.
 *
 * The Stage 2 group RPCs all begin with `claim_client_action(p_client_action_id,
 * …)` and return early if it reports the id was already used. If this module
 * pre-inserted that same id, the RPC would see its own action as an
 * already-applied replay and silently do nothing — the group would never be
 * created. So for these, the RPC owns the ledger and we skip the insert below;
 * idempotency is identical, just enforced one layer down and inside the RPC's
 * transaction (which is strictly better: the claim and the write commit or roll
 * back together).
 */
const SELF_LEDGERED: readonly OutboxActionType[] = [
  'group.create',
  'group.leave',
  'matching.pref',
  // The Stage 3 RPCs claim it the same way, under the action names above:
  // send_message claims 'chat.send', propose_session 'session.propose',
  // respond_to_session 'session.respond' (0014, 0016). Leaving any of them out
  // of this list would have the pre-insert below burn the id the RPC is about
  // to look for, and the message would silently never be sent.
  'chat.send',
  'session.propose',
  'session.respond',
];

/**
 * Record the action id server-side, then run the write.
 *
 * The ledger insert goes FIRST and deliberately. If it reports a duplicate,
 * this action was already applied on a previous attempt whose response never
 * reached us, so we stop and report success rather than writing twice.
 *
 * The exception is SELF_LEDGERED actions, which do their own claiming.
 */
async function applyAction(action: OutboxAction): Promise<void> {
  if (!SELF_LEDGERED.includes(action.type)) {
    const { error: ledgerError } = await supabase
      .from('applied_client_actions')
      .insert({
        client_action_id: action.id,
        user_id: action.userId,
        action_type: action.type,
      });

    if (ledgerError) {
      if (isDuplicateKey(ledgerError)) return; // already applied — success
      throw ledgerError;
    }
  }

  switch (action.type) {
    case 'profile.update': {
      const { full_name, department, notification_prefs, onboarding_complete } =
        action.payload as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      if (full_name !== undefined) patch.full_name = full_name;
      if (department !== undefined) patch.department = department;
      if (notification_prefs !== undefined) patch.notification_prefs = notification_prefs;
      if (onboarding_complete !== undefined) patch.onboarding_complete = onboarding_complete;

      const { error } = await supabase
        .from('users')
        .update(patch)
        .eq('user_id', action.userId);
      if (error) throw error;
      return;
    }

    case 'course.add': {
      const { course_id, availability } = action.payload as {
        course_id: string;
        availability?: string;
      };
      const { error } = await supabase.from('user_courses').insert({
        user_id: action.userId,
        course_id,
        ...(availability ? { availability } : {}),
      });
      // Unique (user_id, course_id) — already enrolled is the desired state.
      if (error && !isDuplicateKey(error)) throw error;
      return;
    }

    case 'course.remove': {
      const { course_id } = action.payload as { course_id: string };
      const { error } = await supabase
        .from('user_courses')
        .delete()
        .eq('user_id', action.userId)
        .eq('course_id', course_id);
      if (error) throw error;
      return;
    }

    case 'availability.set': {
      const { user_course_id, availability } = action.payload as {
        user_course_id: string;
        availability: string;
      };
      const { error } = await supabase
        .from('user_courses')
        .update({ availability })
        .eq('user_course_id', user_course_id);
      if (error) throw error;
      return;
    }

    /**
     * The group id was generated on the device when the student tapped Create,
     * so the optimistic card and the row Postgres finally writes are the same
     * object — nothing has to be reconciled when this lands.
     */
    case 'group.create': {
      const { group_id, group_name, course_id, is_discoverable } =
        action.payload as {
          group_id: string;
          group_name: string;
          course_id: string;
          is_discoverable?: boolean;
        };
      await createGroup({
        groupId: group_id,
        groupName: group_name,
        courseId: course_id,
        isDiscoverable: is_discoverable,
        // The queued id, not a fresh one: that is what makes the replay a no-op.
        clientActionId: action.id,
      });
      return;
    }

    case 'group.leave': {
      const { group_id } = action.payload as { group_id: string };
      await leaveGroup(group_id, action.id);
      return;
    }

    /**
     * Last-write-wins. If two pref changes for the same course are queued, FIFO
     * means the later one is applied last, which is the answer the student left
     * the screen with.
     */
    case 'matching.pref': {
      const { course_id, pref } = action.payload as {
        course_id: string;
        pref: MatchingPref;
      };
      await setMatchingPref(course_id, pref, action.id);
      return;
    }

    /**
     * The message_id was generated when the student hit send, so the bubble that
     * has been on screen since then and the row Postgres finally writes are the
     * same object — the arriving Realtime echo collapses onto it by id and there
     * is nothing to reconcile.
     */
    case 'chat.send': {
      const { group_id, message_id, body } = action.payload as {
        group_id: string;
        message_id: string;
        body: string;
      };
      await sendMessage({
        groupId: group_id,
        messageId: message_id,
        body,
        // The queued id, not a fresh one: that is what makes the replay a no-op.
        clientActionId: action.id,
      });
      return;
    }

    /**
     * Three rows server-side (session, its timeline message, the proposer's own
     * yes) from one call, so both ids are generated on the device for the same
     * reason as above.
     *
     * This is the one queued action that can legitimately dead-letter: the RPC
     * refuses a start time that is now in the past. Nothing to retry there — the
     * time the student picked has been and gone — so the dead-letter list is the
     * honest place for it.
     */
    case 'session.propose': {
      const { group_id, session_id, message_id, starts_at, duration_min, location, note } =
        action.payload as {
          group_id: string;
          session_id: string;
          message_id: string;
          starts_at: string;
          duration_min: number;
          location?: string | null;
          note?: string | null;
        };
      await proposeSession({
        groupId: group_id,
        sessionId: session_id,
        messageId: message_id,
        startsAt: starts_at,
        durationMin: duration_min,
        location: location ?? null,
        note: note ?? null,
        clientActionId: action.id,
      });
      return;
    }

    /**
     * Last-write-wins on one row, like matching.pref: two queued answers for the
     * same session apply in order and the later one stands.
     */
    case 'session.respond': {
      const { session_id, response } = action.payload as {
        session_id: string;
        response: SessionResponseValue;
      };
      await respondToSession(session_id, response, action.id);
      return;
    }

    default: {
      // An unknown type means a newer app version queued something this build
      // cannot replay. Permanent by definition — don't retry forever.
      throw new Error(`Unknown outbox action type: ${(action as OutboxAction).type}`);
    }
  }
}

export interface DrainResult {
  applied: number;
  failedPermanently: number;
  /** True if the queue stopped early on a network error and has work left. */
  stoppedOnNetwork: boolean;
  remaining: number;
}

let draining = false;

/**
 * Drain the queue in order.
 *
 * Guarded against concurrent runs: the connectivity listener and a manual
 * retry can both fire at once, and two drains racing would double-apply.
 */
export async function drainOutbox(): Promise<DrainResult> {
  if (draining) {
    return {
      applied: 0,
      failedPermanently: 0,
      stoppedOnNetwork: false,
      remaining: await pendingCount(),
    };
  }
  draining = true;

  let applied = 0;
  let failedPermanently = 0;
  let stoppedOnNetwork = false;

  try {
    let queue = await readQueue();

    while (queue.length > 0) {
      const action = queue[0];
      try {
        await applyAction(action);
        queue.shift();
        await writeQueue(queue);
        applied++;
      } catch (error) {
        if (isNetworkError(error)) {
          // Still offline. Leave the action in place, record the attempt, and
          // stop — everything behind it may depend on this one landing first.
          action.attempts++;
          action.lastError = (error as { message?: string }).message;
          queue[0] = action;
          await writeQueue(queue);
          stoppedOnNetwork = true;
          break;
        }
        // Permanent: dead-letter it and keep going, or it blocks the queue.
        queue.shift();
        await writeQueue(queue);
        await moveToDead(
          action,
          (error as { message?: string }).message ?? 'Unknown error'
        );
        failedPermanently++;
      }
      queue = await readQueue();
    }
  } finally {
    draining = false;
  }

  return {
    applied,
    failedPermanently,
    stoppedOnNetwork,
    remaining: await pendingCount(),
  };
}

/** Clear both queues — sign-out, so a shared device doesn't replay as the next user. */
export async function outboxClearAll(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([QUEUE_KEY, DEAD_KEY]);
  } catch {
    /* ignore */
  }
}
