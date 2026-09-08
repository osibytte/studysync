import {
  DAILY_CAP_CHOICES,
  NOTIFICATION_PREF_KEY,
  NOTIFICATION_SWITCH_ORDER,
  QUIET_HOUR_CHOICES,
  applyAllNotificationsRead,
  applyNotificationRead,
  buildInbox,
  compareNotificationsNewestFirst,
  countUnreadNotifications,
  dailyCapLabel,
  isKindEnabled,
  kindEnabledFromPrefs,
  nextInboxCursor,
  notificationRoute,
  notificationSwitchRows,
  notificationWhenLabel,
  quietHoursEnabled,
  quietHoursLabel,
  upsertNotifications,
  withNotificationDefaults,
} from '../notificationRules';
import {
  DEFAULT_NOTIFICATION_PREFS,
  type Notification,
  type NotificationPrefs,
  type NotificationSwitchKey,
  type SentNotificationKind,
} from '@/types/database';

/**
 * Step 5's two screens, pinned at the rules layer.
 *
 * A separate suite from `notificationRules.test.ts` because it asserts different
 * things about the same module: that file covers what gets SENT (quiet hours, the
 * cap, the alarm), this one covers what the student SEES and CHANGES — the prefs
 * switches and the inbox list. Neither screen can be rendered by this project's
 * test setup (HANDOFF §6: no renderer is installed), so every rule either lives in
 * a pure function tested here or is untested. That is the whole reason `buildInbox`,
 * `notificationRoute` and the three list reducers are functions at all rather than
 * inline JSX.
 *
 * Local wall-clock instants throughout, same as the sibling suite: day headers are
 * cut on the student's own clock, so a hardcoded 'Z' would assert a different day in
 * Lagos than in CI.
 */
function localIso(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): string {
  return new Date(y, mo - 1, d, h, mi, s).toISOString();
}

/**
 * `unknown` values on purpose, for the same reason as the sibling suite:
 * `notification_prefs` is jsonb with no CHECK behind it, so a row genuinely can
 * hold `null` or `'25:00'` where the interface promises otherwise.
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

/** Sequential ids, so ties on `created_at` are decided by something legible. */
function note(over: Partial<Notification> = {}): Notification {
  return {
    notification_id: 'n1',
    user_id: 'me-0000-0000',
    group_id: 'g1',
    kind: 'session_confirmed',
    title: 'Thursday 4pm is confirmed',
    body: 'BIO 201 · Library, third floor',
    urgent: false,
    dedupe_key: 'session_confirmed:s1',
    created_at: localIso(2026, 9, 5, 16, 5),
    read_at: null,
    ...over,
  };
}

/**
 * Every kind a row in `notifications` can actually hold — the 11 of
 * `SentNotificationKind`, which is `NotificationKind` minus the local alarm.
 *
 * Listed out rather than filtered, so adding a union member fails here too. The
 * alarm is absent because it is never a row: it is scheduled on the device and
 * `0019`'s CHECK rejects it, which is why `notificationRoute` needs no arm for it.
 */
const SENT_KINDS: SentNotificationKind[] = [
  'session_proposed',
  'session_confirmed',
  'session_cancelled',
  'message_activity',
  'file_shared',
  'invitation',
  'group_matched',
  'session_needs_one_yes',
  'group_free_slot',
  'group_quiet',
  'invitation_unanswered',
];

const ALL_SWITCHES: NotificationSwitchKey[] = [
  'notify_chat',
  'notify_files',
  'notify_sessions',
  'notify_invitations',
  'nudge_needs_one_yes',
  'nudge_free_slot',
  'nudge_group_quiet',
  'nudge_unanswered_invitation',
];

// ---------------------------------------------------------------------------
// Prefs: the eight switches
// ---------------------------------------------------------------------------

describe('withNotificationDefaults', () => {
  it('fills a row written before Stage 5', () => {
    // The realistic input: 0001's four keys and nothing else.
    expect(withNotificationDefaults({ daily_cap: 1 })).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      daily_cap: 1,
    });
  });

  it('survives null and an empty object', () => {
    // A hand-edited dashboard row, and a column somehow cleared.
    expect(withNotificationDefaults(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(withNotificationDefaults(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(withNotificationDefaults({})).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it('leaves the eight per-kind keys absent', () => {
    // Not defaulted to `true`, deliberately: saving the screen without touching a
    // switch must not write eight keys that mean exactly what their absence does.
    const filled = withNotificationDefaults(null);
    for (const key of ALL_SWITCHES) {
      expect(key in filled).toBe(false);
    }
  });

  it('does not mutate or alias its input', () => {
    const input: Partial<NotificationPrefs> = { daily_cap: 10 };
    const out = withNotificationDefaults(input);
    out.daily_cap = 1;
    expect(input.daily_cap).toBe(10);
    expect(Object.keys(input)).toEqual(['daily_cap']);
  });
});

describe('isKindEnabled', () => {
  it('reads an absent key as on', () => {
    // The normal case, not an edge one — no account has these keys until the
    // student opens the prefs screen and changes something.
    for (const kind of SENT_KINDS) {
      expect(isKindEnabled(prefs(), kind)).toBe(true);
    }
  });

  it('silences only on an explicit false', () => {
    expect(isKindEnabled(prefs({ notify_chat: false }), 'message_activity')).toBe(false);
    expect(isKindEnabled(prefs({ notify_chat: true }), 'message_activity')).toBe(true);
    // Anything that is not `false` is on. A jsonb column can hold these.
    expect(isKindEnabled(prefs({ notify_chat: null }), 'message_activity')).toBe(true);
    expect(isKindEnabled(prefs({ notify_chat: 0 }), 'message_activity')).toBe(true);
  });

  it('keeps the alarm and being matched on whatever the prefs say', () => {
    // Neither has a switch, so there is no key to set — but a client that invented
    // one anyway must not be able to silence either through this function. The two
    // invented keys are spread in past the type on purpose: that is exactly the
    // shape a jsonb column can hold and the interface cannot describe.
    const hostile = {
      ...prefs({
        notify_sessions: false,
        notify_chat: false,
        notify_files: false,
        notify_invitations: false,
      }),
      session_reminder: false,
      group_matched: false,
    } as NotificationPrefs;
    expect(isKindEnabled(hostile, 'session_reminder')).toBe(true);
    expect(isKindEnabled(hostile, 'group_matched')).toBe(true);
  });

  it('silences every kind a switch governs, and only those', () => {
    for (const key of ALL_SWITCHES) {
      const off = prefs({ [key]: false });
      for (const kind of SENT_KINDS) {
        const governed = NOTIFICATION_PREF_KEY[kind] === key;
        expect(isKindEnabled(off, kind)).toBe(!governed);
      }
    }
  });
});

describe('kindEnabledFromPrefs', () => {
  it('answers for every kind, so the sender never reads undefined', () => {
    const map = kindEnabledFromPrefs(prefs());
    for (const kind of SENT_KINDS) {
      expect(map[kind]).toBe(true);
    }
    // The alarm is in the map too: `shouldNotify` is given the whole set.
    expect(map.session_reminder).toBe(true);
  });

  it('agrees with isKindEnabled key by key', () => {
    // One meaning, two callers — the prefs screen reads it the way the sender does.
    const p = prefs({ notify_chat: false, nudge_group_quiet: false });
    const map = kindEnabledFromPrefs(p);
    for (const kind of SENT_KINDS) {
      expect(map[kind]).toBe(isKindEnabled(p, kind));
    }
    expect(map.message_activity).toBe(false);
    expect(map.group_quiet).toBe(false);
    expect(map.session_confirmed).toBe(true);
  });
});

describe('notificationSwitchRows', () => {
  it('returns one row per switch, in screen order', () => {
    const rows = notificationSwitchRows(prefs());
    expect(rows.map((r) => r.key)).toEqual([...NOTIFICATION_SWITCH_ORDER]);
  });

  it('gives every row words and at least one kind to silence', () => {
    // A switch that governs nothing is a control that does nothing when tapped.
    for (const row of notificationSwitchRows(prefs())) {
      expect(row.label).toBeTruthy();
      expect(row.hint).toBeTruthy();
      expect(row.kinds.length).toBeGreaterThan(0);
      for (const kind of row.kinds) {
        expect(NOTIFICATION_PREF_KEY[kind]).toBe(row.key);
      }
    }
  });

  it('shows an untouched switch as on and an explicit false as off', () => {
    const rows = notificationSwitchRows(prefs({ notify_files: false }));
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.enabled]));
    expect(byKey.notify_files).toBe(false);
    expect(byKey.notify_chat).toBe(true);
  });

  it('separates the four nudges from the four notifications', () => {
    // The screen renders them under different headings, and the split is a product
    // decision (a nudge is engagement, the rest is information) rather than a
    // naming coincidence — so it is asserted, not inferred from the prefix.
    const rows = notificationSwitchRows(prefs());
    expect(rows.filter((r) => r.nudge).map((r) => r.key)).toEqual([
      'nudge_needs_one_yes',
      'nudge_free_slot',
      'nudge_group_quiet',
      'nudge_unanswered_invitation',
    ]);
    expect(rows.filter((r) => !r.nudge)).toHaveLength(4);
  });

  it('mentions the cooldown wherever there is one', () => {
    // "at most once a week" is the difference between a setting a student trusts
    // and one they switch off to find out what it does.
    const rows = notificationSwitchRows(prefs());
    const hint = (key: NotificationSwitchKey) =>
      rows.find((r) => r.key === key)?.hint.toLowerCase() ?? '';
    expect(hint('nudge_free_slot')).toContain('once a week');
    expect(hint('nudge_group_quiet')).toContain('once a fortnight');
  });
});

describe('the daily cap chips', () => {
  it('offers zero, and labels it as a setting rather than an off switch', () => {
    // `isDailyCapReached` reads 0 as "urgent only", which is legitimate — but a
    // chip reading "0 a day" gets picked by somebody who then wonders why the app
    // went quiet, so the label has to say what it does.
    expect(DAILY_CAP_CHOICES).toContain(0);
    expect(dailyCapLabel(0)).toBe('Urgent only');
  });

  it('labels every choice, and does not say "1 a day" in the plural', () => {
    for (const cap of DAILY_CAP_CHOICES) {
      expect(dailyCapLabel(cap)).toBeTruthy();
    }
    expect(dailyCapLabel(1)).toBe('1 a day');
    expect(dailyCapLabel(3)).toBe('3 a day');
  });

  it('reads junk as urgent-only rather than throwing', () => {
    // jsonb again: the column can hold a negative number or NaN, and the chip row
    // still has to render. Nothing selected is a fair outcome; a crash is not.
    expect(dailyCapLabel(-1)).toBe('Urgent only');
    expect(dailyCapLabel(Number.NaN)).toBe('Urgent only');
    expect(dailyCapLabel(Number.POSITIVE_INFINITY)).toBe('Urgent only');
  });

  it('rises without repeating, so no two chips mean the same thing', () => {
    const sorted = [...DAILY_CAP_CHOICES].sort((a, b) => a - b);
    expect([...DAILY_CAP_CHOICES]).toEqual(sorted);
    expect(new Set(DAILY_CAP_CHOICES).size).toBe(DAILY_CAP_CHOICES.length);
  });
});

describe('the quiet hours controls', () => {
  it('offers all 24 hours, zero-padded', () => {
    expect(QUIET_HOUR_CHOICES).toHaveLength(24);
    expect(QUIET_HOUR_CHOICES[0]).toBe('00:00');
    expect(QUIET_HOUR_CHOICES[7]).toBe('07:00');
    expect(QUIET_HOUR_CHOICES[23]).toBe('23:00');
    // Padded because `parseClockMinutes` and the label both read them literally.
    for (const choice of QUIET_HOUR_CHOICES) {
      expect(choice).toMatch(/^\d{2}:00$/);
    }
  });

  it('reads equal start and end as off', () => {
    // This is how the screen expresses "quiet hours off" without a third setting
    // or a ninth jsonb key: turning them off sets the end to the start. It has to
    // agree with `isWithinQuietHours`, whose own definition of off this is.
    expect(quietHoursEnabled({ quiet_hours_start: '22:00', quiet_hours_end: '22:00' })).toBe(
      false
    );
    expect(quietHoursEnabled({ quiet_hours_start: '22:00', quiet_hours_end: '07:00' })).toBe(
      true
    );
  });

  it('reads an unparseable window as off', () => {
    // Fails open, matching `isWithinQuietHours`: a corrupt window must not silence
    // the app, and the screen shows the student that it is doing nothing.
    const junk = (start: unknown, end: unknown) =>
      quietHoursEnabled({ quiet_hours_start: start, quiet_hours_end: end } as never);
    expect(junk('25:00', '07:00')).toBe(false);
    expect(junk(null, '07:00')).toBe(false);
    expect(junk('22:00', '')).toBe(false);
    expect(junk(undefined, undefined)).toBe(false);
  });

  it('names the wrap, because an overnight window surprises people', () => {
    expect(quietHoursLabel({ quiet_hours_start: '22:00', quiet_hours_end: '07:00' })).toBe(
      '22:00 to 07:00, overnight'
    );
    // Same day, no wrap, no note.
    expect(quietHoursLabel({ quiet_hours_start: '09:00', quiet_hours_end: '17:00' })).toBe(
      '09:00 to 17:00'
    );
  });

  it('says what off means rather than just "off"', () => {
    const label = quietHoursLabel({ quiet_hours_start: '08:00', quiet_hours_end: '08:00' });
    expect(label).toContain('Off');
    expect(label).toContain('any hour');
  });
});

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

describe('countUnreadNotifications', () => {
  it('counts the rows with no read_at', () => {
    expect(
      countUnreadNotifications([
        { read_at: null },
        { read_at: localIso(2026, 9, 5, 9, 0) },
        { read_at: null },
      ])
    ).toBe(2);
    expect(countUnreadNotifications([])).toBe(0);
  });
});

describe('notificationWhenLabel', () => {
  const now = new Date(2026, 8, 5, 18, 0);

  it('gives a time for today and yesterday, a date before that', () => {
    expect(notificationWhenLabel(localIso(2026, 9, 5, 16, 5), now)).toContain('Today');
    expect(notificationWhenLabel(localIso(2026, 9, 4, 8, 0), now)).toContain('Yesterday');
    expect(notificationWhenLabel(localIso(2026, 9, 1, 8, 0), now)).toBe('1 September');
  });

  it('returns empty for an unparseable timestamp', () => {
    expect(notificationWhenLabel('not-a-date', now)).toBe('');
  });
});

describe('buildInbox', () => {
  const now = new Date(2026, 8, 5, 18, 0);

  it('is empty for no rows — no stray header', () => {
    expect(buildInbox([], now)).toEqual([]);
  });

  it('emits one header per distinct local day', () => {
    const items = buildInbox(
      [
        note({ notification_id: 'a', created_at: localIso(2026, 9, 5, 16, 0) }),
        note({ notification_id: 'b', created_at: localIso(2026, 9, 5, 9, 0) }),
        note({ notification_id: 'c', created_at: localIso(2026, 9, 4, 20, 0) }),
      ],
      now
    );
    expect(items.map((i) => i.type)).toEqual([
      'day',
      'notification',
      'notification',
      'day',
      'notification',
    ]);
    expect(items.filter((i) => i.type === 'day').map((i) => (i as { label: string }).label)).toEqual(
      ['Today', 'Yesterday']
    );
  });

  it('does not re-sort the rows it is given', () => {
    // The rows arrive in `notifications_inbox_idx` order, which resolves the tie on
    // `created_at` with `notification_id`. Re-sorting here on `created_at` alone
    // would break that tie and drop or repeat a row across keyset pages, so this
    // function is deliberately order-preserving even when the order looks wrong.
    const out = buildInbox(
      [
        note({ notification_id: 'old', created_at: localIso(2026, 9, 4, 8, 0) }),
        note({ notification_id: 'new', created_at: localIso(2026, 9, 5, 8, 0) }),
      ],
      now
    );
    const ids = out
      .filter((i) => i.type === 'notification')
      .map((i) => (i as { row: Notification }).row.notification_id);
    expect(ids).toEqual(['old', 'new']);
  });

  it('gives every item a key, all distinct', () => {
    // A FlatList with a duplicate key silently drops the second row.
    const items = buildInbox(
      [
        note({ notification_id: 'a', created_at: localIso(2026, 9, 5, 16, 0) }),
        note({ notification_id: 'b', created_at: localIso(2026, 9, 4, 16, 0) }),
        note({ notification_id: 'c', created_at: localIso(2026, 9, 3, 16, 0) }),
      ],
      now
    );
    const keys = items.map((i) => i.key);
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps two rows sharing an instant, both of them', () => {
    // A sender fan-out writes every recipient's row in one statement, so identical
    // `created_at` values are normal rather than a coincidence to be deduped.
    const shared = localIso(2026, 9, 5, 16, 0);
    const items = buildInbox(
      [
        note({ notification_id: 'b', created_at: shared }),
        note({ notification_id: 'a', created_at: shared }),
      ],
      now
    );
    expect(items.filter((i) => i.type === 'notification')).toHaveLength(2);
    expect(items.filter((i) => i.type === 'day')).toHaveLength(1);
  });

  it('carries the stored row through untouched', () => {
    // Title and body are rendered as sent and never re-derived: "4 new messages in
    // BIO 201" stays true after a fifth arrives.
    const row = note({ title: 'stored title', body: 'stored body' });
    const item = buildInbox([row], now)[1];
    expect(item.type).toBe('notification');
    expect((item as { row: Notification }).row).toBe(row);
  });
});

describe('notificationRoute', () => {
  it('resolves a destination for every kind that has a group', () => {
    // The point of the exhaustive switch: a notification you cannot tap through is
    // a dead end, and nothing but the compiler and this test will notice one.
    for (const kind of SENT_KINDS) {
      expect(notificationRoute({ kind, group_id: 'g1' })).toBeTruthy();
    }
  });

  it('sends session and message kinds to the timeline', () => {
    for (const kind of [
      'session_proposed',
      'session_confirmed',
      'session_cancelled',
      'session_needs_one_yes',
      'message_activity',
    ] as SentNotificationKind[]) {
      expect(notificationRoute({ kind, group_id: 'g1' })).toBe('/(app)/groups/g1/chat');
    }
  });

  it('sends a shared file to the files tab, not the timeline', () => {
    // A student told about a file wants the file; the timeline entry for it is
    // hundreds of messages back by the time they look.
    expect(notificationRoute({ kind: 'file_shared', group_id: 'g1' })).toBe(
      '/(app)/groups/g1/files'
    );
  });

  it('sends the group-level kinds to the group', () => {
    for (const kind of ['group_matched', 'group_free_slot', 'group_quiet'] as SentNotificationKind[]) {
      expect(notificationRoute({ kind, group_id: 'g1' })).toBe('/(app)/groups/g1');
    }
  });

  it('sends both invitation kinds to the invitations list, group or not', () => {
    // The recipient is not a member yet, so the group's own screens would refuse
    // them — which is also why this arm ignores `group_id` entirely.
    expect(notificationRoute({ kind: 'invitation', group_id: 'g1' })).toBe(
      '/(app)/groups/invitations'
    );
    expect(notificationRoute({ kind: 'invitation_unanswered', group_id: null })).toBe(
      '/(app)/groups/invitations'
    );
  });

  it('returns null for a group-scoped kind with no group', () => {
    // `0019` allows a null `group_id`, so this is reachable. The inbox renders
    // those rows plain and unpressable rather than routing to `/groups/null`.
    for (const kind of SENT_KINDS) {
      const route = notificationRoute({ kind, group_id: null });
      if (kind === 'invitation' || kind === 'invitation_unanswered') {
        expect(route).toBe('/(app)/groups/invitations');
      } else {
        expect(route).toBeNull();
      }
    }
  });

  it('never builds a path with a literal null or undefined in it', () => {
    for (const kind of SENT_KINDS) {
      for (const gid of ['g1', null]) {
        const route = notificationRoute({ kind, group_id: gid });
        if (route !== null) {
          expect(route).not.toContain('null');
          expect(route).not.toContain('undefined');
        }
      }
    }
  });
});

describe('compareNotificationsNewestFirst', () => {
  it('puts the newer row first', () => {
    const older = note({ notification_id: 'a', created_at: localIso(2026, 9, 4, 8, 0) });
    const newer = note({ notification_id: 'b', created_at: localIso(2026, 9, 5, 8, 0) });
    expect(compareNotificationsNewestFirst(newer, older)).toBeLessThan(0);
    expect(compareNotificationsNewestFirst(older, newer)).toBeGreaterThan(0);
  });

  it('breaks a tie on the id, descending', () => {
    // A fan-out gives every recipient's row the same `now()`, so this is the case
    // that actually happens — and the order has to match the index the cursor
    // pages against, which is `notification_id desc`.
    const shared = localIso(2026, 9, 5, 8, 0);
    const a = note({ notification_id: 'a', created_at: shared });
    const b = note({ notification_id: 'b', created_at: shared });
    expect(compareNotificationsNewestFirst(b, a)).toBeLessThan(0);
    expect(compareNotificationsNewestFirst(a, b)).toBeGreaterThan(0);
  });

  it('is zero only for the same row', () => {
    const row = note();
    expect(compareNotificationsNewestFirst(row, row)).toBe(0);
    // Same instant, same id, different contents: still the same row as far as the
    // ordering goes, because the id is the identity.
    expect(compareNotificationsNewestFirst(row, note({ title: 'other' }))).toBe(0);
  });
});

describe('nextInboxCursor', () => {
  it('is null before anything is loaded', () => {
    expect(nextInboxCursor([])).toBeNull();
  });

  it('points at the oldest row held', () => {
    const cursor = nextInboxCursor([
      note({ notification_id: 'c', created_at: localIso(2026, 9, 5, 8, 0) }),
      note({ notification_id: 'a', created_at: localIso(2026, 9, 3, 8, 0) }),
      note({ notification_id: 'b', created_at: localIso(2026, 9, 4, 8, 0) }),
    ]);
    expect(cursor).toEqual({
      created_at: localIso(2026, 9, 3, 8, 0),
      notification_id: 'a',
    });
  });

  it('carries the id as well as the instant', () => {
    // Both columns, or the next page's `created_at < cursor` drops every row
    // sharing that instant — and a dropped notification appears in neither page.
    const shared = localIso(2026, 9, 3, 8, 0);
    const cursor = nextInboxCursor([
      note({ notification_id: 'b', created_at: shared }),
      note({ notification_id: 'a', created_at: shared }),
    ]);
    // The lowest id at that instant, since the index descends on it.
    expect(cursor).toEqual({ created_at: shared, notification_id: 'a' });
  });

  it('does not care what order it is given', () => {
    const rows = [
      note({ notification_id: 'a', created_at: localIso(2026, 9, 3, 8, 0) }),
      note({ notification_id: 'b', created_at: localIso(2026, 9, 4, 8, 0) }),
    ];
    expect(nextInboxCursor(rows)).toEqual(nextInboxCursor([...rows].reverse()));
  });
});

describe('upsertNotifications', () => {
  it('merges by id rather than appending', () => {
    // The boundary row of a keyset page arrives twice, legitimately. Appending
    // would render it twice, and the duplicate would need dismissing twice.
    const held = [note({ notification_id: 'a', created_at: localIso(2026, 9, 5, 8, 0) })];
    const merged = upsertNotifications(held, [
      note({ notification_id: 'a', created_at: localIso(2026, 9, 5, 8, 0) }),
      note({ notification_id: 'b', created_at: localIso(2026, 9, 4, 8, 0) }),
    ]);
    expect(merged.map((r) => r.notification_id)).toEqual(['a', 'b']);
  });

  it('lets the incoming copy win', () => {
    // A refetch that finds a row read on another device has to be able to say so.
    const readAt = localIso(2026, 9, 5, 12, 0);
    const merged = upsertNotifications(
      [note({ notification_id: 'a', read_at: null })],
      [note({ notification_id: 'a', read_at: readAt })]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].read_at).toBe(readAt);
  });

  it('sorts the result newest first, ties on id', () => {
    const shared = localIso(2026, 9, 5, 8, 0);
    const merged = upsertNotifications(
      [],
      [
        note({ notification_id: 'a', created_at: shared }),
        note({ notification_id: 'c', created_at: localIso(2026, 9, 6, 8, 0) }),
        note({ notification_id: 'b', created_at: shared }),
      ]
    );
    expect(merged.map((r) => r.notification_id)).toEqual(['c', 'b', 'a']);
  });

  it('returns a copy when nothing came in, and never mutates the input', () => {
    const held = [note({ notification_id: 'a' })];
    const same = upsertNotifications(held, []);
    expect(same).toEqual(held);
    expect(same).not.toBe(held);
    upsertNotifications(held, [note({ notification_id: 'b' })]);
    expect(held).toHaveLength(1);
  });
});

describe('applyNotificationRead', () => {
  const readAt = localIso(2026, 9, 5, 17, 0);

  it('stamps the row tapped and leaves the rest', () => {
    const rows = applyNotificationRead(
      [note({ notification_id: 'a' }), note({ notification_id: 'b' })],
      'a',
      readAt
    );
    expect(rows[0].read_at).toBe(readAt);
    expect(rows[1].read_at).toBeNull();
  });

  it('keeps the row in the list', () => {
    // Dismissing is a timestamp, not a delete: a student who taps the wrong row
    // has to be able to find it again, so the screen dims it instead.
    const rows = applyNotificationRead([note({ notification_id: 'a' })], 'a', readAt);
    expect(rows).toHaveLength(1);
  });

  it('does not move an already-read timestamp', () => {
    // `coalesce(read_at, now())` on the server. If the client moved it and the
    // server did not, the row would jump position after the next fetch — the
    // screen re-sorting under a thumb that has only just tapped it.
    const first = localIso(2026, 9, 5, 9, 0);
    const rows = applyNotificationRead(
      [note({ notification_id: 'a', read_at: first })],
      'a',
      readAt
    );
    expect(rows[0].read_at).toBe(first);
  });

  it('is a no-op for an id it does not hold', () => {
    const held = [note({ notification_id: 'a' })];
    expect(applyNotificationRead(held, 'missing', readAt)).toEqual(held);
  });

  it('does not mutate the rows it is given', () => {
    // The hook reverts by re-applying the previous array on failure, which only
    // works if the previous array was never touched.
    const held = [note({ notification_id: 'a' })];
    applyNotificationRead(held, 'a', readAt);
    expect(held[0].read_at).toBeNull();
  });
});

describe('applyAllNotificationsRead', () => {
  const readAt = localIso(2026, 9, 5, 17, 0);

  it('stamps every unread row with one instant', () => {
    const rows = applyAllNotificationsRead(
      [
        note({ notification_id: 'a' }),
        note({ notification_id: 'b' }),
        note({ notification_id: 'c' }),
      ],
      readAt
    );
    expect(rows.map((r) => r.read_at)).toEqual([readAt, readAt, readAt]);
    expect(countUnreadNotifications(rows)).toBe(0);
  });

  it('leaves the ones already read where they were', () => {
    const earlier = localIso(2026, 9, 4, 9, 0);
    const rows = applyAllNotificationsRead(
      [note({ notification_id: 'a', read_at: earlier }), note({ notification_id: 'b' })],
      readAt
    );
    expect(rows[0].read_at).toBe(earlier);
    expect(rows[1].read_at).toBe(readAt);
  });

  it('does not mutate the rows it is given', () => {
    const held = [note({ notification_id: 'a' })];
    applyAllNotificationsRead(held, readAt);
    expect(held[0].read_at).toBeNull();
  });
});
