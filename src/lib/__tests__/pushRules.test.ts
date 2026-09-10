/**
 * Behavioural drift guard for the sender's rules copy.
 *
 * supabase/functions/_shared/pushRules.ts is the Deno twin of the
 * sender-relevant core of src/lib/notificationRules.ts (and of the three
 * chatRules.ts clock helpers its composer leans on). Unlike the matching /
 * availability mirrors it is NOT byte-identical — the client file also carries
 * the inbox and the local-reminder planning, which the sender never needs — so
 * the mirror.test.ts region trick cannot guard it. This test does the same job
 * by execution instead: both copies are loaded into one process and asserted
 * to give the same answers for the same questions.
 *
 * If this file fails, the sender and the app disagree about when a student
 * should be told something. Fix whichever copy you just edited; do not edit
 * this test to make the disagreement go away.
 */
import {
  NOTIFICATION_COOLDOWN,
  NOTIFICATION_PREF_KEY,
  NOTIFICATION_URGENT,
  NOTIFICATION_WITHHOLD_RETRYABLE,
  REMINDER_LEAD_MIN,
  WITHHELD_REASONS,
  cooldownBucket,
  isDailyCapReached,
  isWithinQuietHours,
  isoWeekLabel,
  kindEnabledFromPrefs,
  notificationContent,
  notificationDedupeKey,
  shouldNotify,
  withNotificationDefaults,
  type NotificationSubject,
} from '../notificationRules';

// tsc must not follow this import: supabase/functions is Deno, excluded from
// this tsconfig project, and its `.ts` import specifiers are rejected here.
// Jest resolves the require at runtime and transforms the file like any other.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const deno = require('../../../supabase/functions/_shared/pushRules.ts') as {
  NOTIFICATION_URGENT: typeof NOTIFICATION_URGENT;
  NOTIFICATION_PREF_KEY: typeof NOTIFICATION_PREF_KEY;
  NOTIFICATION_COOLDOWN: typeof NOTIFICATION_COOLDOWN;
  NOTIFICATION_WITHHOLD_RETRYABLE: typeof NOTIFICATION_WITHHOLD_RETRYABLE;
  WITHHELD_REASONS: typeof WITHHELD_REASONS;
  REMINDER_LEAD_MIN: number;
  isoWeekLabel: typeof isoWeekLabel;
  cooldownBucket: typeof cooldownBucket;
  notificationDedupeKey: typeof notificationDedupeKey;
  isDailyCapReached: typeof isDailyCapReached;
  isWithinQuietHours: (
    prefs: Parameters<typeof isWithinQuietHours>[0],
    at: { getHours(): number; getMinutes(): number }
  ) => boolean;
  zonedClock: (at: Date, timeZone: string | null | undefined) => {
    getHours(): number;
    getMinutes(): number;
  };
  kindEnabledFromPrefs: typeof kindEnabledFromPrefs;
  shouldNotify: (input: {
    kind: Parameters<typeof shouldNotify>[0]['kind'];
    prefs: Parameters<typeof shouldNotify>[0]['prefs'];
    deliveredNonUrgentToday: number;
    at: { getHours(): number; getMinutes(): number };
    kindEnabled?: Parameters<typeof shouldNotify>[0]['kindEnabled'];
  }) => ReturnType<typeof shouldNotify>;
  withNotificationDefaults: typeof withNotificationDefaults;
  notificationContent: (
    subject: NotificationSubject,
    now?: Date
  ) => { title: string; body: string };
};

const KINDS = Object.keys(NOTIFICATION_URGENT) as (keyof typeof NOTIFICATION_URGENT)[];

describe('pushRules Deno copy vs notificationRules (sender drift guard)', () => {
  it('the tables are identical, key for key and value for value', () => {
    expect(deno.NOTIFICATION_URGENT).toEqual(NOTIFICATION_URGENT);
    expect(deno.NOTIFICATION_PREF_KEY).toEqual(NOTIFICATION_PREF_KEY);
    expect(deno.NOTIFICATION_COOLDOWN).toEqual(NOTIFICATION_COOLDOWN);
    expect(deno.NOTIFICATION_WITHHOLD_RETRYABLE).toEqual(NOTIFICATION_WITHHOLD_RETRYABLE);
    expect(deno.WITHHELD_REASONS).toEqual(WITHHELD_REASONS);
    expect(deno.REMINDER_LEAD_MIN).toBe(REMINDER_LEAD_MIN);
  });

  it('zonedClock in this process zone reads the same wall clock a Date does', () => {
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Times chosen to straddle quiet-hours boundaries in either direction.
    for (const [h, m] of [[21, 59], [22, 0], [3, 30], [6, 59], [7, 0], [12, 0]] as const) {
      const at = new Date(2026, 8, 9, h, m);
      const clock = deno.zonedClock(at, here);
      expect(clock.getHours()).toBe(at.getHours());
      expect(clock.getMinutes()).toBe(at.getMinutes());
    }
  });

  it('isWithinQuietHours agrees through the midnight wrap, both sides', () => {
    const prefs = { quiet_hours_start: '22:00', quiet_hours_end: '07:00' };
    const forward = { quiet_hours_start: '09:00', quiet_hours_end: '18:00' };
    const off = { quiet_hours_start: '07:00', quiet_hours_end: '07:00' };
    const malformed = { quiet_hours_start: '25:99', quiet_hours_end: '07:00' };
    const at = new Date(2026, 2, 8, 23, 5);
    const daytime = new Date(2026, 2, 8, 12, 0);
    for (const p of [prefs, forward, off, malformed]) {
      expect(deno.isWithinQuietHours(p, at)).toBe(isWithinQuietHours(p, at));
      expect(deno.isWithinQuietHours(p, daytime)).toBe(isWithinQuietHours(p, daytime));
    }
    expect(deno.isWithinQuietHours(prefs, at)).toBe(true); // wrap window, late
    expect(deno.isWithinQuietHours(forward, daytime)).toBe(true); // same-day window
    expect(deno.isWithinQuietHours(off, at)).toBe(false); // equal start/end is off
  });

  it('the daily cap agrees at 0, at the boundary and past it', () => {
    for (const cap of [0, 3, 10]) {
      for (const delivered of [0, 2, 3, 11]) {
        expect(deno.isDailyCapReached({ daily_cap: cap }, delivered)).toBe(
          isDailyCapReached({ daily_cap: cap }, delivered)
        );
      }
    }
  });

  it('shouldNotify hands out the same decision for every kind in every state', () => {
    const on = withNotificationDefaults({});
    const pushOff = withNotificationDefaults({ push_enabled: false });
    const chatOff = withNotificationDefaults({ notify_chat: false, daily_cap: 1 });
    const nightOwl = withNotificationDefaults({ quiet_hours_start: '01:00', quiet_hours_end: '06:00' });
    const prefSets = [on, pushOff, chatOff, nightOwl];
    const at = new Date(2026, 4, 11, 3, 30); // inside both default and night-owl windows
    for (const prefs of prefSets) {
      const kindEnabled = kindEnabledFromPrefs(prefs);
      for (const kind of KINDS) {
        for (const delivered of [0, 3]) {
          expect(
            deno.shouldNotify({
              kind,
              prefs: deno.withNotificationDefaults(prefs),
              deliveredNonUrgentToday: delivered,
              at: deno.zonedClock(at, null),
              kindEnabled: deno.kindEnabledFromPrefs(deno.withNotificationDefaults(prefs)),
            })
          ).toEqual(
            shouldNotify({ kind, prefs, deliveredNonUrgentToday: delivered, at, kindEnabled })
          );
        }
      }
    }
    expect(kindEnabledFromPrefs(on)).toEqual(deno.kindEnabledFromPrefs(on));
  });

  it('dedupe keys are spelled identically, bucketed and not', () => {
    for (const kind of KINDS) {
      expect(
        deno.notificationDedupeKey({ kind, subjectId: 'sub-1' })
      ).toBe(notificationDedupeKey({ kind, subjectId: 'sub-1' }));
      expect(
        deno.notificationDedupeKey({ kind, subjectId: 'sub-1', bucket: '2026-W36' })
      ).toBe(notificationDedupeKey({ kind, subjectId: 'sub-1', bucket: '2026-W36' }));
      expect(
        deno.notificationDedupeKey({ kind, subjectId: 'sub-1', bucket: '  ' })
      ).toBe(notificationDedupeKey({ kind, subjectId: 'sub-1', bucket: '  ' }));
    }
  });

  it('ISO weeks and cooldown buckets agree, including the week-53 seam', () => {
    const instants = [
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-09-09T23:00:00Z'),
      new Date('2027-01-01T00:00:00Z'), // Friday — belongs to 2026's week 53
      new Date('2024-12-30T00:00:00Z'), // Monday of 2025's week 1
    ];
    for (const at of instants) {
      expect(deno.isoWeekLabel(at)).toBe(isoWeekLabel(at));
      for (const kind of KINDS) {
        expect(deno.cooldownBucket(kind, at)).toBe(cooldownBucket(kind, at));
      }
    }
    // The fortnight bucket is the ODD week label; even labels never appear.
    const fortnight = cooldownBucket('group_quiet', new Date('2026-09-09T00:00:00Z'));
    expect(Number(fortnight!.slice(-2)) % 2).toBe(1);
  });

  it('the words are identical for every subject both sides can compose', () => {
    const now = new Date(2026, 8, 9, 17, 45);
    const subjects: NotificationSubject[] = [
      { kind: 'session_reminder', groupName: 'BIO 201', startsAt: '2026-09-09T19:30:00', durationMin: 120, location: 'Kenneth Dike Library' },
      { kind: 'session_proposed', groupName: 'BIO 201', proposerName: 'Ada', startsAt: '2026-09-10T16:00:00', durationMin: 90 },
      { kind: 'session_confirmed', groupName: 'BIO 201', startsAt: '2026-09-10T16:00:00', durationMin: 90, location: null },
      { kind: 'session_cancelled', groupName: 'BIO 201', startsAt: '2026-09-10T16:00:00', durationMin: 90 },
      { kind: 'message_activity', groupName: 'BIO 201', count: 4, senderNames: ['Ada', 'Ben'] },
      { kind: 'message_activity', groupName: 'BIO 201', count: 1, senderNames: [] },
      { kind: 'file_shared', groupName: 'BIO 201', sharerName: 'Ada', fileName: 'past-paper.pdf' },
      { kind: 'invitation', groupName: 'BIO 201', inviterName: 'Ada' },
      { kind: 'session_needs_one_yes', groupName: 'BIO 201', startsAt: '2026-09-10T16:00:00', durationMin: 90 },
      { kind: 'group_free_slot', groupName: 'BIO 201', slotLabel: 'tomorrow afternoon', othersFree: 2 },
      { kind: 'group_free_slot', groupName: 'BIO 201', slotLabel: 'tomorrow afternoon', othersFree: 0 },
      { kind: 'group_quiet', groupName: 'BIO 201', quietDays: 9 },
      { kind: 'invitation_unanswered', groupName: 'BIO 201', inviterName: 'Ada' },
    ];
    for (const subject of subjects) {
      expect(deno.notificationContent(subject, now)).toEqual(notificationContent(subject, now));
    }
  });

  it('prefs defaults fill identically from an old jsonb row', () => {
    expect(deno.withNotificationDefaults(null)).toEqual(withNotificationDefaults(null));
    expect(deno.withNotificationDefaults({ daily_cap: 0 })).toEqual(
      withNotificationDefaults({ daily_cap: 0 })
    );
  });
});
