import { formatClock, formatDuration, sessionWhenLabel } from '@/lib/chatRules';
import type { GroupSessionRow, NotificationPrefs } from '@/types/database';

/**
 * Pure rules for Stage 5 — what to tell a student, and when not to.
 *
 * Same split and the same reason as `chatRules.ts` and `groupRules.ts`: none of
 * this can be unit-tested through a screen (§6 of HANDOFF — no renderer is
 * installed), and all of it is the kind of logic that is quietly wrong for
 * months. A quiet-hours window that wraps midnight, a cap that counts the wrong
 * notifications, an alarm scheduled for a session that was cancelled an hour
 * ago: none of those crash, they just make the app either silent or annoying.
 * So they live here as pure functions over plain rows, and a test notices.
 *
 * TWO MECHANISMS, and the split is the whole design (HANDOFF §8, Stage 5):
 *
 *   - A study-time reminder is a LOCAL notification, scheduled on the student's
 *     own device against a clock the OS owns. It fires with no network, with the
 *     app closed, and across a reboot. That is the only way to honour "30
 *     minutes to study time regardless if the phone is online or offline".
 *   - Everything else is a REMOTE push, because the event happens on somebody
 *     else's phone and this device cannot know to schedule anything.
 *
 * `NOTIFICATION_LOCAL` below is where that split is written down once.
 *
 * Times: local, hand-rolled, no `Intl` — Hermes on Android has shipped without
 * it, and quiet hours are read off the student's own wall clock, not UTC. A
 * student in Lagos who sets 22:00 means 22:00 where they are standing.
 */

// ---------------------------------------------------------------------------
// The kinds
// ---------------------------------------------------------------------------

/**
 * Exactly what the owner asked for, and nothing proposed.
 *
 * Scope, verbatim: "push notification for chat activites (messages, meeting
 * schedule, files), phone alarm notification when its 30mins to study time".
 * Invitations are here too because being invited is unusable if nobody tells
 * you. The four *nudges* sketched in HANDOFF §8 (a session one yes short, a
 * free slot the group shares, a group gone quiet, an unanswered invitation) are
 * deliberately absent until they are chosen — this is a union, so adding one
 * later breaks every `Record<NotificationKind, …>` below until it is handled,
 * which is the point.
 */
export type NotificationKind =
  | 'session_reminder'
  | 'session_proposed'
  | 'session_confirmed'
  | 'session_cancelled'
  | 'message_activity'
  | 'file_shared'
  | 'invitation';

/** Wording for the prefs screen's per-kind switches (step 5). */
export const NOTIFICATION_KIND_LABEL: Record<NotificationKind, string> = {
  session_reminder: 'Study time reminders',
  session_proposed: 'New study times',
  session_confirmed: 'Confirmed study times',
  session_cancelled: 'Cancelled study times',
  message_activity: 'New messages',
  file_shared: 'Shared files',
  invitation: 'Group invitations',
};

/**
 * Urgent means **exempt from `daily_cap`** — `0001`'s own comment on
 * `notification_prefs` defines it that way, so this table is not free to invent
 * a second meaning.
 *
 * Only two qualify. A reminder for a session starting in half an hour is the
 * one notification whose whole value is its timing, and a cancellation is the
 * only thing that stops a student walking to a library for a meeting that is
 * not happening. Everything else can wait for tomorrow's allowance; a student
 * who has already had three notifications today does not need a fourth to know
 * a file was shared.
 */
export const NOTIFICATION_URGENT: Record<NotificationKind, boolean> = {
  session_reminder: true,
  session_cancelled: true,
  session_proposed: false,
  session_confirmed: false,
  message_activity: false,
  file_shared: false,
  invitation: false,
};

/**
 * True where the DEVICE schedules it, false where a server pushes it.
 *
 * Only the reminder is local, and it is local for the reason in the header: it
 * has to fire offline. Note what this table implies for the sender — it must
 * never push a `session_reminder`, or a student with a signal gets the alarm
 * twice and one of them at the wrong second.
 */
export const NOTIFICATION_LOCAL: Record<NotificationKind, boolean> = {
  session_reminder: true,
  session_proposed: false,
  session_confirmed: false,
  session_cancelled: false,
  message_activity: false,
  file_shared: false,
  invitation: false,
};

// ---------------------------------------------------------------------------
// Quiet hours — the part that is wrong in every first attempt
// ---------------------------------------------------------------------------

const MINUTES_IN_DAY = 24 * 60;

/**
 * 'HH:MM' (24h) to minutes since local midnight, or null if it is not that.
 *
 * `notification_prefs` is jsonb with no CHECK behind it, so these two strings
 * are the least trustworthy values in the schema: they can be edited by any
 * client that can write the column, and `0001` only supplies the defaults.
 */
export function parseClockMinutes(hhmm: string | null | undefined): number | null {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Is `at` inside the student's quiet hours, on their own wall clock?
 *
 * **The wrap is the whole function.** The default window is 22:00 -> 07:00,
 * which is not an interval on a 24-hour clock — it is two, `[22:00, 24:00)` and
 * `[00:00, 07:00)`. The obvious `start <= t && t < end` is *empty* for every
 * window a student would actually set, so the naive version silences nothing
 * and looks like the feature was never wired up. Both branches are pinned by
 * tests for exactly this reason.
 *
 * Fails OPEN — a malformed or missing time means no quiet hours, so a bad pref
 * string cannot silently disable every notification in the app. A student who
 * gets one alert they did not want will say so; a student who gets none never
 * finds out why. Equal start and end is read the same way: a zero-length window
 * means "off", not "silent for 24 hours", because the latter is a way to break
 * the app with two identical values and no error.
 */
export function isWithinQuietHours(
  prefs: Pick<NotificationPrefs, 'quiet_hours_start' | 'quiet_hours_end'>,
  at: Date
): boolean {
  const start = parseClockMinutes(prefs.quiet_hours_start);
  const end = parseClockMinutes(prefs.quiet_hours_end);
  if (start === null || end === null || start === end) return false;

  const t = at.getHours() * 60 + at.getMinutes();
  if (start < end) return t >= start && t < end;
  return t >= start || t < end;
}

/**
 * Minutes from `at` until quiet hours end, or 0 when they are not in force.
 *
 * The sender uses this to decide *when* to try again rather than dropping a
 * suppressed notification: the watermark design (HANDOFF §8) means a skipped run
 * loses nothing, so a message that arrives at 23:00 is announced at 07:00 rather
 * than never. Do not advance `last_pushed_at` for a run this suppressed.
 */
export function minutesUntilQuietHoursEnd(
  prefs: Pick<NotificationPrefs, 'quiet_hours_start' | 'quiet_hours_end'>,
  at: Date
): number {
  if (!isWithinQuietHours(prefs, at)) return 0;
  const end = parseClockMinutes(prefs.quiet_hours_end);
  if (end === null) return 0;
  const t = at.getHours() * 60 + at.getMinutes();
  return t < end ? end - t : MINUTES_IN_DAY - t + end;
}

// ---------------------------------------------------------------------------
// The daily cap, and the one decision function
// ---------------------------------------------------------------------------

/**
 * Has the student had their non-urgent allowance for the day?
 *
 * `deliveredNonUrgentToday` is a COUNT OF DELIVERIES, which is the argument for
 * `notifications` being a delivery ledger rather than an event log (HANDOFF §8):
 * a cap you cannot count is a cap you cannot enforce, and no amount of reading
 * `messages` tells you what this student was actually told.
 *
 * A cap of 0 silences all non-urgent notifications, which is a legitimate
 * setting and must not be read as "unset". A negative or non-numeric cap is
 * treated as no cap, on the same fail-open reasoning as quiet hours.
 */
export function isDailyCapReached(
  prefs: Pick<NotificationPrefs, 'daily_cap'>,
  deliveredNonUrgentToday: number
): boolean {
  const cap = prefs.daily_cap;
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) return false;
  return deliveredNonUrgentToday >= cap;
}

/** Why a notification was withheld — for the sender's log, never for a student. */
export type WithheldReason =
  | 'push_disabled'
  | 'kind_disabled'
  | 'quiet_hours'
  | 'daily_cap';

export interface NotifyDecision {
  deliver: boolean;
  /** Null when delivering. */
  withheld: WithheldReason | null;
  /**
   * Minutes to wait before this is worth trying again, or 0 when retrying will
   * not help. Only `quiet_hours` sets it — a cap resets on its own day boundary
   * and a disabled switch needs the student, not time.
   */
  retryInMinutes: number;
}

/**
 * The single gate every notification passes through, local or remote.
 *
 * Order is deliberate and load-bearing:
 *
 *  1. `push_enabled` is the master switch. A student who turned notifications
 *     off gets nothing, including urgent — anything else makes the switch a lie.
 *  2. A per-kind switch, if the prefs carry one. `notification_prefs` is jsonb,
 *     so the prefs screen can add these keys with **no migration**, but every
 *     existing row predates them, which is why an absent key reads as ON.
 *  3. Quiet hours, EXCEPT for a study-time reminder. That exception is the
 *     point: a student who agreed to a 23:00 session chose to be woken for it,
 *     and suppressing the reminder they asked for to honour a default they never
 *     touched is the wrong way round. A cancellation is urgent but still waits —
 *     it is bad news, and 07:00 is soon enough to not walk to the library.
 *  4. The cap, urgent exempt, per `0001`.
 */
export function shouldNotify(input: {
  kind: NotificationKind;
  prefs: NotificationPrefs;
  /** Non-urgent deliveries already made to this student today. */
  deliveredNonUrgentToday: number;
  at: Date;
  /** Absent or absent-key means enabled — see step 2 above. */
  kindEnabled?: Partial<Record<NotificationKind, boolean>>;
}): NotifyDecision {
  const { kind, prefs, deliveredNonUrgentToday, at, kindEnabled } = input;
  const urgent = NOTIFICATION_URGENT[kind];

  if (prefs.push_enabled === false) {
    return { deliver: false, withheld: 'push_disabled', retryInMinutes: 0 };
  }
  if (kindEnabled?.[kind] === false) {
    return { deliver: false, withheld: 'kind_disabled', retryInMinutes: 0 };
  }
  if (kind !== 'session_reminder' && isWithinQuietHours(prefs, at)) {
    return {
      deliver: false,
      withheld: 'quiet_hours',
      retryInMinutes: minutesUntilQuietHoursEnd(prefs, at),
    };
  }
  if (!urgent && isDailyCapReached(prefs, deliveredNonUrgentToday)) {
    return { deliver: false, withheld: 'daily_cap', retryInMinutes: 0 };
  }
  return { deliver: true, withheld: null, retryInMinutes: 0 };
}

// ---------------------------------------------------------------------------
// The study-time reminder — the local half
// ---------------------------------------------------------------------------

/** The owner's number: "30mins to study time". */
export const REMINDER_LEAD_MIN = 30;

/**
 * How close to the fire time is too close to bother scheduling.
 *
 * An alarm placed for 20 seconds from now is worse than none: it arrives while
 * the student is still looking at the screen that caused it, and on Android an
 * inexact alarm may not arrive at all. Confirm a session starting in 25 minutes
 * and you simply do not get a 30-minute warning, which is honest.
 */
export const REMINDER_MIN_LEAD_MS = 60_000;

/**
 * When the alarm should go off, or null if the start is unparseable.
 *
 * Note this can be in the past — deliberately. The caller decides what to do
 * about that (`shouldScheduleReminder`), because "already gone" and "malformed"
 * are different problems and collapsing them into one null hides the second.
 */
export function reminderFireTime(
  startsAt: string,
  leadMin: number = REMINDER_LEAD_MIN
): Date | null {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() - Math.max(0, leadMin) * 60_000);
}

/**
 * The OS identifier for a session's alarm — stable, and derived from the
 * session id alone.
 *
 * Stability is what makes cancel-and-replace possible at all: `expo-
 * notifications` hands back its own identifier when you schedule, and keeping a
 * map of those in AsyncStorage means a reinstall, a cleared cache or a crash
 * between scheduling and saving leaves orphan alarms nothing can cancel. Deriving
 * the id from the session means the device can always name the alarm it wants
 * gone, having stored nothing.
 */
export const REMINDER_ID_PREFIX = 'studysync:session-reminder:';

export function reminderId(sessionId: string): string {
  return `${REMINDER_ID_PREFIX}${sessionId}`;
}

/**
 * Is this OS identifier one of ours?
 *
 * `getAllScheduledNotificationsAsync` returns everything the app has pending,
 * not just study reminders. `diffReminders` cancels what it does not recognise
 * as planned, so without this filter the first future feature to schedule a
 * local notification would have it silently cancelled on the next app start.
 */
export function isReminderId(id: string): boolean {
  return typeof id === 'string' && id.startsWith(REMINDER_ID_PREFIX);
}

/**
 * Does this session deserve an alarm on THIS student's device?
 *
 * Three conditions, each with a reason:
 *
 *  - **`confirmed` only.** A proposal nobody has agreed to is not a commitment,
 *    and waking a student for a meeting that never happened is the fastest way
 *    to get notifications turned off. `cancelled` obviously not.
 *  - **Not if they answered 'no'.** They said they are not coming. `maybe` and
 *    no answer at all both still get the alarm — an undecided student is exactly
 *    who a reminder is for, and a session that confirmed without them is still
 *    their group's meeting.
 *  - **Far enough ahead** to be worth placing (`REMINDER_MIN_LEAD_MS`). This is
 *    also why there is no separate past-session check: a session that has already
 *    started has a fire time half an hour behind that, so it fails here first.
 */
export function shouldScheduleReminder(
  session: Pick<GroupSessionRow, 'starts_at' | 'status' | 'my_response'>,
  now: Date = new Date(),
  leadMin: number = REMINDER_LEAD_MIN
): boolean {
  if (session.status !== 'confirmed') return false;
  if (session.my_response === 'no') return false;
  const fireAt = reminderFireTime(session.starts_at, leadMin);
  if (!fireAt) return false;
  return fireAt.getTime() - now.getTime() >= REMINDER_MIN_LEAD_MS;
}

// ---------------------------------------------------------------------------
// The words — one place, because two mechanisms deliver them
// ---------------------------------------------------------------------------

export interface NotificationContent {
  title: string;
  body: string;
}

/**
 * Everything a notification needs to say, per kind.
 *
 * A union rather than seven functions so the `switch` in `notificationContent`
 * is checked for exhaustiveness: add a kind to `NotificationKind` and this file
 * stops compiling until it has words. A notification with no copy is not a
 * smaller feature, it is an empty banner.
 *
 * `groupName` is on every arm because `GroupSessionRow` does not carry one — the
 * RPC returns sessions for a group already known to the caller (see
 * `planReminders`), so the name has to come in alongside the row.
 */
export type NotificationSubject =
  | {
      kind: 'session_reminder';
      groupName: string;
      startsAt: string;
      durationMin: number;
      location?: string | null;
      leadMin?: number;
    }
  | {
      kind: 'session_proposed';
      groupName: string;
      proposerName: string;
      startsAt: string;
      durationMin: number;
    }
  | {
      kind: 'session_confirmed';
      groupName: string;
      startsAt: string;
      durationMin: number;
      location?: string | null;
    }
  | { kind: 'session_cancelled'; groupName: string; startsAt: string; durationMin: number }
  | { kind: 'message_activity'; groupName: string; count: number; senderNames: string[] }
  | { kind: 'file_shared'; groupName: string; sharerName: string; fileName: string }
  | { kind: 'invitation'; groupName: string; inviterName: string };

/** A group with no name should be impossible; a banner reading "undefined" is worse. */
function groupLabel(groupName: string): string {
  return (groupName ?? '').trim() || 'Your study group';
}

function personLabel(name: string): string {
  return (name ?? '').trim() || 'A group member';
}

/**
 * "Ada", "Ada and Ben", "Ada and 2 others" — the same shape `waitingOnLabel`
 * already uses in chat, so a student is not counted one way on a card and
 * another way in a banner.
 */
function joinNames(names: readonly string[]): string {
  const clean = names.map((n) => (n ?? '').trim()).filter(Boolean);
  if (clean.length === 0) return '';
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean[0]} and ${clean.length - 1} others`;
}

/** " · Main Library", or nothing at all. Locations are optional in 0016. */
function locationSuffix(location: string | null | undefined): string {
  const trimmed = (location ?? '').trim();
  return trimmed ? ` · ${trimmed}` : '';
}

/**
 * The copy, for both mechanisms.
 *
 * Written here rather than at either call site because the same row can produce
 * a local alarm on one device and a push on another, and two spellings of the
 * same sentence is how a student ends up unsure whether they were told twice.
 *
 * `now` is injected for the same reason as everywhere else in `chatRules`: the
 * day words come from `sessionWhenLabel`, so "Tomorrow" has to be relative to a
 * clock a test can hold still.
 */
export function notificationContent(
  subject: NotificationSubject,
  now: Date = new Date()
): NotificationContent {
  const group = groupLabel(subject.groupName);

  switch (subject.kind) {
    case 'session_reminder': {
      const lead = subject.leadMin ?? REMINDER_LEAD_MIN;
      const clock = formatClock(subject.startsAt);
      const when = clock ? `${group} at ${clock}` : group;
      return {
        title: `Study time in ${formatDuration(lead)}`,
        body: `${when} · ${formatDuration(subject.durationMin)}${locationSuffix(subject.location)}`,
      };
    }

    case 'session_proposed':
      return {
        title: `New study time in ${group}`,
        body: `${personLabel(subject.proposerName)} suggested ${sessionWhenLabel(
          subject.startsAt,
          subject.durationMin,
          now
        )}. Say yes or no.`,
      };

    case 'session_confirmed':
      return {
        title: `Study time confirmed`,
        body: `${group} · ${sessionWhenLabel(
          subject.startsAt,
          subject.durationMin,
          now
        )}${locationSuffix(subject.location)}`,
      };

    case 'session_cancelled':
      return {
        title: `Study time cancelled`,
        body: `${group} · ${sessionWhenLabel(subject.startsAt, subject.durationMin, now)}`,
      };

    case 'message_activity': {
      const count = Math.max(1, Math.round(subject.count));
      const who = joinNames(subject.senderNames);
      const what = count === 1 ? '1 new message' : `${count} new messages`;
      return { title: group, body: who ? `${what} from ${who}` : what };
    }

    case 'file_shared':
      return {
        title: `New file in ${group}`,
        body: `${personLabel(subject.sharerName)} shared ${
          (subject.fileName ?? '').trim() || 'a file'
        }`,
      };

    case 'invitation':
      return {
        title: `Invitation to ${group}`,
        body: `${personLabel(subject.inviterName)} invited you to join.`,
      };
  }
}

/** The row-shaped door onto the alarm's own words, for `planReminders` and the card. */
export function reminderContent(
  session: Pick<GroupSessionRow, 'starts_at' | 'duration_min' | 'location'>,
  groupName: string,
  leadMin: number = REMINDER_LEAD_MIN
): NotificationContent {
  return notificationContent({
    kind: 'session_reminder',
    groupName,
    startsAt: session.starts_at,
    durationMin: session.duration_min,
    location: session.location,
    leadMin,
  });
}

// ---------------------------------------------------------------------------
// Planning the alarms, and reconciling with what the OS already holds
// ---------------------------------------------------------------------------

/** One alarm, ready to hand to the OS. `notifier.ts` adds nothing but the trigger. */
export interface PlannedReminder {
  /** `reminderId(sessionId)` — see there for why it is derived, not stored. */
  id: string;
  sessionId: string;
  fireAt: Date;
  title: string;
  body: string;
}

/**
 * The device-wide ceiling on pending alarms.
 *
 * **iOS keeps only the 64 soonest** local notifications per app and silently
 * drops the rest — no error, no warning, and the ones it drops are the ones
 * furthest out, which is at least the right end. 60 leaves headroom for whatever
 * else this app schedules later, and a student in more study sessions than that
 * has a different problem.
 */
export const MAX_PENDING_REMINDERS = 60;

/**
 * Every alarm ONE group's sessions deserve, soonest first.
 *
 * Per-group because `group_sessions` is a per-group RPC and its rows carry no
 * `group_id` — so the caller loops groups and concatenates, then hands the whole
 * list to `diffReminders`, which is where the device-wide cap belongs. Applying
 * the cap here would let one chatty group crowd out a session in another.
 */
export function planReminders(input: {
  sessions: readonly Pick<
    GroupSessionRow,
    'session_id' | 'starts_at' | 'duration_min' | 'location' | 'status' | 'my_response'
  >[];
  groupName: string;
  now?: Date;
  leadMin?: number;
}): PlannedReminder[] {
  const { sessions, groupName } = input;
  const now = input.now ?? new Date();
  const leadMin = input.leadMin ?? REMINDER_LEAD_MIN;

  const planned: PlannedReminder[] = [];
  for (const session of sessions) {
    if (!shouldScheduleReminder(session, now, leadMin)) continue;
    const fireAt = reminderFireTime(session.starts_at, leadMin);
    if (!fireAt) continue; // unreachable — shouldScheduleReminder already parsed it
    const { title, body } = reminderContent(session, groupName, leadMin);
    planned.push({ id: reminderId(session.session_id), sessionId: session.session_id, fireAt, title, body });
  }
  return planned.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
}

/**
 * Drop alarms whose moment has passed, so a plan may be reused later than it was
 * built.
 *
 * `planReminders` filters against the `now` it was handed. A plan read back off
 * the disk was built against an older `now` — possibly days older — and every
 * entry that has since fired, or is now too close to bother, has to go. An
 * overdue `fireAt` is not harmless: both platforms deliver a past-dated alarm
 * more or less immediately, so restoring an unpruned plan announces "study time
 * in 30 minutes" for a session that finished on Tuesday.
 *
 * Same `REMINDER_MIN_LEAD_MS` floor as `shouldScheduleReminder`, so a plan
 * restored from cache and one freshly gathered agree about the borderline case
 * instead of disagreeing on alternate app starts.
 */
export function prunePastReminders(
  planned: readonly PlannedReminder[],
  now: Date = new Date()
): PlannedReminder[] {
  return planned.filter(
    (reminder) => reminder.fireAt.getTime() - now.getTime() >= REMINDER_MIN_LEAD_MS
  );
}

/**
 * A plan as it survives on disk.
 *
 * `fireAt` is an ISO string rather than a `Date` because the cache is JSON in
 * AsyncStorage, and `JSON.parse` revives a serialised `Date` as a plain string.
 * A `PlannedReminder[]` cast straight out of the cache would typecheck, ship, and
 * then throw `fireAt.getTime is not a function` on somebody's phone — so the
 * stored shape is honest about being text and `reviveReminders` is the only way
 * back.
 */
export interface StoredReminder {
  id: string;
  sessionId: string;
  fireAt: string;
  title: string;
  body: string;
}

export function serializeReminders(
  planned: readonly PlannedReminder[]
): StoredReminder[] {
  return planned.map((reminder) => ({
    id: reminder.id,
    sessionId: reminder.sessionId,
    fireAt: reminder.fireAt.toISOString(),
    title: reminder.title,
    body: reminder.body,
  }));
}

/**
 * Rebuild a plan from whatever the cache actually held, discarding the rest.
 *
 * Defensive rather than trusting, because the input came off a phone's disk,
 * where a half-written entry, a blob written by an older shape of this file, or
 * plain corruption are all ordinary things to find. One unreadable row costs that
 * row's alarm and no more — throwing here would cost the student every alarm they
 * had, at the one moment the app is trying to restore them.
 */
export function reviveReminders(raw: unknown): PlannedReminder[] {
  if (!Array.isArray(raw)) return [];

  const revived: PlannedReminder[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, sessionId, fireAt, title, body } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !isReminderId(id)) continue;
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
    if (typeof title !== 'string' || typeof body !== 'string') continue;
    if (typeof fireAt !== 'string') continue;
    const at = new Date(fireAt);
    if (Number.isNaN(at.getTime())) continue;
    revived.push({ id, sessionId, fireAt: at, title, body });
  }
  return revived;
}

/** One alarm the OS says it is already holding, as `notifier.ts` reads it back. */
export interface ScheduledReminder {
  id: string;
  /**
   * Null when the trigger could not be read — a `DATE` trigger's shape differs
   * across platforms and versions, and an unreadable one is treated as stale
   * rather than assumed correct. Re-placing an alarm that was already right is
   * invisible; leaving a stale one is a student walking to the wrong meeting.
   */
  fireAt: Date | null;
}

/** The OS rounds trigger times; a second of slop is not a rescheduled session. */
export const REMINDER_FIRE_TOLERANCE_MS = 1000;

export interface ReminderDiff {
  toSchedule: PlannedReminder[];
  /** Cancel these FIRST — an id can be in both lists when its time moved. */
  toCancel: string[];
}

/**
 * What to change on the device so its pending alarms match the plan.
 *
 * This function is the reason re-opening the app cannot double an alarm, which is
 * the one bug this half of Stage 5 must not ship: the device does not remember
 * what it scheduled, it ASKS the OS and reconciles. `reminderId` makes that
 * possible by deriving the name from the session, so nothing has to be stored
 * between scheduling and the next launch.
 *
 * What it therefore handles, deliberately:
 *
 *  - **A session whose time moved.** Same id, different fire time: stale, so it
 *    is cancelled *and* re-placed. Matching on id alone is the version of this
 *    function that quietly keeps the old alarm forever.
 *  - **A session cancelled, left, or answered 'no' since last launch.** It is no
 *    longer planned, so its alarm goes. This is the whole cancel path — there is
 *    no separate "on cancel" bookkeeping to get out of step with.
 *  - **Alarms that are not ours** (`isReminderId`) are left completely alone.
 *  - **The iOS 64 ceiling**, applied to the soonest `MAX_PENDING_REMINDERS`
 *    across every group, since the limit is per app and not per group.
 */
export function diffReminders(
  planned: readonly PlannedReminder[],
  scheduled: readonly ScheduledReminder[]
): ReminderDiff {
  const keep = new Map<string, PlannedReminder>();
  for (const p of [...planned].sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())) {
    if (keep.size >= MAX_PENDING_REMINDERS) break;
    if (!keep.has(p.id)) keep.set(p.id, p);
  }

  const pending = new Map<string, Date | null>();
  for (const s of scheduled) {
    if (isReminderId(s.id)) pending.set(s.id, s.fireAt);
  }

  const toSchedule: PlannedReminder[] = [];
  const toCancel: string[] = [];

  for (const [id, p] of keep) {
    if (!pending.has(id)) {
      toSchedule.push(p);
      continue;
    }
    const at = pending.get(id) ?? null;
    const stale =
      at === null || Math.abs(at.getTime() - p.fireAt.getTime()) > REMINDER_FIRE_TOLERANCE_MS;
    if (stale) {
      toCancel.push(id);
      toSchedule.push(p);
    }
  }

  for (const id of pending.keys()) {
    if (!keep.has(id)) toCancel.push(id);
  }

  return { toSchedule, toCancel };
}

// ---------------------------------------------------------------------------
// The dedupe key — what makes the sender safe to run twice
// ---------------------------------------------------------------------------

/**
 * The unique `(user_id, dedupe_key)` value for one delivery (0019).
 *
 * The sender is a batch job over a watermark, so it WILL run twice on the same
 * rows: a retry after a timeout, two overlapping schedules, a redeploy mid-run.
 * The unique index turns that from "the student is told twice" into a conflict
 * the writer swallows, and this function is the single definition of what "the
 * same notification" means. It has to be computed identically by the Edge
 * Function, which is Deno and cannot import this file — so if that copy drifts,
 * the index stops protecting anything. Keep the shapes below in sync there.
 *
 *  - `session_proposed|confirmed|cancelled` — `subjectId` is the session id. One
 *    delivery per session per transition; the states are terminal enough that a
 *    session cannot be confirmed twice.
 *  - `file_shared` — the material id.
 *  - `invitation` — the invitation id.
 *  - `message_activity` — the group id, plus a **`bucket` of the watermark this
 *    run read** (`last_pushed_at` as ISO). That is what makes the chat digest
 *    idempotent: a re-run over the same watermark computes the same key and
 *    conflicts, while the next run has a later watermark and is allowed through.
 *    Keying on the group alone would announce a group's messages exactly once,
 *    ever.
 *  - `session_reminder` — never reaches here. It is local (`NOTIFICATION_LOCAL`),
 *    scheduled by the device, and the OS dedupes it by `reminderId`.
 */
export function notificationDedupeKey(input: {
  kind: NotificationKind;
  subjectId: string;
  bucket?: string | null;
}): string {
  const bucket = (input.bucket ?? '').trim();
  const base = `${input.kind}:${input.subjectId}`;
  return bucket ? `${base}:${bucket}` : base;
}
