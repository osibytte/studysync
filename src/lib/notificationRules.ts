import {
  dayLabel,
  formatClock,
  formatDuration,
  localDayKey,
  materialWhenLabel,
  sessionWhenLabel,
} from '@/lib/chatRules';
import { DEFAULT_NOTIFICATION_PREFS } from '@/types/database';
import type {
  GroupSessionRow,
  Notification,
  NotificationKind,
  NotificationPrefs,
  NotificationSwitchKey,
  WithheldReason,
} from '@/types/database';

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
 * The kinds, and the five tables every one of them must appear in.
 *
 * `NotificationKind` itself lives in `@/types/database` beside the `notifications`
 * row shape it constrains, because `0019`'s check constraint is the other half of
 * the same fact — the same "change one, change both" the availability bitmask has
 * carried since Stage 1. Everything about what a kind *means* is here.
 *
 * Scope, verbatim: "push notification for chat activites (messages, meeting
 * schedule, files), phone alarm notification when its 30mins to study time".
 * Invitations are included because being invited is unusable if nobody tells you.
 * The last four are the nudges, added 2026-09-05 once the owner chose them for
 * "whatever notification is smart to indulge students to study" — all four of the
 * four proposed in HANDOFF §8. They are a union member each, so adding one broke
 * every `Record<NotificationKind, …>` below until it was answered for, which is
 * exactly why it was written that way.
 *
 * The five: `NOTIFICATION_KIND_LABEL` (wording), `NOTIFICATION_URGENT` (does it
 * bypass the cap), `NOTIFICATION_LOCAL` (device or server), `NOTIFICATION_COOLDOWN`
 * (how often at most) and `NOTIFICATION_PREF_KEY` (which switch turns it off).
 */

/** Wording for the prefs screen's per-kind switches (step 5). */
export const NOTIFICATION_KIND_LABEL: Record<NotificationKind, string> = {
  session_reminder: 'Study time reminders',
  session_proposed: 'New study times',
  session_confirmed: 'Confirmed study times',
  session_cancelled: 'Cancelled study times',
  message_activity: 'New messages',
  file_shared: 'Shared files',
  invitation: 'Group invitations',
  // Not switchable, and the label is only ever a heading in the inbox: you asked
  // the system to place you, so being told it did is the answer to your own
  // question. A switch for it would be a switch for "tell me whether the thing I
  // applied for happened".
  group_matched: 'Being matched into a group',
  session_needs_one_yes: 'Study times needing one more yes',
  group_free_slot: 'When your group is all free',
  group_quiet: 'When a group goes quiet',
  invitation_unanswered: 'Reminders about invitations you have not answered',
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
 *
 * `group_matched` is the third, added with 0020. A student who applied to be matched
 * has been waiting — possibly for weeks — with nothing else they are allowed to do
 * about it, and the group's first conversation happens whether or not anybody told
 * them. It also cannot flood: its dedupe key is the group id, so it fires once per
 * student per group and never again.
 *
 * **No nudge is ever urgent, and this is the line that protects the alarm.** A
 * nudge that ignores the cap is how a student comes to switch notifications off
 * at the OS level, and the 30-minute reminder they actually asked for dies with
 * them. `session_needs_one_yes` is the tempting one — it is time-limited and
 * genuinely useful — and it is still false: a proposal that expires costs a
 * meeting that was never agreed, which is not the same as being somewhere at the
 * wrong time.
 */
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

/**
 * True where the DEVICE schedules it, false where a server pushes it.
 *
 * Only the reminder is local, and it is local for the reason in the header: it
 * has to fire offline. Note what this table implies for the sender — it must
 * never push a `session_reminder`, or a student with a signal gets the alarm
 * twice and one of them at the wrong second. `0019`'s check constraint enforces
 * the same rule at the database, where it becomes a failed insert instead of a
 * duplicate alert.
 *
 * Every nudge is remote. Each one needs a question answered that this phone
 * cannot answer alone: whether anybody else has said yes, what the whole group's
 * shared availability is, whether a group has been quiet, whether an invitation
 * was ever replied to.
 */
export const NOTIFICATION_LOCAL: Record<NotificationKind, boolean> = {
  session_reminder: true,
  session_proposed: false,
  session_confirmed: false,
  session_cancelled: false,
  message_activity: false,
  file_shared: false,
  invitation: false,
  // Written by the DATABASE — `create_system_group` inserts it in the same
  // transaction that creates the group (0020 §8) — which is remote, not local, but
  // also not composed by the sender. Step 6's sender therefore has to push urgent
  // rows it did not write itself, or this one only ever appears in the in-app inbox.
  group_matched: false,
  session_needs_one_yes: false,
  group_free_slot: false,
  group_quiet: false,
  invitation_unanswered: false,
};

/**
 * How long a kind must stay silent about the same subject — the cooldown half of
 * the dedupe key.
 *
 * `0019` has no cooldown table, on purpose: the unique `(user_id, dedupe_key)`
 * index already refuses a second insert, so bucketing a period into the key makes
 * "at most once per fortnight" a collision rather than a scheduled job's
 * responsibility. This table says which period each kind buckets by, and
 * `cooldownBucket` below turns that into the string.
 *
 *  - `'none'` — the subject itself is the limit. A session is proposed once,
 *    confirmed once, cancelled once; a file is shared once; an invitation is
 *    extended once and chased once. Keying on the id is the whole rule.
 *  - `'run'` — the caller supplies the bucket, because it is data rather than a
 *    clock reading: `message_activity` buckets by the watermark the run read
 *    (`group_members.last_pushed_at`), which is what lets the next run through
 *    while a retry of this one collides.
 *  - `'week'` — a free-slot nudge, because `user_courses.availability` is a
 *    **weekly** 7x4 mask: the same slot is free again next Tuesday, and telling a
 *    group about it once a week is a suggestion where once a day is nagging.
 *  - `'fortnight'` — the quiet-group nudge. A group that has gone quiet is
 *    usually quiet for a reason, and the second reminder inside a week is the one
 *    that gets notifications switched off rather than the group revived.
 *
 * Nothing here is `'day'`, and the omission is the `daily_cap` argument again: a
 * nudge that can recur daily will, on some student's phone, be all three of their
 * three daily notifications.
 */
export type NotificationCooldown = 'none' | 'run' | 'week' | 'fortnight';

export const NOTIFICATION_COOLDOWN: Record<NotificationKind, NotificationCooldown> = {
  // Scheduled on the device and deduped by `reminderId`, so it never reaches a
  // dedupe key at all. 'none' is the honest answer rather than a special case.
  session_reminder: 'none',
  session_proposed: 'none',
  session_confirmed: 'none',
  session_cancelled: 'none',
  message_activity: 'run',
  file_shared: 'none',
  invitation: 'none',
  // The group id is the whole rule: you are placed in a given group once.
  group_matched: 'none',
  session_needs_one_yes: 'none',
  group_free_slot: 'week',
  group_quiet: 'fortnight',
  invitation_unanswered: 'none',
};

// ---------------------------------------------------------------------------
// The switches — which pref key turns each kind off (step 5's prefs screen)
// ---------------------------------------------------------------------------

/**
 * Which `notification_prefs` key governs each kind, and the fifth exhaustive
 * table a new kind has to be answered for.
 *
 * `shouldNotify` takes `kindEnabled` as a plain map rather than reading prefs
 * itself, which left the kind-to-key mapping unwritten: the prefs screen and the
 * Edge Function would each have invented one, and the first disagreement would be
 * a switch a student turned off that kept sending. So it is stated once, here,
 * beside the labels and the urgency.
 *
 * `session_reminder` maps to **null** and that is the design, not a gap. The
 * 30-minute alarm is scheduled by the device and governed by the OS — a switch
 * here would be a lie, because turning it off in the app cannot cancel an alarm
 * the OS has already accepted, and `notifier.ts` never asks. The student turns it
 * off in Settings, or by declining the permission prompt on the *yes* tap.
 *
 * `group_matched` also maps to **null**, for a different reason. It is the one
 * notification a student who applied is actually waiting for — the answer to a
 * request they made and cannot withdraw — so there is no switch to offer that a
 * student would sanely use. It is not unstoppable, though, the way the alarm is:
 * it is delivered by push, so `push_enabled` still silences it, and the row
 * lands in the inbox either way.
 *
 * Several kinds deliberately share a key: nobody wants a group's study times
 * split into three switches, so proposed/confirmed/cancelled ride together on
 * `notify_sessions`. The four nudges each get their own, because the whole point
 * of nudges is that a student keeps the one they like and silences the rest.
 */
export const NOTIFICATION_PREF_KEY: Record<NotificationKind, NotificationSwitchKey | null> = {
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

/**
 * Is this kind switched on for this student?
 *
 * **Absent means ON**, and that is the normal case rather than an edge one:
 * `0001`'s jsonb default carries none of these keys, so every account created
 * before Stage 5 is missing all eight and there is no backfill. Only an explicit
 * `false` silences anything. A kind with no key (the local alarm) is always on as
 * far as this app is concerned — the OS has the only switch that matters.
 */
export function isKindEnabled(prefs: NotificationPrefs, kind: NotificationKind): boolean {
  const key = NOTIFICATION_PREF_KEY[kind];
  if (key === null) return true;
  return prefs[key] !== false;
}

/**
 * Prefs to the map `shouldNotify` wants. One caller, one meaning, no drift — the
 * sender builds it the same way the prefs screen reads it.
 */
export function kindEnabledFromPrefs(
  prefs: NotificationPrefs
): Partial<Record<NotificationKind, boolean>> {
  const out: Partial<Record<NotificationKind, boolean>> = {};
  for (const kind of Object.keys(NOTIFICATION_PREF_KEY) as NotificationKind[]) {
    out[kind] = isKindEnabled(prefs, kind);
  }
  return out;
}

export interface NotificationSwitchMeta {
  label: string;
  /**
   * The one line under the label. Where a kind has a cooldown, this is where the
   * student is told — "at most once a week" is the difference between a setting
   * they trust and one they switch off to find out what it does.
   */
  hint: string;
  /** Engagement rather than information, so the screen can group and explain them. */
  nudge: boolean;
}

/** Wording for the prefs screen, one entry per switch rather than per kind. */
export const NOTIFICATION_SWITCH: Record<NotificationSwitchKey, NotificationSwitchMeta> = {
  notify_chat: {
    label: 'New messages',
    hint: 'One summary per group, never one per message.',
    nudge: false,
  },
  notify_files: {
    label: 'Shared files',
    hint: 'When somebody adds a file to a group.',
    nudge: false,
  },
  notify_sessions: {
    label: 'Study times',
    hint: 'Proposed, confirmed and cancelled. The 30-minute alarm is separate.',
    nudge: false,
  },
  notify_invitations: {
    label: 'Group invitations',
    hint: 'When somebody invites you to a group.',
    nudge: false,
  },
  nudge_needs_one_yes: {
    label: 'One more yes',
    hint: 'When a study time needs a single yes to be confirmed.',
    nudge: true,
  },
  nudge_free_slot: {
    label: 'When your group is all free',
    hint: 'At most once a week, and only for a slot everybody has open.',
    nudge: true,
  },
  nudge_group_quiet: {
    label: 'When a group goes quiet',
    hint: 'At most once a fortnight.',
    nudge: true,
  },
  nudge_unanswered_invitation: {
    label: 'Invitations you have not answered',
    hint: 'One reminder per invitation, never a second.',
    nudge: true,
  },
};

/**
 * Screen order: the four things that happened, then the four nudges.
 *
 * A separate array because `Record` key order is not something to render off —
 * and a test asserts it covers every key exactly once, so a ninth switch cannot
 * be added to the type and then quietly never shown.
 */
export const NOTIFICATION_SWITCH_ORDER: readonly NotificationSwitchKey[] = [
  'notify_chat',
  'notify_sessions',
  'notify_files',
  'notify_invitations',
  'nudge_needs_one_yes',
  'nudge_free_slot',
  'nudge_group_quiet',
  'nudge_unanswered_invitation',
];

export interface NotificationSwitchRow extends NotificationSwitchMeta {
  key: NotificationSwitchKey;
  /** Current value, with an absent key read as on. */
  enabled: boolean;
  /** The kinds this row governs — what the switch actually silences. */
  kinds: NotificationKind[];
}

/** The prefs screen's rows, in order, resolved against one student's prefs. */
export function notificationSwitchRows(prefs: NotificationPrefs): NotificationSwitchRow[] {
  return NOTIFICATION_SWITCH_ORDER.map((key) => ({
    key,
    ...NOTIFICATION_SWITCH[key],
    enabled: prefs[key] !== false,
    kinds: (Object.keys(NOTIFICATION_PREF_KEY) as NotificationKind[]).filter(
      (kind) => NOTIFICATION_PREF_KEY[kind] === key
    ),
  }));
}

/**
 * Chips rather than a number field, because a cap is a choice between a few
 * sensible answers and a keyboard invites 0 typed as 100.
 *
 * **Zero is on the list and it is not a mistake.** `isDailyCapReached` reads it as
 * "silence every non-urgent notification", a legitimate setting for a student who
 * only wants to hear that a session was confirmed or called off — and the label
 * has to say so, or it reads as "off" and gets picked by somebody who then
 * wonders why the app went quiet.
 */
export const DAILY_CAP_CHOICES: readonly number[] = [0, 1, 2, 3, 5, 10];

export function dailyCapLabel(cap: number): string {
  if (!Number.isFinite(cap) || cap <= 0) return 'Urgent only';
  return cap === 1 ? '1 a day' : `${cap} a day`;
}

/** Whole hours only: 48 half-hour chips is a worse screen than a coarser window. */
export const QUIET_HOUR_CHOICES: readonly string[] = Array.from(
  { length: 24 },
  (_, hour) => `${String(hour).padStart(2, '0')}:00`
);

/**
 * Is a quiet-hours window actually in force?
 *
 * Equal start and end is `isWithinQuietHours`'s own definition of "off", so the
 * screen needs no third setting and no extra jsonb key to express it — turning
 * quiet hours off is setting the end to the start. Two facts, one representation.
 */
export function quietHoursEnabled(
  prefs: Pick<NotificationPrefs, 'quiet_hours_start' | 'quiet_hours_end'>
): boolean {
  const start = parseClockMinutes(prefs.quiet_hours_start);
  const end = parseClockMinutes(prefs.quiet_hours_end);
  return start !== null && end !== null && start !== end;
}

/** "22:00 to 07:00, overnight" — the wrap named, because it surprises people. */
export function quietHoursLabel(
  prefs: Pick<NotificationPrefs, 'quiet_hours_start' | 'quiet_hours_end'>
): string {
  if (!quietHoursEnabled(prefs)) return 'Off — notifications can arrive at any hour';
  const start = parseClockMinutes(prefs.quiet_hours_start) as number;
  const end = parseClockMinutes(prefs.quiet_hours_end) as number;
  const wraps = start > end;
  return `${prefs.quiet_hours_start} to ${prefs.quiet_hours_end}${wraps ? ', overnight' : ''}`;
}

/**
 * One student's prefs with every missing key filled from `0001`'s defaults.
 *
 * The screen needs a complete object to render a switch position and a chip
 * selection, and `notification_prefs` is jsonb: a row written before Stage 5 has
 * four keys, a row written by an older client could have any subset, and a row
 * hand-edited in the dashboard could have none. Merging once here means no screen
 * has to decide what an absent `daily_cap` looks like — and the per-kind keys are
 * deliberately left absent rather than defaulted to `true`, so saving the screen
 * without touching a switch does not write eight keys that mean nothing.
 */
export function withNotificationDefaults(
  prefs: Partial<NotificationPrefs> | null | undefined
): NotificationPrefs {
  return { ...DEFAULT_NOTIFICATION_PREFS, ...(prefs ?? {}) };
}

// ---------------------------------------------------------------------------
// The in-app inbox (step 5)
// ---------------------------------------------------------------------------

/**
 * How many of these has the student not dismissed?
 *
 * Counted from the rows on screen rather than asked of the server, because the
 * inbox already holds them and a second round trip would be a number that can
 * disagree with the list under it. The badge on home is the one that asks the
 * server, for the same reason `useUnread` does.
 */
export function countUnreadNotifications(rows: readonly Pick<Notification, 'read_at'>[]): number {
  return rows.reduce((n, row) => (row.read_at === null ? n + 1 : n), 0);
}

/** "Today · 4:05pm", "Yesterday · 8am", "3 Sep" — a notification is always past. */
export function notificationWhenLabel(iso: string, now: Date = new Date()): string {
  return materialWhenLabel(iso, now);
}

export interface InboxNotificationItem {
  type: 'notification';
  key: string;
  row: Notification;
}

export interface InboxDayItem {
  type: 'day';
  key: string;
  label: string;
}

export type InboxItem = InboxNotificationItem | InboxDayItem;

/**
 * The inbox as a flat list with day headers, newest first — the same shape and
 * the same reason as `buildTimeline`: one array a `FlatList` can render without
 * deciding anything, so the ordering rule is testable without a renderer.
 *
 * Rows are NOT re-sorted. They arrive from `0019`'s keyset index
 * `(user_id, created_at desc, notification_id desc)` and re-sorting here on
 * `created_at` alone would break the tie the index resolves, dropping or
 * repeating a row across pages.
 */
export function buildInbox(rows: readonly Notification[], now: Date = new Date()): InboxItem[] {
  const items: InboxItem[] = [];
  let lastDayKey = '';
  for (const row of rows) {
    const dayKey = localDayKey(row.created_at);
    if (dayKey !== lastDayKey) {
      items.push({ type: 'day', key: `day:${dayKey}`, label: dayLabel(dayKey, now) });
      lastDayKey = dayKey;
    }
    items.push({ type: 'notification', key: row.notification_id, row });
  }
  return items;
}

/**
 * Where tapping a notification should take the student, or null when nowhere.
 *
 * An exhaustive `switch` rather than a table, and it is the SIXTH thing a new kind
 * has to be answered for: a notification you cannot tap through is a dead end, and
 * the compiler is the only thing that will notice one. A `default` arm returning
 * null would have silently absorbed every kind added after this was written, which
 * is the exact failure the five tables above are shaped to prevent.
 *
 * Null is a real answer, twice over. A group-scoped kind whose `group_id` is null —
 * possible, since `0019` allows it and a cascade nulls nothing but deletes the row —
 * has nowhere to go, and so does anything not tied to a place in the app. The inbox
 * renders those as plain, unpressable rows: the title and body are the whole
 * message, which for `group_matched` is very nearly true anyway.
 *
 * Note what each destination is chosen for. `file_shared` goes to the files tab
 * rather than the timeline, because a student told about a file wants the file, and
 * the timeline entry for it is hundreds of messages back by the time they look.
 * Everything session-shaped goes to the timeline, because that is where a study
 * time is answered — the group's front page can only show it.
 */
export function notificationRoute(
  row: Pick<Notification, 'kind' | 'group_id'>
): string | null {
  const gid = row.group_id;
  switch (row.kind) {
    // The timeline: where a proposal is answered and a cancellation explained.
    case 'session_proposed':
    case 'session_confirmed':
    case 'session_cancelled':
    case 'session_needs_one_yes':
    case 'message_activity':
      return gid ? `/(app)/groups/${gid}/chat` : null;
    // The files tab, for the reason in the header.
    case 'file_shared':
      return gid ? `/(app)/groups/${gid}/files` : null;
    // The group's front page: a nudge is about the group, not a message in it.
    case 'group_matched':
    case 'group_free_slot':
    case 'group_quiet':
      return gid ? `/(app)/groups/${gid}` : null;
    // Not group-scoped from the recipient's side — they are not a member yet, so
    // the group's own screens would refuse them. The invitations list is the place
    // the answer is given.
    case 'invitation':
    case 'invitation_unanswered':
      return '/(app)/groups/invitations';
  }
}

/**
 * Newest first, `notification_id` breaking the tie — the exact order of
 * `notifications_inbox_idx (user_id, created_at desc, notification_id desc)`.
 *
 * Both columns, for the reason `compareMessagesNewestFirst` needs both: a sender
 * fan-out writes every recipient's row in one statement, so `now()` is identical
 * across them, and an order that only looks at `created_at` is unstable exactly
 * where the keyset cursor has to be stable.
 */
export function compareNotificationsNewestFirst(a: Notification, b: Notification): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  if (a.notification_id === b.notification_id) return 0;
  return a.notification_id < b.notification_id ? 1 : -1;
}

/** Where the next (older) page starts. Null when nothing is loaded yet. */
export interface NotificationCursor {
  created_at: string;
  notification_id: string;
}

/**
 * The keyset cursor for "load older": the oldest notification currently held.
 *
 * Both columns again. Asking only for `created_at < cursor` drops every row
 * sharing that instant, and a dropped notification appears in neither page — the
 * student is never told, and nothing anywhere says so.
 */
export function nextInboxCursor(
  rows: readonly Notification[]
): NotificationCursor | null {
  if (rows.length === 0) return null;
  let oldest = rows[0];
  for (const row of rows) {
    if (compareNotificationsNewestFirst(row, oldest) > 0) oldest = row;
  }
  return { created_at: oldest.created_at, notification_id: oldest.notification_id };
}

/**
 * Merge a fetched page into what is held, keyed by id and re-sorted.
 *
 * By id rather than by concatenation, because the same row legitimately arrives
 * twice: the boundary row of a keyset page, and a refetch on focus overlapping a
 * page already loaded. Appending would render it twice, and the duplicate would
 * be a notification the student has to dismiss twice.
 */
export function upsertNotifications(
  current: readonly Notification[],
  incoming: readonly Notification[]
): Notification[] {
  if (incoming.length === 0) return [...current];
  const byId = new Map<string, Notification>();
  for (const row of current) byId.set(row.notification_id, row);
  for (const row of incoming) byId.set(row.notification_id, row);
  return [...byId.values()].sort(compareNotificationsNewestFirst);
}

/**
 * Stamp one row read locally, for the optimistic tap.
 *
 * `??=` semantics, not assignment: an already-read row keeps its original
 * `read_at`, matching `mark_notification_read`'s `coalesce(read_at, now())`. If
 * the client moved the timestamp and the server did not, the row would jump
 * position after the next fetch — the screen re-sorting under a thumb that has
 * only just tapped it.
 *
 * The row stays in the list. A dismissal that made it vanish would leave the
 * student no way back to something they tapped by accident; the screen renders it
 * dimmed instead.
 */
export function applyNotificationRead(
  rows: readonly Notification[],
  notificationId: string,
  at: string
): Notification[] {
  return rows.map((row) =>
    row.notification_id === notificationId && row.read_at === null
      ? { ...row, read_at: at }
      : row
  );
}

/** The same, for "clear all": every unread row, one instant. */
export function applyAllNotificationsRead(
  rows: readonly Notification[],
  at: string
): Notification[] {
  return rows.map((row) => (row.read_at === null ? { ...row, read_at: at } : row));
}

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

/**
 * Why a notification was withheld — for the sender's log, never for a student.
 *
 * Declared in `src/types/database.ts` since `0021` gave it a CHECK, and re-exported
 * here because this is where it is decided. One spelling, two homes, no drift.
 */
export type { WithheldReason };

/**
 * Is this withholding worth coming back to?
 *
 * The sixth per-kind-style table, and the reason `notifications.withheld` is a
 * four-value column rather than a boolean. Exactly one reason is a DELAY:
 *
 *   - `quiet_hours` — the event still matters, the hour does not suit. The sender
 *     is meant to return when the window ends, which is what
 *     `minutesUntilQuietHoursEnd` computes.
 *   - `daily_cap` — spent for today, but a row already withheld is not owed a
 *     later delivery. Tomorrow's allowance belongs to tomorrow's notifications;
 *     replaying yesterday's would mean the cap only ever deferred noise.
 *   - `push_disabled` / `kind_disabled` — the student's own answer. Time cannot
 *     change it, and re-pushing when they flip the switch back on would deliver a
 *     backlog of things they had chosen not to hear.
 *
 * A `Record` rather than a list so adding a reason to the union without deciding
 * this fails to compile, and so the mirror test has a runtime witness for a type
 * that otherwise vanishes at build time.
 */
export const NOTIFICATION_WITHHOLD_RETRYABLE: Record<WithheldReason, boolean> = {
  push_disabled: false,
  kind_disabled: false,
  quiet_hours: true,
  daily_cap: false,
};

/** Every reason, in declaration order — the runtime shadow of `WithheldReason`. */
export const WITHHELD_REASONS = Object.keys(
  NOTIFICATION_WITHHOLD_RETRYABLE
) as WithheldReason[];

/**
 * Whether the sender should pick a withheld row back up.
 *
 * Takes `null` because that is what the column holds for a row that was never
 * withheld at all, and such a row is pending rather than retryable — the sender
 * has not tried it yet, so there is nothing to retry.
 */
export function isRetryableWithholding(reason: WithheldReason | null): boolean {
  if (reason === null) return false;
  return NOTIFICATION_WITHHOLD_RETRYABLE[reason] === true;
}

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
 * ONE KIND IS DELIBERATELY ABSENT. `'group_matched'` has no arm here because its
 * words are composed in SQL, inside `create_system_group` (0020 §8): the row has to
 * be written in the same transaction that creates the group, or a run that dies in
 * between leaves students grouped and never told with nothing to retry it. Adding an
 * arm would give that sentence a second spelling, which is precisely what this union
 * exists to prevent. Note the consequence — a new kind that IS sender-composed still
 * breaks the switch until it has copy, but the compiler cannot tell you when a new
 * kind should have been added here rather than to a migration. That call is made once,
 * per kind, and written down at the kind.
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
  | { kind: 'invitation'; groupName: string; inviterName: string }
  // ---- The four nudges. Every one names an action, because a notification a
  // student cannot act on is the one they turn off.
  | {
      kind: 'session_needs_one_yes';
      groupName: string;
      startsAt: string;
      durationMin: number;
    }
  | {
      kind: 'group_free_slot';
      groupName: string;
      /**
       * "tomorrow 4-6pm" — already words, not a bitmask. The sender turns
       * `group_common_availability`'s mask into this, because the mask means
       * nothing without knowing the 7x4 slot layout and that knowledge belongs
       * with `availability.ts`, not in a banner.
       */
      slotLabel: string;
      /** How many OTHER members share the slot. 0 is possible and handled. */
      othersFree: number;
    }
  | { kind: 'group_quiet'; groupName: string; quietDays: number }
  | { kind: 'invitation_unanswered'; groupName: string; inviterName: string };

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

    // ---- The nudges ------------------------------------------------------
    // Each body ends in the action, and each names the thing it is about, so a
    // student reading a lock screen knows what they would be agreeing to before
    // they unlock. None of them says what another student is doing right now —
    // that privacy line has held since 0010, where every read returns a name and
    // a department and never a raw availability mask.

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
      // "You and 2 others", "You and 1 other", or just "You" — a group of one is
      // real (0006 disbands on empty, not on one), and "You and 0 others are
      // free" is the kind of sentence that makes an app look unfinished.
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
 *
 * And the four nudges, whose keys are where their "at most once per …" lives —
 * `NOTIFICATION_COOLDOWN` names the period and `cooldownBucket` computes it:
 *
 *  - `session_needs_one_yes` — the session id, no bucket. One chase per proposal:
 *    the tally can cross the one-short line more than once as members change their
 *    minds, and saying it again each time is how a useful nudge becomes nagging.
 *  - `group_free_slot` — the group id, bucketed by ISO week, because the
 *    availability mask it comes from is itself weekly.
 *  - `group_quiet` — the group id, bucketed by fortnight.
 *  - `invitation_unanswered` — the invitation id, no bucket. Exactly one chase,
 *    ever; a second is the app arguing with a decision already made by silence.
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

/**
 * The ISO-8601 week a moment falls in, as `'2026-W36'`.
 *
 * Hand-rolled because Hermes on Android shipped without `Intl` (HANDOFF §6), and
 * because the Edge Function needs the identical answer in Deno — a helper that
 * only exists in one runtime is the drift this file keeps warning about.
 *
 * **UTC, deliberately.** Every other date rule here reads the student's local
 * clock, and this one must not: the only writer of a dedupe key is a server that
 * has no idea what timezone the student is in — the schema has never stored one —
 * so a local-clock bucket would put two different strings on the same fortnight
 * and the unique index would stop refusing anything. The cost is that a student
 * near a date line gets their week boundary a few hours off their own midnight,
 * which nobody can perceive in a fortnightly nudge.
 *
 * ISO weeks start Monday and belong to the year containing their Thursday, which
 * is why the arithmetic hops to Thursday first: 1 January 2027 is a Friday, so it
 * is in week 53 of 2026, and a naive `Math.ceil(dayOfYear / 7)` would call it week
 * 1 of 2027 and hand out a fresh bucket four days early.
 */
export function isoWeekLabel(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  // Monday = 1 … Sunday = 7, rather than JS's Sunday = 0.
  const isoDay = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - isoDay);
  const isoYear = d.getUTCFullYear();
  const firstThursday = Date.UTC(isoYear, 0, 4);
  const jan4Iso = new Date(firstThursday).getUTCDay() || 7;
  const week1Monday = firstThursday - (jan4Iso - 1) * 86_400_000;
  const week = Math.floor((d.getTime() - week1Monday) / (7 * 86_400_000)) + 1;
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * The bucket to pass to `notificationDedupeKey` for a kind whose cooldown is a
 * period rather than its own subject.
 *
 * Null means "do not bucket", and it means that for two different reasons the
 * caller does not need to tell apart: a `'none'` kind has no cooldown, and a
 * `'run'` kind has one the clock cannot supply — for `message_activity` the sender
 * passes the watermark it read instead, and passing this function's null would
 * silently turn a per-run digest into a once-ever announcement. That is the one
 * mistake worth stating out loud, because nothing would throw.
 *
 * A fortnight is expressed as the ISO week label of the fortnight's **first**
 * week, aligned to odd week numbers, so the bucket changes every second week and
 * still reads as a week somebody can find on a calendar — `'2026-W35'` covers
 * weeks 35 and 36. Even labels therefore never appear, which is the tell that a
 * fortnightly key is doing what it claims. Odd rather than even alignment because
 * week 1 exists and week 0 does not: aligning down to even would bucket the first
 * fortnight of every year as `W00`.
 */
export function cooldownBucket(kind: NotificationKind, at: Date): string | null {
  switch (NOTIFICATION_COOLDOWN[kind]) {
    case 'week':
      return isoWeekLabel(at);
    case 'fortnight': {
      const label = isoWeekLabel(at);
      const week = Number(label.slice(-2));
      // Pairs are (1,2), (3,4) … (51,52), with 53 alone in the years that have
      // one — a seam once every five or six years, in a nudge whose whole purpose
      // is to be rare.
      const start = week - ((week - 1) % 2);
      return `${label.slice(0, -2)}${String(start).padStart(2, '0')}`;
    }
    case 'none':
    case 'run':
      return null;
  }
}
