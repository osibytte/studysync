import {
  MAX_PENDING_REMINDERS,
  NOTIFICATION_KIND_LABEL,
  NOTIFICATION_LOCAL,
  NOTIFICATION_URGENT,
  REMINDER_FIRE_TOLERANCE_MS,
  REMINDER_ID_PREFIX,
  REMINDER_LEAD_MIN,
  REMINDER_MIN_LEAD_MS,
  diffReminders,
  isDailyCapReached,
  isReminderId,
  isWithinQuietHours,
  minutesUntilQuietHoursEnd,
  notificationContent,
  notificationDedupeKey,
  parseClockMinutes,
  planReminders,
  reminderContent,
  reminderFireTime,
  reminderId,
  shouldNotify,
  shouldScheduleReminder,
} from '../notificationRules';
import type {
  NotificationKind,
  NotificationSubject,
  PlannedReminder,
  ScheduledReminder,
} from '../notificationRules';
import type {
  GroupSessionRow,
  NotificationPrefs,
  SessionResponseValue,
  SessionStatus,
} from '@/types/database';

/**
 * Stage 5's rules, pinned. Nothing here can be reached through a screen (§6 of
 * HANDOFF — no renderer is installed), and every one of these functions is the
 * kind that fails silently: a quiet-hours window that matches nothing, a cap
 * that counts the wrong deliveries, an alarm placed for a cancelled session.
 *
 * Local wall-clock instants throughout, for the same reason as
 * `chatRules.test.ts`: the suite has no fixed TZ and quiet hours are read off
 * the student's own clock, so a hardcoded 'Z' would assert a different hour in
 * Lagos than in CI.
 */
function localIso(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): string {
  return new Date(y, mo - 1, d, h, mi, s).toISOString();
}

function at(h: number, mi = 0): Date {
  return new Date(2026, 8, 5, h, mi, 0);
}

/** Listed out so adding a union member fails here as well as in the type. */
const ALL_KINDS: NotificationKind[] = [
  'session_reminder',
  'session_proposed',
  'session_confirmed',
  'session_cancelled',
  'message_activity',
  'file_shared',
  'invitation',
];
const ALL_STATUSES: SessionStatus[] = ['proposed', 'confirmed', 'cancelled'];
const ALL_RESPONSES: SessionResponseValue[] = ['yes', 'no', 'maybe'];

/**
 * `unknown` values on purpose: `notification_prefs` is jsonb with no CHECK
 * behind it, so a row really can hold `'25:00'` or `null` where the interface
 * promises a string. The cast is the point of the fail-open tests below.
 */
function prefs(over: Partial<Record<keyof NotificationPrefs, unknown>> = {}): NotificationPrefs {
  return {
    quiet_hours_start: '22:00',
    quiet_hours_end: '07:00',
    daily_cap: 3,
    push_enabled: true,
    ...over,
  } as NotificationPrefs;
}

function sessionRow(over: Partial<GroupSessionRow> = {}): GroupSessionRow {
  return {
    session_id: 's1',
    message_id: 'm1',
    starts_at: localIso(2026, 9, 6, 16, 0),
    duration_min: 120,
    location: 'Library, third floor',
    status: 'confirmed',
    proposed_by: 'me-0000-0000',
    proposer_name: 'Ada',
    members_counted: 3,
    yes_count: 3,
    no_count: 0,
    maybe_count: 0,
    confirm_threshold: 3,
    my_response: 'yes',
    ...over,
  };
}

/**
 * The reminder arm on its own. Spreading `subjectFor(...)` cannot work — its
 * declared type is the whole union, so `{ ...it, location: null }` is a union of
 * seven half-built arms and none of them typecheck.
 */
type ReminderSubject = Extract<NotificationSubject, { kind: 'session_reminder' }>;

function reminderSubject(over: Partial<ReminderSubject> = {}): ReminderSubject {
  return {
    kind: 'session_reminder',
    groupName: 'Physics 101',
    startsAt: localIso(2026, 9, 6, 16, 0),
    durationMin: 120,
    location: 'Library, third floor',
    ...over,
  };
}

/** One subject per kind, so the copy tests can sweep the whole union. */
function subjectFor(kind: NotificationKind): NotificationSubject {
  switch (kind) {
    case 'session_reminder':
      return reminderSubject();
    case 'session_proposed':
      return {
        kind,
        groupName: 'Physics 101',
        proposerName: 'Ada',
        startsAt: localIso(2026, 9, 6, 16, 0),
        durationMin: 120,
      };
    case 'session_confirmed':
      return {
        kind,
        groupName: 'Physics 101',
        startsAt: localIso(2026, 9, 6, 16, 0),
        durationMin: 120,
        location: null,
      };
    case 'session_cancelled':
      return {
        kind,
        groupName: 'Physics 101',
        startsAt: localIso(2026, 9, 6, 16, 0),
        durationMin: 120,
      };
    case 'message_activity':
      return { kind, groupName: 'Physics 101', count: 3, senderNames: ['Ada', 'Ben'] };
    case 'file_shared':
      return { kind, groupName: 'Physics 101', sharerName: 'Ada', fileName: 'week4.pdf' };
    case 'invitation':
      return { kind, groupName: 'Physics 101', inviterName: 'Ada' };
  }
}

describe('the kind tables', () => {
  it('covers every kind', () => {
    for (const kind of ALL_KINDS) {
      expect(NOTIFICATION_KIND_LABEL[kind]).toBeTruthy();
      expect(typeof NOTIFICATION_URGENT[kind]).toBe('boolean');
      expect(typeof NOTIFICATION_LOCAL[kind]).toBe('boolean');
    }
  });

  it('marks only the study-time reminder as device-scheduled', () => {
    const local = ALL_KINDS.filter((k) => NOTIFICATION_LOCAL[k]);
    expect(local).toEqual(['session_reminder']);
  });

  it('exempts only the reminder and a cancellation from the daily cap', () => {
    const urgent = ALL_KINDS.filter((k) => NOTIFICATION_URGENT[k]);
    expect(urgent.sort()).toEqual(['session_cancelled', 'session_reminder']);
  });
});

describe('parseClockMinutes', () => {
  it('reads a 24-hour clock', () => {
    expect(parseClockMinutes('22:00')).toBe(22 * 60);
    expect(parseClockMinutes('07:00')).toBe(7 * 60);
    expect(parseClockMinutes('7:05')).toBe(7 * 60 + 5);
    expect(parseClockMinutes('00:00')).toBe(0);
    expect(parseClockMinutes('23:59')).toBe(23 * 60 + 59);
    expect(parseClockMinutes('  08:30  ')).toBe(8 * 60 + 30);
  });

  it('rejects anything else, because jsonb has no CHECK behind it', () => {
    expect(parseClockMinutes('24:00')).toBeNull();
    expect(parseClockMinutes('22:60')).toBeNull();
    expect(parseClockMinutes('2200')).toBeNull();
    expect(parseClockMinutes('10:5')).toBeNull();
    expect(parseClockMinutes('half ten')).toBeNull();
    expect(parseClockMinutes('')).toBeNull();
    expect(parseClockMinutes(null)).toBeNull();
    expect(parseClockMinutes(undefined)).toBeNull();
    expect(parseClockMinutes(2200 as unknown as string)).toBeNull();
  });
});

describe('isWithinQuietHours', () => {
  it('handles the default window, which WRAPS midnight', () => {
    const p = prefs({ quiet_hours_start: '22:00', quiet_hours_end: '07:00' });
    expect(isWithinQuietHours(p, at(22, 0))).toBe(true); // start is inclusive
    expect(isWithinQuietHours(p, at(23, 30))).toBe(true);
    expect(isWithinQuietHours(p, at(0, 0))).toBe(true);
    expect(isWithinQuietHours(p, at(3, 15))).toBe(true);
    expect(isWithinQuietHours(p, at(6, 59))).toBe(true);
    expect(isWithinQuietHours(p, at(7, 0))).toBe(false); // end is exclusive
    expect(isWithinQuietHours(p, at(12, 0))).toBe(false);
    expect(isWithinQuietHours(p, at(21, 59))).toBe(false);
  });

  it('handles a window inside one day', () => {
    const p = prefs({ quiet_hours_start: '13:00', quiet_hours_end: '14:00' });
    expect(isWithinQuietHours(p, at(13, 0))).toBe(true);
    expect(isWithinQuietHours(p, at(13, 59))).toBe(true);
    expect(isWithinQuietHours(p, at(14, 0))).toBe(false);
    expect(isWithinQuietHours(p, at(12, 59))).toBe(false);
    expect(isWithinQuietHours(p, at(23, 0))).toBe(false);
  });

  it('fails open, so a bad pref cannot silence the whole app', () => {
    expect(isWithinQuietHours(prefs({ quiet_hours_start: '25:00' }), at(23))).toBe(false);
    expect(isWithinQuietHours(prefs({ quiet_hours_end: null }), at(23))).toBe(false);
    expect(isWithinQuietHours(prefs({ quiet_hours_start: undefined }), at(23))).toBe(false);
    expect(isWithinQuietHours(prefs({ quiet_hours_end: 'seven' }), at(23))).toBe(false);
  });

  it('reads a zero-length window as off, not as silent all day', () => {
    const p = prefs({ quiet_hours_start: '08:00', quiet_hours_end: '08:00' });
    expect(isWithinQuietHours(p, at(8, 0))).toBe(false);
    expect(isWithinQuietHours(p, at(20, 0))).toBe(false);
  });
});

describe('minutesUntilQuietHoursEnd', () => {
  it('is zero when quiet hours are not in force', () => {
    expect(minutesUntilQuietHoursEnd(prefs(), at(12, 0))).toBe(0);
    expect(minutesUntilQuietHoursEnd(prefs({ quiet_hours_start: 'x' }), at(23, 0))).toBe(0);
  });

  it('counts across midnight from either side of it', () => {
    const p = prefs({ quiet_hours_start: '22:00', quiet_hours_end: '07:00' });
    expect(minutesUntilQuietHoursEnd(p, at(23, 0))).toBe(8 * 60);
    expect(minutesUntilQuietHoursEnd(p, at(22, 30))).toBe(8 * 60 + 30);
    expect(minutesUntilQuietHoursEnd(p, at(2, 0))).toBe(5 * 60);
    expect(minutesUntilQuietHoursEnd(p, at(6, 59))).toBe(1);
  });

  it('counts inside a same-day window', () => {
    const p = prefs({ quiet_hours_start: '13:00', quiet_hours_end: '14:00' });
    expect(minutesUntilQuietHoursEnd(p, at(13, 20))).toBe(40);
  });
});

describe('isDailyCapReached', () => {
  it('counts deliveries against the cap', () => {
    expect(isDailyCapReached(prefs({ daily_cap: 3 }), 0)).toBe(false);
    expect(isDailyCapReached(prefs({ daily_cap: 3 }), 2)).toBe(false);
    expect(isDailyCapReached(prefs({ daily_cap: 3 }), 3)).toBe(true);
    expect(isDailyCapReached(prefs({ daily_cap: 3 }), 9)).toBe(true);
  });

  it('treats a cap of zero as a real setting, not as unset', () => {
    expect(isDailyCapReached(prefs({ daily_cap: 0 }), 0)).toBe(true);
  });

  it('fails open on a cap that is not a number', () => {
    expect(isDailyCapReached(prefs({ daily_cap: -1 }), 99)).toBe(false);
    expect(isDailyCapReached(prefs({ daily_cap: null }), 99)).toBe(false);
    expect(isDailyCapReached(prefs({ daily_cap: 'three' }), 99)).toBe(false);
    expect(isDailyCapReached(prefs({ daily_cap: Number.NaN }), 99)).toBe(false);
  });
});

/** Noon and nothing delivered yet, so each test only states what it changes. */
function decide(over: Partial<Parameters<typeof shouldNotify>[0]> = {}) {
  return shouldNotify({
    kind: 'message_activity',
    prefs: prefs(),
    deliveredNonUrgentToday: 0,
    at: at(12, 0),
    ...over,
  });
}

describe('shouldNotify', () => {
  it('delivers when nothing is in the way', () => {
    expect(decide()).toEqual({ deliver: true, withheld: null, retryInMinutes: 0 });
  });

  it('treats push_enabled as a master switch, urgent included', () => {
    for (const kind of ALL_KINDS) {
      expect(decide({ kind, prefs: prefs({ push_enabled: false }) })).toEqual({
        deliver: false,
        withheld: 'push_disabled',
        retryInMinutes: 0,
      });
    }
  });

  it('honours a per-kind switch, and reads an absent key as on', () => {
    expect(decide({ kindEnabled: { message_activity: false } }).withheld).toBe('kind_disabled');
    expect(decide({ kindEnabled: { file_shared: false } }).deliver).toBe(true);
    expect(decide({ kindEnabled: {} }).deliver).toBe(true);
    expect(decide({ kindEnabled: undefined }).deliver).toBe(true);
  });

  it('checks the master switch before the per-kind one', () => {
    expect(
      decide({
        prefs: prefs({ push_enabled: false }),
        kindEnabled: { message_activity: false },
      }).withheld
    ).toBe('push_disabled');
  });
});

describe('shouldNotify — quiet hours', () => {
  it('withholds and says when to try again', () => {
    expect(decide({ at: at(23, 0) })).toEqual({
      deliver: false,
      withheld: 'quiet_hours',
      retryInMinutes: 8 * 60,
    });
  });

  it('lets a study-time reminder through, because the student agreed to it', () => {
    expect(decide({ kind: 'session_reminder', at: at(23, 0) }).deliver).toBe(true);
    expect(decide({ kind: 'session_reminder', at: at(3, 0) }).deliver).toBe(true);
  });

  it('still holds a cancellation until morning, urgent though it is', () => {
    const out = decide({ kind: 'session_cancelled', at: at(23, 0) });
    expect(out.deliver).toBe(false);
    expect(out.withheld).toBe('quiet_hours');
  });

  it('withholds every other kind', () => {
    for (const kind of ALL_KINDS) {
      if (kind === 'session_reminder') continue;
      expect(decide({ kind, at: at(2, 0) }).withheld).toBe('quiet_hours');
    }
  });

  it('is checked after the per-kind switch, so the reason names the switch', () => {
    expect(
      decide({ at: at(23, 0), kindEnabled: { message_activity: false } }).withheld
    ).toBe('kind_disabled');
  });
});

describe('shouldNotify — the daily cap', () => {
  it('withholds a non-urgent notification once the allowance is spent', () => {
    expect(decide({ deliveredNonUrgentToday: 2 }).deliver).toBe(true);
    expect(decide({ deliveredNonUrgentToday: 3 })).toEqual({
      deliver: false,
      withheld: 'daily_cap',
      retryInMinutes: 0,
    });
  });

  it('exempts exactly the urgent kinds, per 0001', () => {
    for (const kind of ALL_KINDS) {
      const out = decide({ kind, deliveredNonUrgentToday: 99 });
      expect(out.deliver).toBe(NOTIFICATION_URGENT[kind]);
    }
  });

  it('does not offer a retry, because the cap resets on its own day boundary', () => {
    expect(decide({ deliveredNonUrgentToday: 3 }).retryInMinutes).toBe(0);
  });
});

describe('reminderFireTime', () => {
  it('lands the owner\'s thirty minutes before the start', () => {
    const fire = reminderFireTime(localIso(2026, 9, 6, 16, 0));
    expect(fire?.getHours()).toBe(15);
    expect(fire?.getMinutes()).toBe(30);
  });

  it('takes a custom lead, and clamps a negative one to the start itself', () => {
    expect(reminderFireTime(localIso(2026, 9, 6, 16, 0), 60)?.getHours()).toBe(15);
    expect(reminderFireTime(localIso(2026, 9, 6, 16, 0), 60)?.getMinutes()).toBe(0);
    expect(reminderFireTime(localIso(2026, 9, 6, 16, 0), -30)?.getHours()).toBe(16);
  });

  it('returns a time in the past rather than null, so the caller can tell why', () => {
    const fire = reminderFireTime(localIso(2020, 1, 1, 9, 0));
    expect(fire).not.toBeNull();
    expect(fire!.getTime()).toBeLessThan(Date.now());
  });

  it('is null only when the start is unparseable', () => {
    expect(reminderFireTime('not a date')).toBeNull();
    expect(reminderFireTime('')).toBeNull();
  });
});

describe('reminderId', () => {
  it('is derived from the session alone, so nothing has to be stored', () => {
    expect(reminderId('abc')).toBe(`${REMINDER_ID_PREFIX}abc`);
    expect(reminderId('abc')).toBe(reminderId('abc'));
    expect(reminderId('abc')).not.toBe(reminderId('abd'));
  });

  it('recognises its own ids and nobody else\'s', () => {
    expect(isReminderId(reminderId('s1'))).toBe(true);
    expect(isReminderId('some-other-feature:42')).toBe(false);
    expect(isReminderId('')).toBe(false);
    expect(isReminderId(undefined as unknown as string)).toBe(false);
  });
});

describe('shouldScheduleReminder', () => {
  const now = new Date(2026, 8, 6, 9, 0, 0); // 9am, session at 4pm

  it('schedules a confirmed session that is far enough ahead', () => {
    expect(shouldScheduleReminder(sessionRow(), now)).toBe(true);
  });

  it('schedules only confirmed sessions', () => {
    for (const status of ALL_STATUSES) {
      expect(shouldScheduleReminder(sessionRow({ status }), now)).toBe(status === 'confirmed');
    }
  });

  it('skips a student who said no, but not one who is undecided', () => {
    for (const my_response of ALL_RESPONSES) {
      expect(shouldScheduleReminder(sessionRow({ my_response }), now)).toBe(my_response !== 'no');
    }
    expect(shouldScheduleReminder(sessionRow({ my_response: null }), now)).toBe(true);
  });

  it('refuses an alarm that would land too soon to be useful', () => {
    const soon = new Date(2026, 8, 6, 15, 30, 0); // exactly the fire time
    expect(shouldScheduleReminder(sessionRow(), soon)).toBe(false);
    const boundary = new Date(soon.getTime() - REMINDER_MIN_LEAD_MS);
    expect(shouldScheduleReminder(sessionRow(), boundary)).toBe(true);
    const inside = new Date(soon.getTime() - REMINDER_MIN_LEAD_MS + 1);
    expect(shouldScheduleReminder(sessionRow(), inside)).toBe(false);
  });

  it('needs no separate past check — a started session fails the lead test', () => {
    const after = new Date(2026, 8, 6, 17, 0, 0);
    expect(shouldScheduleReminder(sessionRow(), after)).toBe(false);
    const wayAfter = new Date(2027, 0, 1);
    expect(shouldScheduleReminder(sessionRow(), wayAfter)).toBe(false);
  });

  it('refuses an unparseable start', () => {
    expect(shouldScheduleReminder(sessionRow({ starts_at: 'soon' }), now)).toBe(false);
  });

  it('takes the lead time into account', () => {
    const row = sessionRow({ starts_at: localIso(2026, 9, 6, 9, 20) });
    expect(shouldScheduleReminder(row, now, 30)).toBe(false); // 8:50 — already gone
    expect(shouldScheduleReminder(row, now, 15)).toBe(true); // 9:05 — still placeable
  });
});

describe('notificationContent', () => {
  const now = new Date(2026, 8, 5, 9, 0, 0); // the day before the session

  it('gives every kind words', () => {
    for (const kind of ALL_KINDS) {
      const { title, body } = notificationContent(subjectFor(kind), now);
      expect(title.length).toBeGreaterThan(0);
      expect(body.length).toBeGreaterThan(0);
      expect(title).not.toMatch(/undefined|NaN/);
      expect(body).not.toMatch(/undefined|NaN/);
    }
  });

  it('names the lead time in the reminder title', () => {
    expect(notificationContent(reminderSubject(), now).title).toBe('Study time in 30 minutes');
    expect(notificationContent(reminderSubject({ leadMin: 60 }), now).title).toBe(
      'Study time in 1 hour'
    );
  });

  it('puts the group, the clock time, the length and the place in the reminder body', () => {
    const body = notificationContent(reminderSubject(), now).body;
    expect(body).toBe('Physics 101 at 4pm · 2 hours · Library, third floor');
  });

  it('drops the location when there is not one', () => {
    expect(notificationContent(reminderSubject({ location: null }), now).body).toBe(
      'Physics 101 at 4pm · 2 hours'
    );
    expect(notificationContent(reminderSubject({ location: '   ' }), now).body).toBe(
      'Physics 101 at 4pm · 2 hours'
    );
  });

  it('says which day a session is on, relative to now', () => {
    expect(notificationContent(subjectFor('session_confirmed'), now).body).toBe(
      'Physics 101 · Tomorrow, 4pm – 6pm'
    );
    const sameDay = new Date(2026, 8, 6, 9, 0, 0);
    expect(notificationContent(subjectFor('session_cancelled'), sameDay).body).toBe(
      'Physics 101 · Today, 4pm – 6pm'
    );
  });

  it('names the proposer and asks for an answer', () => {
    const { title, body } = notificationContent(subjectFor('session_proposed'), now);
    expect(title).toBe('New study time in Physics 101');
    expect(body).toBe('Ada suggested Tomorrow, 4pm – 6pm. Say yes or no.');
  });

  it('counts and attributes a chat digest the way the chat cards do', () => {
    const base = { kind: 'message_activity', groupName: 'Physics 101' } as const;
    expect(notificationContent({ ...base, count: 1, senderNames: ['Ada'] }, now)).toEqual({
      title: 'Physics 101',
      body: '1 new message from Ada',
    });
    expect(notificationContent({ ...base, count: 4, senderNames: ['Ada', 'Ben'] }, now).body).toBe(
      '4 new messages from Ada and Ben'
    );
    expect(
      notificationContent({ ...base, count: 9, senderNames: ['Ada', 'Ben', 'Cleo'] }, now).body
    ).toBe('9 new messages from Ada and 2 others');
    expect(notificationContent({ ...base, count: 2, senderNames: [] }, now).body).toBe(
      '2 new messages'
    );
  });

  it('names the file and the person who shared it', () => {
    const { title, body } = notificationContent(subjectFor('file_shared'), now);
    expect(title).toBe('New file in Physics 101');
    expect(body).toBe('Ada shared week4.pdf');
  });

  it('names the group and the inviter', () => {
    const { title, body } = notificationContent(subjectFor('invitation'), now);
    expect(title).toBe('Invitation to Physics 101');
    expect(body).toBe('Ada invited you to join.');
  });

  it('never renders a blank name into a banner', () => {
    expect(
      notificationContent(
        { kind: 'file_shared', groupName: '   ', sharerName: '', fileName: '' },
        now
      )
    ).toEqual({ title: 'New file in Your study group', body: 'A group member shared a file' });
  });
});

describe('reminderContent', () => {
  it('says the same thing as the subject form, from a row', () => {
    const now = new Date(2026, 8, 5, 9, 0, 0);
    expect(reminderContent(sessionRow(), 'Physics 101')).toEqual(
      notificationContent(subjectFor('session_reminder'), now)
    );
  });

  it('carries a custom lead through to the title', () => {
    expect(reminderContent(sessionRow(), 'Physics 101', 45).title).toBe('Study time in 45 minutes');
  });
});

describe('planReminders', () => {
  const now = new Date(2026, 8, 6, 9, 0, 0);

  it('plans one alarm per deserving session, soonest first', () => {
    const plan = planReminders({
      sessions: [
        sessionRow({ session_id: 'late', starts_at: localIso(2026, 9, 6, 18, 0) }),
        sessionRow({ session_id: 'early', starts_at: localIso(2026, 9, 6, 12, 0) }),
      ],
      groupName: 'Physics 101',
      now,
    });
    expect(plan.map((p) => p.sessionId)).toEqual(['early', 'late']);
    expect(plan[0].id).toBe(reminderId('early'));
    expect(plan[0].fireAt.getHours()).toBe(11);
    expect(plan[0].fireAt.getMinutes()).toBe(30);
    expect(plan[0].title).toBe('Study time in 30 minutes');
    expect(plan[0].body).toContain('Physics 101');
  });

  it('leaves out everything shouldScheduleReminder refuses', () => {
    const plan = planReminders({
      sessions: [
        sessionRow({ session_id: 'ok' }),
        sessionRow({ session_id: 'proposed', status: 'proposed' }),
        sessionRow({ session_id: 'cancelled', status: 'cancelled' }),
        sessionRow({ session_id: 'declined', my_response: 'no' }),
        sessionRow({ session_id: 'past', starts_at: localIso(2026, 9, 5, 16, 0) }),
        sessionRow({ session_id: 'broken', starts_at: 'tomorrow-ish' }),
      ],
      groupName: 'Physics 101',
      now,
    });
    expect(plan.map((p) => p.sessionId)).toEqual(['ok']);
  });

  it('plans nothing from nothing', () => {
    expect(planReminders({ sessions: [], groupName: 'Physics 101', now })).toEqual([]);
  });

  it('respects a custom lead time', () => {
    const plan = planReminders({
      sessions: [sessionRow()],
      groupName: 'Physics 101',
      now,
      leadMin: 60,
    });
    expect(plan[0].fireAt.getHours()).toBe(15);
    expect(plan[0].fireAt.getMinutes()).toBe(0);
    expect(plan[0].title).toBe('Study time in 1 hour');
  });
});

function plannedFor(sessionId: string, fireAt: Date): PlannedReminder {
  return {
    id: reminderId(sessionId),
    sessionId,
    fireAt,
    title: 'Study time in 30 minutes',
    body: 'Physics 101 at 4pm · 2 hours',
  };
}

function pendingFor(sessionId: string, fireAt: Date | null): ScheduledReminder {
  return { id: reminderId(sessionId), fireAt };
}

describe('diffReminders', () => {
  const soon = new Date(2026, 8, 6, 15, 30, 0);
  const later = new Date(2026, 8, 7, 15, 30, 0);

  it('schedules everything when the device holds nothing', () => {
    const plan = [plannedFor('s1', soon), plannedFor('s2', later)];
    expect(diffReminders(plan, [])).toEqual({ toSchedule: plan, toCancel: [] });
  });

  it('does nothing when the device already matches the plan', () => {
    const plan = [plannedFor('s1', soon)];
    expect(diffReminders(plan, [pendingFor('s1', soon)])).toEqual({
      toSchedule: [],
      toCancel: [],
    });
  });

  it('cancels and re-places an alarm whose session moved', () => {
    const plan = [plannedFor('s1', later)];
    const diff = diffReminders(plan, [pendingFor('s1', soon)]);
    expect(diff.toCancel).toEqual([reminderId('s1')]);
    expect(diff.toSchedule).toEqual(plan);
  });

  it('cancels an alarm the plan no longer wants', () => {
    const diff = diffReminders([], [pendingFor('gone', soon)]);
    expect(diff).toEqual({ toSchedule: [], toCancel: [reminderId('gone')] });
  });

  it('never touches a notification some other feature scheduled', () => {
    const diff = diffReminders([], [{ id: 'studysync:something-else:1', fireAt: soon }]);
    expect(diff).toEqual({ toSchedule: [], toCancel: [] });
  });

  it('treats an unreadable trigger as stale, because a wrong alarm is worse', () => {
    const plan = [plannedFor('s1', soon)];
    const diff = diffReminders(plan, [pendingFor('s1', null)]);
    expect(diff.toCancel).toEqual([reminderId('s1')]);
    expect(diff.toSchedule).toEqual(plan);
  });

  it('ignores the second of slop the OS introduces', () => {
    const plan = [plannedFor('s1', soon)];
    const within = new Date(soon.getTime() + REMINDER_FIRE_TOLERANCE_MS);
    expect(diffReminders(plan, [pendingFor('s1', within)]).toSchedule).toEqual([]);
    const beyond = new Date(soon.getTime() + REMINDER_FIRE_TOLERANCE_MS + 1);
    expect(diffReminders(plan, [pendingFor('s1', beyond)]).toSchedule).toEqual(plan);
  });

  it('keeps the soonest alarms when the plan exceeds what iOS will hold', () => {
    const plan: PlannedReminder[] = [];
    for (let i = 0; i < MAX_PENDING_REMINDERS + 5; i += 1) {
      plan.push(plannedFor(`s${i}`, new Date(soon.getTime() + i * 3_600_000)));
    }
    const diff = diffReminders([...plan].reverse(), []);
    expect(diff.toSchedule).toHaveLength(MAX_PENDING_REMINDERS);
    expect(diff.toSchedule[0].sessionId).toBe('s0');
    expect(diff.toSchedule.map((p) => p.sessionId)).not.toContain(
      `s${MAX_PENDING_REMINDERS + 4}`
    );
  });

  it('cancels an alarm crowded out of the plan by nearer ones', () => {
    const plan: PlannedReminder[] = [];
    for (let i = 0; i < MAX_PENDING_REMINDERS; i += 1) {
      plan.push(plannedFor(`s${i}`, new Date(soon.getTime() + i * 3_600_000)));
    }
    const far = new Date(soon.getTime() + 10_000 * 3_600_000);
    const diff = diffReminders([...plan, plannedFor('far', far)], [pendingFor('far', far)]);
    expect(diff.toCancel).toEqual([reminderId('far')]);
  });

  it('plans a session only once even if the row arrives twice', () => {
    const diff = diffReminders([plannedFor('s1', soon), plannedFor('s1', soon)], []);
    expect(diff.toSchedule).toHaveLength(1);
  });
});

describe('notificationDedupeKey', () => {
  it('names one delivery per subject per kind', () => {
    expect(notificationDedupeKey({ kind: 'file_shared', subjectId: 'mat1' })).toBe(
      'file_shared:mat1'
    );
    expect(notificationDedupeKey({ kind: 'session_confirmed', subjectId: 's1' })).toBe(
      'session_confirmed:s1'
    );
  });

  it('separates the same subject under different kinds', () => {
    expect(notificationDedupeKey({ kind: 'session_proposed', subjectId: 's1' })).not.toBe(
      notificationDedupeKey({ kind: 'session_cancelled', subjectId: 's1' })
    );
  });

  it('buckets a chat digest by the watermark the run read, so a retry collides', () => {
    const first = notificationDedupeKey({
      kind: 'message_activity',
      subjectId: 'g1',
      bucket: '2026-09-05T10:00:00.000Z',
    });
    expect(first).toBe('message_activity:g1:2026-09-05T10:00:00.000Z');
    expect(
      notificationDedupeKey({
        kind: 'message_activity',
        subjectId: 'g1',
        bucket: '2026-09-05T10:00:00.000Z',
      })
    ).toBe(first);
    expect(
      notificationDedupeKey({
        kind: 'message_activity',
        subjectId: 'g1',
        bucket: '2026-09-05T11:00:00.000Z',
      })
    ).not.toBe(first);
  });

  it('leaves off an empty bucket rather than trailing a colon', () => {
    expect(notificationDedupeKey({ kind: 'invitation', subjectId: 'i1', bucket: null })).toBe(
      'invitation:i1'
    );
    expect(notificationDedupeKey({ kind: 'invitation', subjectId: 'i1', bucket: '  ' })).toBe(
      'invitation:i1'
    );
  });
});
