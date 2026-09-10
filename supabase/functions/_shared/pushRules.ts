// ============================================================================
// StudySync — _shared/pushRules.ts (Deno, sender side)
// ----------------------------------------------------------------------------
// The Deno twin of the sender-relevant core of src/lib/notificationRules.ts.
// The Edge Function tree cannot reach up into src/ (path aliases, package
// resolution), the way it cannot reach matching.ts either — but unlike matching,
// the two copies here are NOT byte-mirrored with sentinels: the client file
// carries the whole inbox and local-reminder surface this sender never needs.
// The guard instead is a BEHAVIOURAL test, src/lib/__tests__/pushRules.test.ts,
// which loads both copies and asserts the tables and the decision/compose
// outputs agree. If you change a rule in notificationRules.ts — a weight, a
// window, a sentence — change it here too, and that test fails until you do.
//
// What lives here and why:
//   - the decision core (shouldNotify and everything under it), because 0021
//     made `notifications.withheld` a CHECK over exactly WithheldReason and the
//     sender is the only writer of that column;
//   - the dedupe-key shapes, because the unique (user_id, dedupe_key) index is
//     what makes a retried run safe, and the key must be spelled identically on
//     both sides (notificationRules.ts says so in so many words);
//   - the compose copy (notificationContent), because a remote push's words are
//     written once, by the sender, into the row — the client renders row.title /
//     row.body and never re-derives them.
//
// The one structural difference from the client: quiet hours are read off the
// STUDENT'S wall clock, but this process runs in UTC. So isWithinQuietHours
// takes a minimal Clock ({ getHours, getMinutes }) rather than a Date, and
// zonedClock() below builds one from an instant + the student's IANA zone
// (users.timezone, 0021). The client passes a plain Date — same interface, same
// answers, which is exactly what the behavioural test pins.
// ============================================================================

// ---------------------------------------------------------------------------
// The vocabulary — kept identical to src/types/database.ts and pinned by the
// behavioural test against notificationRules.ts's own tables.
// ---------------------------------------------------------------------------

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

export type NotificationSwitchKey =
  | 'notify_chat'
  | 'notify_sessions'
  | 'notify_files'
  | 'notify_invitations'
  | 'nudge_needs_one_yes'
  | 'nudge_free_slot'
  | 'nudge_group_quiet'
  | 'nudge_unanswered_invitation';

export type WithheldReason =
  | 'push_disabled'
  | 'kind_disabled'
  | 'quiet_hours'
  | 'daily_cap';

/** The prefs keys this sender reads. Absent means ON/default throughout. */
export interface NotificationPrefs {
  quiet_hours_start: string;
  quiet_hours_end: string;
  daily_cap: number;
  push_enabled: boolean;
  notify_chat?: boolean;
  notify_sessions?: boolean;
  notify_files?: boolean;
  notify_invitations?: boolean;
  nudge_needs_one_yes?: boolean;
  nudge_free_slot?: boolean;
  nudge_group_quiet?: boolean;
  nudge_unanswered_invitation?: boolean;
}

/** The jsonb column holds a subset of this on old rows; absent keys are defaults. */
export function withNotificationDefaults(
  prefs: Partial<NotificationPrefs> | null | undefined
): NotificationPrefs {
  return {
    quiet_hours_start: '22:00',
    quiet_hours_end: '07:00',
    daily_cap: 3,
    push_enabled: true,
    ...(prefs ?? {}),
  };
}

export const NOTIFICATION_URGENT: Record<NotificationKind, boolean> = {
  session_reminder: true,
  session_cancelled: true,
  group_matched: true,
  session_proposed: false,
  session_confirmed: false,
  message_activity: false,
  file_shared: false,
  invitation: false,
  session_needs_one_yes: false,
  group_free_slot: false,
  group_quiet: false,
  invitation_unanswered: false,
};

export const NOTIFICATION_PREF_KEY: Record<
  NotificationKind,
  NotificationSwitchKey | null
> = {
  session_reminder: null,
  session_proposed: 'notify_sessions',
  session_confirmed: 'notify_sessions',
  session_cancelled: 'notify_sessions',
  message_activity: 'notify_chat',
  file_shared: 'notify_files',
  invitation: 'notify_invitations',
  group_matched: null,
  session_needs_one_yes: 'nudge_needs_one_yes',
  group_free_slot: 'nudge_free_slot',
  group_quiet: 'nudge_group_quiet',
  invitation_unanswered: 'nudge_unanswered_invitation',
};

export type NotificationCooldown = 'none' | 'run' | 'week' | 'fortnight';

export const NOTIFICATION_COOLDOWN: Record<NotificationKind, NotificationCooldown> = {
  session_reminder: 'none',
  session_proposed: 'none',
  session_confirmed: 'none',
  session_cancelled: 'none',
  message_activity: 'run',
  file_shared: 'none',
  invitation: 'none',
  group_matched: 'none',
  session_needs_one_yes: 'none',
  group_free_slot: 'week',
  group_quiet: 'fortnight',
  invitation_unanswered: 'none',
};

export const NOTIFICATION_WITHHOLD_RETRYABLE: Record<WithheldReason, boolean> = {
  push_disabled: false,
  kind_disabled: false,
  quiet_hours: true,
  daily_cap: false,
};

export const WITHHELD_REASONS = Object.keys(
  NOTIFICATION_WITHHOLD_RETRYABLE
) as WithheldReason[];

/**
 * The zone a student's quiet hours are read in when `users.timezone` is null.
 *
 * 0021: "Null means 'not reported', and the sender treats it as the app's
 * default rather than as UTC." The app is built for University of Ibadan
 * students; this is that assumption, stated in the one place it is made.
 */
export const DEFAULT_TIMEZONE = 'Africa/Lagos';

// ---------------------------------------------------------------------------
// The decision core — same functions, same order, same fail-open answers.
// ---------------------------------------------------------------------------

/** 'HH:MM' to minutes since midnight, or null when it is not that. */
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
 * What isWithinQuietHours and minutesUntilQuietHoursEnd actually need: the wall
 * clock of whatever zone the caller decided on. A Date satisfies this in the
 * client (the student's own device IS the zone); the sender builds one with
 * zonedClock below.
 */
export interface WallClock {
  getHours(): number;
  getMinutes(): number;
}

export function isWithinQuietHours(
  prefs: Pick<NotificationPrefs, 'quiet_hours_start' | 'quiet_hours_end'>,
  at: WallClock
): boolean {
  const start = parseClockMinutes(prefs.quiet_hours_start);
  const end = parseClockMinutes(prefs.quiet_hours_end);
  if (start === null || end === null || start === end) return false;

  const t = at.getHours() * 60 + at.getMinutes();
  if (start < end) return t >= start && t < end;
  return t >= start || t < end;
}

const MINUTES_IN_DAY = 24 * 60;

export function minutesUntilQuietHoursEnd(
  prefs: Pick<NotificationPrefs, 'quiet_hours_start' | 'quiet_hours_end'>,
  at: WallClock
): number {
  if (!isWithinQuietHours(prefs, at)) return 0;
  const end = parseClockMinutes(prefs.quiet_hours_end);
  if (end === null) return 0;
  const t = at.getHours() * 60 + at.getMinutes();
  return t < end ? end - t : MINUTES_IN_DAY - t + end;
}

export function isDailyCapReached(
  prefs: Pick<NotificationPrefs, 'daily_cap'>,
  deliveredNonUrgentToday: number
): boolean {
  const cap = prefs.daily_cap;
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) return false;
  return deliveredNonUrgentToday >= cap;
}

export function isKindEnabled(
  prefs: NotificationPrefs,
  kind: NotificationKind
): boolean {
  const key = NOTIFICATION_PREF_KEY[kind];
  if (key === null) return true;
  return prefs[key] !== false;
}

export function kindEnabledFromPrefs(
  prefs: NotificationPrefs
): Partial<Record<NotificationKind, boolean>> {
  const out: Partial<Record<NotificationKind, boolean>> = {};
  for (const kind of Object.keys(NOTIFICATION_PREF_KEY) as NotificationKind[]) {
    out[kind] = isKindEnabled(prefs, kind);
  }
  return out;
}

export interface NotifyDecision {
  deliver: boolean;
  withheld: WithheldReason | null;
  retryInMinutes: number;
}

export function shouldNotify(input: {
  kind: NotificationKind;
  prefs: NotificationPrefs;
  deliveredNonUrgentToday: number;
  at: WallClock;
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

/**
 * The student's wall clock for one instant, as a Clock.
 *
 * Intl IS available in Deno (0021 checked this before choosing an IANA text
 * column), so the zone is used rather than an offset. An unknown zone throws
 * inside DateTimeFormat — caught here and retried against the default, on the
 * same fail-open reasoning as a malformed quiet-hours string: one alert at the
 * wrong hour beats silently dropping every alert the student has.
 */
export function zonedClock(at: Date, timeZone: string | null | undefined): WallClock {
  for (const zone of [(timeZone ?? '').trim(), DEFAULT_TIMEZONE]) {
    if (!zone) continue;
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(at);
      const read = (type: string) => Number(parts.find((p) => p.type === type)?.value);
      const hours = read('hour');
      const minutes = read('minute');
      if (Number.isFinite(hours) && Number.isFinite(minutes)) {
        return { getHours: () => hours, getMinutes: () => minutes };
      }
    } catch {
      // unknown zone — try the default
    }
  }
  // Unreachable while DEFAULT_TIMEZONE is a real IANA name; UTC keeps the
  // function total rather than letting it throw mid-sweep.
  return { getHours: () => at.getUTCHours(), getMinutes: () => at.getUTCMinutes() };
}

// ---------------------------------------------------------------------------
// The dedupe key — the reason a retried run is safe. Spell it EXACTLY as
// notificationDedupeKey in notificationRules.ts does.
// ---------------------------------------------------------------------------

export function notificationDedupeKey(input: {
  kind: NotificationKind;
  subjectId: string;
  bucket?: string | null;
}): string {
  const bucket = (input.bucket ?? '').trim();
  const base = `${input.kind}:${input.subjectId}`;
  return bucket ? `${base}:${bucket}` : base;
}

export function isoWeekLabel(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const isoDay = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - isoDay);
  const isoYear = d.getUTCFullYear();
  const firstThursday = Date.UTC(isoYear, 0, 4);
  const jan4Iso = new Date(firstThursday).getUTCDay() || 7;
  const week1Monday = firstThursday - (jan4Iso - 1) * 86_400_000;
  const week = Math.floor((d.getTime() - week1Monday) / (7 * 86_400_000)) + 1;
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function cooldownBucket(kind: NotificationKind, at: Date): string | null {
  switch (NOTIFICATION_COOLDOWN[kind]) {
    case 'week':
      return isoWeekLabel(at);
    case 'fortnight': {
      const label = isoWeekLabel(at);
      const week = Number(label.slice(-2));
      const start = week - ((week - 1) % 2);
      return `${label.slice(0, -2)}${String(start).padStart(2, '0')}`;
    }
    case 'none':
    case 'run':
      return null;
  }
}

// ---------------------------------------------------------------------------
// The words. Copied from notificationRules.ts's composer and the three clock
// helpers it leans on in chatRules.ts — local-clock, hand-rolled, no Intl.
// ---------------------------------------------------------------------------

export const REMINDER_LEAD_MIN = 30;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function localDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function dayLabel(dayKey: string, now: Date): string {
  if (!dayKey) return '';
  const [y, m, d] = dayKey.split('-').map(Number);
  if (!y || !m || !d) return dayKey;

  const todayKey = localDayKey(now.toISOString());
  if (dayKey === todayKey) return 'Today';

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey === localDayKey(yesterday.toISOString())) return 'Yesterday';

  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (dayKey === localDayKey(tomorrow.toISOString())) return 'Tomorrow';

  const month = MONTHS[m - 1] ?? '';
  return y === now.getFullYear() ? `${d} ${month}` : `${d} ${month} ${y}`;
}

function clock12(hours24: number, minutes: number): string {
  const suffix = hours24 < 12 ? 'am' : 'pm';
  const h12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return minutes === 0 ? `${h12}${suffix}` : `${h12}:${two(minutes)}${suffix}`;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return clock12(d.getHours(), d.getMinutes());
}

function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  const hPart = h > 0 ? `${h} hour${h === 1 ? '' : 's'}` : '';
  const mPart = m > 0 ? `${m} minute${m === 1 ? '' : 's'}` : '';
  if (hPart && mPart) return `${hPart} ${mPart}`;
  return hPart || mPart || '0 minutes';
}

function sessionWhenLabel(startsAt: string, durationMin: number, now: Date): string {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return '';
  const end = new Date(start.getTime() + Math.max(0, durationMin) * 60_000);
  const day = dayLabel(localDayKey(startsAt), now);
  return `${day}, ${formatClock(startsAt)} – ${formatClock(end.toISOString())}`;
}

export interface NotificationContent {
  title: string;
  body: string;
}

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
  | { kind: 'invitation'; groupName: string; inviterName: string }
  | {
      kind: 'session_needs_one_yes';
      groupName: string;
      startsAt: string;
      durationMin: number;
    }
  | {
      kind: 'group_free_slot';
      groupName: string;
      slotLabel: string;
      othersFree: number;
    }
  | { kind: 'group_quiet'; groupName: string; quietDays: number }
  | { kind: 'invitation_unanswered'; groupName: string; inviterName: string };

function groupLabel(groupName: string): string {
  return (groupName ?? '').trim() || 'Your study group';
}

function personLabel(name: string): string {
  return (name ?? '').trim() || 'A group member';
}

function joinNames(names: readonly string[]): string {
  const clean = names.map((n) => (n ?? '').trim()).filter(Boolean);
  if (clean.length === 0) return '';
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean[0]} and ${clean.length - 1} others`;
}

function locationSuffix(location: string | null | undefined): string {
  const trimmed = (location ?? '').trim();
  return trimmed ? ` · ${trimmed}` : '';
}

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

    case 'session_needs_one_yes':
      return {
        title: `One more yes needed`,
        body: `${group} · ${sessionWhenLabel(
          subject.startsAt,
          subject.durationMin,
          now
        )} is one yes from confirmed.`,
      };

    case 'group_free_slot': {
      const slot = (subject.slotLabel ?? '').trim();
      const others = Math.max(0, Math.round(subject.othersFree));
      const who =
        others === 0 ? 'You are' : others === 1 ? 'You and 1 other are' : `You and ${others} others are`;
      return {
        title: `${group} is free${slot ? ` ${slot}` : ''}`,
        body: slot
          ? `${who} free ${slot}. Propose a study time?`
          : `${who} free at the same time. Propose a study time?`,
      };
    }

    case 'group_quiet': {
      const days = Math.max(1, Math.round(subject.quietDays));
      return {
        title: `${group} has gone quiet`,
        body: `Nothing here for ${days === 1 ? 'a day' : `${days} days`}. Send a message or propose a study time.`,
      };
    }

    case 'invitation_unanswered':
      return {
        title: `Still deciding on ${group}?`,
        body: `${personLabel(subject.inviterName)}'s invitation is waiting for an answer.`,
      };
  }
}
