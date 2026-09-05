import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, isNetworkError } from './supabase';

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

/** Actions the queue knows how to replay. Extended as later stages land. */
export type OutboxActionType =
  | 'profile.update'
  | 'course.add'
  | 'course.remove'
  | 'availability.set';

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
 * uuid v4 without a native dependency.
 *
 * expo-crypto would be better, but Math.random is adequate here: these ids
 * only need to be unique across one device's pending queue, and they are
 * never a security boundary.
 */
export function makeActionId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

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
 * Record the action id server-side, then run the write.
 *
 * The ledger insert goes FIRST and deliberately. If it reports a duplicate,
 * this action was already applied on a previous attempt whose response never
 * reached us, so we stop and report success rather than writing twice.
 */
async function applyAction(action: OutboxAction): Promise<void> {
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
