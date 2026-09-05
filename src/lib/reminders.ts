import { CacheKeys, cacheReadData, cacheWrite } from '@/lib/cache';
import { groupSessions } from '@/lib/chat';
import {
  planReminders,
  prunePastReminders,
  reviveReminders,
  serializeReminders,
  type PlannedReminder,
} from '@/lib/notificationRules';
import {
  cancelAllReminders,
  ensureNotifierReady,
  notifierBlockedReason,
  syncReminders,
  type NotifierStatus,
  type SyncResult,
} from '@/lib/notifier';
import { supabase } from '@/lib/supabase';

/**
 * The seam between the study times on the server and the alarms on this phone.
 *
 * Three modules, one job each, and keeping them apart is what makes any of it
 * testable: `notificationRules.ts` decides WHICH alarms are owed (pure, 70-odd
 * tests), `notifier.ts` is the only thing allowed to talk to the OS, and this
 * file fetches, remembers and reconciles. Screens import this module and never
 * `notifier.ts` — that keeps the count of files naming `expo-notifications` at
 * one, which is the whole containment strategy described in its header.
 *
 * ## The rule that matters most
 *
 * **A failed fetch is not an empty plan.** `syncReminders` cancels every pending
 * alarm the plan does not mention, so handing it `[]` because the network timed
 * out would silently delete every alarm a student has — on the bus, offline, at
 * exactly the moment they most need the 30-minute warning and least expect to
 * lose it. So a gather is all-or-nothing: if any group's sessions cannot be read,
 * `gatherPlan` returns null and nothing is touched. The alarms already sitting in
 * the OS are the durable copy; leaving them alone is always the safe move.
 *
 * ## What offline costs, honestly
 *
 * A confirmed session's alarm survives with no signal, the app closed, and across
 * a reboot, because the OS holds it. The price is the mirror image: if the group
 * calls the session off while this phone is offline, this phone cannot know, and
 * the alarm still rings. That is inherent to "regardless if the phone is online
 * or offline" and not a bug to be fixed here — the next successful gather clears
 * it.
 */

/** Only what an alarm needs from a group: the id to query, the name to say. */
interface ReminderGroup {
  group_id: string;
  group_name: string;
}

/**
 * Reconciles run one at a time.
 *
 * Four things can ask for a sync at once on a cold start — the cache restore, the
 * first online gather, the app coming to the foreground, an outbox drain
 * finishing. Two overlapping reconciles each read the OS's pending list before
 * either writes, so one can cancel an alarm the other has just placed on the
 * strength of a list that is now out of date. Stable identifiers stop that from
 * ever DOUBLING an alarm, but they do not stop it from losing one. A queue does.
 */
let chain: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(task, task);
  // Swallow on the chain only: the returned promise still rejects for the caller,
  // but one failure must not poison every sync that follows it.
  chain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/**
 * The groups whose study times could put an alarm on this phone.
 *
 * A deliberately smaller query than `useMyGroups`' — two columns, no course join,
 * no member counts — because this runs on every foreground and needs nothing
 * else. Archived and disbanded groups are excluded: a study time nobody is going
 * to attend should not ring at 3:30pm.
 *
 * Returns null on failure, never `[]`. See the header for why that distinction is
 * load-bearing.
 */
async function reminderGroups(userId: string): Promise<ReminderGroup[] | null> {
  const { data, error } = await supabase
    .from('group_members')
    .select('group:groups (group_id, group_name, status)')
    .eq('user_id', userId);

  if (error || !data) return null;

  const groups: ReminderGroup[] = [];
  let parsed = 0;
  for (const row of data as any[]) {
    // A to-one embed comes back as an object, but supabase-js types it as an
    // array and has been known to return one. Accept both: read it wrong and
    // this function reports "no groups", which is the one lie that would cancel
    // every alarm the student has.
    const group = Array.isArray(row?.group) ? row.group[0] : row?.group;
    if (!group || typeof group.group_id !== 'string') continue;
    parsed += 1;
    if (group.status === 'archived' || group.status === 'disbanded') continue;
    groups.push({
      group_id: group.group_id,
      group_name: typeof group.group_name === 'string' ? group.group_name : 'your group',
    });
  }

  // Belt to that brace. Rows came back and not one of them parsed, so the shape
  // is wrong rather than the student being in nothing — counted before the status
  // filter, because "every group I am in is archived" is a real and different
  // answer that SHOULD clear the alarms.
  if (data.length > 0 && parsed === 0) return null;
  return groups;
}

/**
 * Every alarm this student is owed, across every group, or null if that cannot be
 * established.
 *
 * The per-group loop is `group_sessions`' fault, not a choice: its rows carry no
 * `group_id`, so the group name has to come from outside the RPC. The calls go
 * out together, and a student belongs to a handful of groups, so this is one
 * round trip's worth of latency rather than N. `useMyGroups.withMemberCounts`
 * already sets the precedent for a second read on this path.
 *
 * One group failing fails the whole gather, because a plan missing a group is
 * indistinguishable from a plan where that group has nothing on — and the second
 * reading would cancel its alarms.
 */
async function gatherPlan(
  userId: string,
  now: Date
): Promise<PlannedReminder[] | null> {
  const groups = await reminderGroups(userId);
  if (!groups) return null;
  if (groups.length === 0) return [];

  const perGroup = await Promise.all(
    groups.map(async (group): Promise<PlannedReminder[] | null> => {
      try {
        const sessions = await groupSessions(group.group_id);
        return planReminders({ sessions, groupName: group.group_name, now });
      } catch {
        return null;
      }
    })
  );

  if (perGroup.some((plan) => plan === null)) return null;
  return perGroup.flatMap((plan) => plan ?? []);
}

/**
 * Ask the server what is confirmed, remember it, and make the phone match.
 *
 * Resolves to null when nothing could be established — offline, or a read
 * refused — in which case the phone's alarms are left exactly as they were.
 *
 * The plan is cached only after a complete gather, which is what makes
 * `restoreReminders` trustworthy later.
 */
export async function refreshReminders(userId: string): Promise<SyncResult | null> {
  return serialized(async () => {
    const plan = await gatherPlan(userId, new Date());
    if (!plan) return null;
    await cacheWrite(CacheKeys.reminders(userId), serializeReminders(plan));
    return syncReminders(plan);
  });
}

/**
 * Re-place the last known alarms from disk, with no network at all.
 *
 * This is not belt-and-braces for `refreshReminders`; it is the only thing that
 * works in two real cases. A student opens the app offline — the gather fails and
 * without this nothing would ever re-place an alarm the OS dropped. And iOS
 * clears an app's pending local notifications when the app is reinstalled or
 * restored from a backup, so the study times a student agreed to last week would
 * simply stop ringing, with no error anywhere.
 *
 * Past-due entries are pruned first: an unpruned restore would announce a session
 * that has already happened (see `prunePastReminders`).
 *
 * Resolves to null when there is no cached plan, because "never gathered" and
 * "gathered, nothing on" are different facts and only the second one may cancel.
 */
export async function restoreReminders(userId: string): Promise<SyncResult | null> {
  return serialized(async () => {
    const raw = await cacheReadData<unknown>(CacheKeys.reminders(userId));
    if (raw === null) return null;
    return syncReminders(prunePastReminders(reviveReminders(raw)));
  });
}

/**
 * Ask the OS for permission, at a moment the student expects to be asked.
 *
 * Nothing else in this module ever prompts: `syncReminders` runs
 * `ensureNotifierReady()` with `askIfNeeded` false, so a background gather cannot
 * throw a system dialog at somebody reading a message. The one place to call this
 * is directly off a tap that means "I am going to this" — saying yes to a study
 * time. Until permission exists, iOS reports `denied` and places nothing, so
 * without this call the alarm feature is silently inert on a fresh install.
 *
 * A denial is final as far as code is concerned; only Settings can undo it, which
 * is what the prefs screen is for.
 */
export async function askAboutReminders(): Promise<NotifierStatus> {
  return ensureNotifierReady(true);
}

/**
 * Drop every alarm this phone holds. For sign-out.
 *
 * They name a group and a time, so leaving them behind tells the next person to
 * pick up this phone about a stranger's study session — the same shared-phone leak
 * `cacheClearAll` exists to prevent. The cached plan itself needs no separate
 * removal: it lives under the cache's own prefix, so `cacheClearAll` takes it.
 */
export async function forgetReminders(): Promise<number> {
  return serialized(() => cancelAllReminders());
}

/** Re-exported so screens have one import for everything reminder-shaped. */
export { notifierBlockedReason };
