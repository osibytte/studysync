import {
  FILE_NAME_MAX_LENGTH,
  MATERIALS_ALLOWED_MIME_TYPES,
  MESSAGE_MAX_LENGTH,
  PROPOSAL_DAYS_AHEAD,
  PROPOSAL_FIRST_HOUR,
  PROPOSAL_LAST_HOUR,
  PROPOSAL_STEP_MIN,
  RUN_GAP_MS,
  SESSION_DURATION_CHOICES,
  SESSION_DURATION_MAX,
  SESSION_DURATION_MIN,
  SESSION_LOCATION_MAX,
  SESSION_PAST_GRACE_MS,
  SESSION_RESPONSE_LABEL,
  SESSION_STATUS_LABEL,
  buildTimeline,
  canCancelSession,
  canDeleteMaterial,
  canDeleteMessage,
  canDownloadMaterial,
  canRespondToSession,
  combineLocalDateTime,
  compareMessagesNewestFirst,
  dayLabel,
  deletedMessageText,
  fileExtension,
  fileKind,
  firstOpenProposalSlot,
  formatClock,
  formatDuration,
  formatFileSize,
  formatTimeOfDay,
  isProposalSlotPast,
  isSessionPast,
  lastMessageLine,
  localDayKey,
  materialNote,
  materialStateLabel,
  materialStoragePath,
  materialWhenLabel,
  nextPageCursor,
  normaliseMessageBody,
  proposalDayOptions,
  proposalTimeOptions,
  renderKind,
  safePathSegment,
  sessionRuleLabel,
  sessionTallyLabel,
  sessionWhenLabel,
  sharedFileBody,
  totalUnread,
  unreadBadge,
  unreadSummary,
  uploadMimeType,
  upsertMessages,
  validateMessageBody,
  validateSessionProposal,
  validateUpload,
  waitingOnLabel,
  yesStillNeeded,
} from '../chatRules';
import { MATERIALS_MAX_BYTES } from '@/types/database';
import type {
  GroupMaterialRow,
  GroupSessionRow,
  Message,
  MessageKind,
  SessionAttendeeRow,
  SessionResponseValue,
  SessionStatus,
} from '@/types/database';

/**
 * These pin the client copy of rules the Stage 3 and Stage 4 RPCs enforce, so
 * the two cannot drift silently — same contract as `groupRules.test.ts`.
 *
 * Every instant below is built from LOCAL wall-clock components, because the
 * suite has no fixed TZ and the labels under test are deliberately local. A
 * hardcoded 'Z' string would assert a different calendar day on a machine in
 * Lagos than on one in UTC, and pass in CI while being wrong on the device.
 */
function localIso(
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0
): string {
  return new Date(y, mo - 1, d, h, mi, s).toISOString();
}

const ME = 'me-0000-0000';
const OTHER = 'other-0000-0000';

/** Listed out so adding a union member fails here as well as in the type. */
const ALL_KINDS: MessageKind[] = ['text', 'session', 'file'];
const ALL_STATUSES: SessionStatus[] = ['proposed', 'confirmed', 'cancelled'];
const ALL_RESPONSES: SessionResponseValue[] = ['yes', 'no', 'maybe'];

function msg(over: Partial<Message> = {}): Message {
  return {
    message_id: 'm1',
    group_id: 'g1',
    sender_id: ME,
    body: 'Hello',
    kind: 'text',
    session_id: null,
    material_id: null,
    created_at: localIso(2026, 9, 5, 10, 0),
    deleted_at: null,
    ...over,
  };
}

function sessionRow(over: Partial<GroupSessionRow> = {}): GroupSessionRow {
  return {
    session_id: 's1',
    message_id: 'm1',
    starts_at: localIso(2026, 9, 6, 16, 0),
    duration_min: 120,
    location: 'Library, third floor',
    status: 'proposed',
    proposed_by: ME,
    proposer_name: 'Ada',
    members_counted: 3,
    yes_count: 1,
    no_count: 0,
    maybe_count: 0,
    confirm_threshold: 3,
    my_response: null,
    ...over,
  };
}

function materialRow(over: Partial<GroupMaterialRow> = {}): GroupMaterialRow {
  return {
    material_id: 'mat1',
    message_id: 'm1',
    storage_path: 'g1/mat1/notes.pdf',
    file_name: 'notes.pdf',
    mime_type: 'application/pdf',
    size_bytes: 2048,
    uploaded_by: ME,
    uploader_name: 'Ada',
    created_at: localIso(2026, 9, 5, 10, 0),
    deleted_at: null,
    deleted_by: null,
    ...over,
  };
}

function attendee(over: Partial<SessionAttendeeRow> = {}): SessionAttendeeRow {
  return {
    user_id: 'u1',
    full_name: 'Ada',
    department: 'Computer Science',
    is_proposer: false,
    response: null,
    responded_at: null,
    ...over,
  };
}

const NAMES: Record<string, string> = { [ME]: 'Ada', [OTHER]: 'Chidi' };
const nameFor = (userId: string): string | null => NAMES[userId] ?? null;

describe('the constants that mirror the SQL', () => {
  it('matches the CHECKs and thresholds the migrations declare', () => {
    expect(MESSAGE_MAX_LENGTH).toBe(2000); // messages_body_shape, 0013
    expect(SESSION_DURATION_MIN).toBe(15); // duration_min CHECK, 0016
    expect(SESSION_DURATION_MAX).toBe(480);
    expect(SESSION_LOCATION_MAX).toBe(200);
    expect(FILE_NAME_MAX_LENGTH).toBe(255); // file_name CHECK, 0017
    expect(MATERIALS_MAX_BYTES).toBe(26_214_400); // size_bytes CHECK + bucket limit
    expect(SESSION_PAST_GRACE_MS).toBe(60 * 60 * 1000); // group_sessions' grace
    expect(RUN_GAP_MS).toBe(5 * 60 * 1000);
  });

  it('has a label for every status and every response', () => {
    expect(Object.keys(SESSION_STATUS_LABEL).sort()).toEqual([...ALL_STATUSES].sort());
    expect(Object.keys(SESSION_RESPONSE_LABEL).sort()).toEqual([...ALL_RESPONSES].sort());
    expect(SESSION_RESPONSE_LABEL.yes).toBe('I can make it');
  });
});

describe('normaliseMessageBody / validateMessageBody', () => {
  it('sends the trimmed body, because that is what the CHECK measures', () => {
    expect(normaliseMessageBody('  see you at 4  ')).toBe('see you at 4');
    expect(normaliseMessageBody('\n\t')).toBe('');
  });

  it('accepts a body from 1 to MESSAGE_MAX_LENGTH characters', () => {
    expect(validateMessageBody('hi')).toBeNull();
    expect(validateMessageBody('x'.repeat(MESSAGE_MAX_LENGTH))).toBeNull();
  });

  it('rejects nothing, or only whitespace', () => {
    expect(validateMessageBody('')).toBe('Type something first');
    expect(validateMessageBody('   \n ')).toBe('Type something first');
  });

  it('rejects one character past the limit, counting the body trimmed', () => {
    expect(validateMessageBody('x'.repeat(MESSAGE_MAX_LENGTH + 1))).toBe(
      `Messages are up to ${MESSAGE_MAX_LENGTH} characters`
    );
    // Trailing space does not push a maximum-length body over: btrim runs first.
    expect(validateMessageBody(`${'x'.repeat(MESSAGE_MAX_LENGTH)}   `)).toBeNull();
  });
});

describe('compareMessagesNewestFirst', () => {
  const older = msg({ message_id: 'a', created_at: localIso(2026, 9, 5, 10, 0) });
  const newer = msg({ message_id: 'b', created_at: localIso(2026, 9, 5, 11, 0) });

  it('puts the newer message first', () => {
    expect(compareMessagesNewestFirst(newer, older)).toBeLessThan(0);
    expect(compareMessagesNewestFirst(older, newer)).toBeGreaterThan(0);
  });

  it('breaks a shared timestamp by message_id, descending', () => {
    const at = localIso(2026, 9, 5, 10, 0);
    const low = msg({ message_id: 'aaa', created_at: at });
    const high = msg({ message_id: 'bbb', created_at: at });
    expect(compareMessagesNewestFirst(high, low)).toBeLessThan(0);
    expect(compareMessagesNewestFirst(low, high)).toBeGreaterThan(0);
  });

  it('is 0 for the same message, so sorting is stable', () => {
    expect(compareMessagesNewestFirst(newer, { ...newer })).toBe(0);
  });
});

describe('upsertMessages', () => {
  const a = msg({ message_id: 'a', created_at: localIso(2026, 9, 5, 10, 0) });
  const b = msg({ message_id: 'b', created_at: localIso(2026, 9, 5, 11, 0) });
  const c = msg({ message_id: 'c', created_at: localIso(2026, 9, 5, 12, 0) });

  it('returns a copy, never the same array, when there is nothing to fold in', () => {
    const current = [b, a];
    const result = upsertMessages(current, []);
    expect(result).toEqual(current);
    expect(result).not.toBe(current);
  });

  it('merges and sorts newest first', () => {
    expect(upsertMessages([a], [c, b]).map((m) => m.message_id)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('lets the incoming copy win, so an echo replaces its optimistic bubble', () => {
    const optimistic = msg({ message_id: 'a', body: 'sending…' });
    const fromServer = msg({ message_id: 'a', body: 'sent' });
    const result = upsertMessages([optimistic], [fromServer]);
    expect(result).toHaveLength(1);
    expect(result[0].body).toBe('sent');
  });

  it('applies a soft delete arriving as an update to a row already held', () => {
    const live = msg({ message_id: 'a', body: 'oops' });
    const deleted = msg({
      message_id: 'a',
      body: '',
      deleted_at: localIso(2026, 9, 5, 12, 0),
    });
    const result = upsertMessages([live], [deleted]);
    expect(result).toHaveLength(1);
    expect(result[0].deleted_at).not.toBeNull();
    expect(result[0].body).toBe('');
  });

  it('de-dupes within one incoming batch', () => {
    expect(upsertMessages([], [a, { ...a, body: 'later' }])).toHaveLength(1);
  });
});

describe('nextPageCursor', () => {
  it('is null before anything is loaded', () => {
    expect(nextPageCursor([])).toBeNull();
  });

  it('points at the oldest message held, carrying BOTH keyset columns', () => {
    const oldest = msg({ message_id: 'a', created_at: localIso(2026, 9, 5, 9, 0) });
    const middle = msg({ message_id: 'b', created_at: localIso(2026, 9, 5, 10, 0) });
    const newest = msg({ message_id: 'c', created_at: localIso(2026, 9, 5, 11, 0) });
    expect(nextPageCursor([newest, middle, oldest])).toEqual({
      created_at: oldest.created_at,
      message_id: 'a',
    });
  });

  it('does not care what order the list arrives in', () => {
    const oldest = msg({ message_id: 'a', created_at: localIso(2026, 9, 5, 9, 0) });
    const newest = msg({ message_id: 'b', created_at: localIso(2026, 9, 5, 11, 0) });
    expect(nextPageCursor([oldest, newest])?.message_id).toBe('a');
  });

  it('takes the lowest message_id when the oldest timestamp is shared', () => {
    // The pair the timestamp alone would lose: paging on created_at < cursor
    // would skip 'bbb' entirely, and the gap would look like nothing happened.
    const at = localIso(2026, 9, 5, 9, 0);
    const low = msg({ message_id: 'aaa', created_at: at });
    const high = msg({ message_id: 'bbb', created_at: at });
    expect(nextPageCursor([high, low])).toEqual({ created_at: at, message_id: 'aaa' });
  });
});

describe('localDayKey', () => {
  it('reports the LOCAL calendar day, not the ISO string prefix', () => {
    // Half past midnight local. East of UTC the ISO prefix says yesterday, so a
    // string-slicing implementation files this under the wrong separator.
    expect(localDayKey(localIso(2026, 9, 5, 0, 30))).toBe('2026-09-05');
    expect(localDayKey(localIso(2026, 9, 5, 23, 30))).toBe('2026-09-05');
  });

  it('pads month and day to two digits', () => {
    expect(localDayKey(localIso(2026, 1, 7, 12, 0))).toBe('2026-01-07');
  });

  it('returns empty for an unparseable value rather than throwing', () => {
    expect(localDayKey('not a date')).toBe('');
    expect(localDayKey('')).toBe('');
  });
});

describe('dayLabel', () => {
  const now = new Date(2026, 8, 20, 15, 0); // 20 September 2026, local

  it('names today and yesterday', () => {
    expect(dayLabel('2026-09-20', now)).toBe('Today');
    expect(dayLabel('2026-09-19', now)).toBe('Yesterday');
  });

  it('names tomorrow too, for the future-facing callers', () => {
    // A transcript separator can never be dated ahead; sessionWhenLabel and the
    // proposal picker both can, and "Tomorrow, 4pm" beats "21 September, 4pm".
    expect(dayLabel('2026-09-21', now)).toBe('Tomorrow');
    expect(dayLabel('2026-10-01', new Date(2026, 8, 30, 9, 0))).toBe('Tomorrow');
    expect(dayLabel('2026-01-01', new Date(2025, 11, 31, 9, 0))).toBe('Tomorrow');
  });

  it('crosses a month boundary to find yesterday', () => {
    expect(dayLabel('2026-08-31', new Date(2026, 8, 1, 9, 0))).toBe('Yesterday');
  });

  it('crosses a year boundary to find yesterday, without adding the year', () => {
    expect(dayLabel('2025-12-31', new Date(2026, 0, 1, 9, 0))).toBe('Yesterday');
  });

  it('drops the year within the current one and keeps it outside', () => {
    expect(dayLabel('2026-09-05', now)).toBe('5 September');
    expect(dayLabel('2026-12-25', now)).toBe('25 December');
    expect(dayLabel('2025-09-05', now)).toBe('5 September 2025');
  });

  it('renders nothing for an empty key and passes a malformed one through', () => {
    expect(dayLabel('', now)).toBe('');
    expect(dayLabel('rubbish', now)).toBe('rubbish');
  });
});

describe('formatClock', () => {
  it('reads twelve-hour and lowercase, to match the availability grid', () => {
    expect(formatClock(localIso(2026, 9, 5, 16, 5))).toBe('4:05pm');
    expect(formatClock(localIso(2026, 9, 5, 8, 0))).toBe('8am');
    expect(formatClock(localIso(2026, 9, 5, 23, 59))).toBe('11:59pm');
  });

  it('gets both noon and midnight right', () => {
    expect(formatClock(localIso(2026, 9, 5, 12, 0))).toBe('12pm');
    expect(formatClock(localIso(2026, 9, 5, 12, 30))).toBe('12:30pm');
    expect(formatClock(localIso(2026, 9, 5, 0, 0))).toBe('12am');
    expect(formatClock(localIso(2026, 9, 5, 0, 5))).toBe('12:05am');
  });

  it('returns empty for an unparseable value', () => {
    expect(formatClock('half three')).toBe('');
  });
});

describe('renderKind', () => {
  it('renders each kind as itself when its referent is there', () => {
    expect(renderKind(msg({ kind: 'text' }))).toBe('text');
    expect(renderKind(msg({ kind: 'session', session_id: 's1' }))).toBe('session');
    expect(renderKind(msg({ kind: 'file', material_id: 'mat1' }))).toBe('file');
  });

  it('falls back to the plain bubble when the referent is missing', () => {
    expect(renderKind(msg({ kind: 'session', session_id: null }))).toBe('text');
    expect(renderKind(msg({ kind: 'file', material_id: null }))).toBe('text');
  });

  it('falls back for a kind this build does not know', () => {
    // A later migration adding a fourth kind must not blank an installed app.
    expect(renderKind(msg({ kind: 'poll' as MessageKind }))).toBe('text');
  });

  it('always answers with a kind the screen can render', () => {
    for (const kind of ALL_KINDS) {
      const m = msg({ kind, session_id: 's1', material_id: 'mat1' });
      expect(ALL_KINDS).toContain(renderKind(m));
    }
  });
});

describe('buildTimeline', () => {
  const NOW = new Date(2026, 8, 5, 12, 0); // 5 September 2026, local

  /** One local day, 10:00 / 10:02 / 10:30 from me, then 10:31 from someone else. */
  const oneDay = [
    msg({ message_id: 'm1', created_at: localIso(2026, 9, 5, 10, 0) }),
    msg({ message_id: 'm2', created_at: localIso(2026, 9, 5, 10, 2) }),
    msg({ message_id: 'm3', created_at: localIso(2026, 9, 5, 10, 30) }),
    msg({
      message_id: 'm4',
      sender_id: OTHER,
      created_at: localIso(2026, 9, 5, 10, 31),
    }),
  ];

  it('returns nothing at all for an empty list — not a stray separator', () => {
    expect(buildTimeline({ messages: [], currentUserId: ME })).toEqual([]);
  });

  it('orders newest first, for an inverted list', () => {
    const items = buildTimeline({ messages: oneDay, currentUserId: ME, now: NOW });
    expect(items.map((i) => i.key)).toEqual([
      'm4',
      'm3',
      'm2',
      'm1',
      'day:2026-09-05',
    ]);
  });

  it('leaves the caller’s array untouched', () => {
    const input = [...oneDay];
    buildTimeline({ messages: input, currentUserId: ME, now: NOW });
    expect(input.map((m) => m.message_id)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('emits the day separator AFTER that day’s oldest message, so it renders above it', () => {
    const twoDays = [
      msg({ message_id: 'm1', created_at: localIso(2026, 9, 4, 22, 0) }),
      msg({ message_id: 'm2', created_at: localIso(2026, 9, 5, 9, 0) }),
      msg({ message_id: 'm3', created_at: localIso(2026, 9, 5, 9, 1) }),
    ];
    const items = buildTimeline({ messages: twoDays, currentUserId: ME, now: NOW });
    expect(items.map((i) => i.key)).toEqual([
      'm3',
      'm2',
      'day:2026-09-05',
      'm1',
      'day:2026-09-04',
    ]);

    items.forEach((item, i) => {
      if (item.type !== 'day') return;
      const below = items[i - 1]; // lower index renders lower down
      expect(below?.type).toBe('message');
      if (below?.type === 'message') {
        expect(localDayKey(below.message.created_at)).toBe(item.dayKey);
      }
      const above = items[i + 1]; // whatever is next up belongs to an older day
      if (above?.type === 'message') {
        expect(localDayKey(above.message.created_at)).not.toBe(item.dayKey);
      }
    });
  });

  /** The one message item with this key, narrowed. Throws rather than silently passing. */
  function messageItem(items: ReturnType<typeof buildTimeline>, key: string) {
    const found = items.find((i) => i.type === 'message' && i.key === key);
    if (!found || found.type !== 'message') throw new Error(`no message item ${key}`);
    return found;
  }

  it('emits exactly one separator per loaded day', () => {
    const across = [
      msg({ message_id: 'm1', created_at: localIso(2026, 9, 3, 9, 0) }),
      msg({ message_id: 'm2', created_at: localIso(2026, 9, 3, 18, 0) }),
      msg({ message_id: 'm3', created_at: localIso(2026, 9, 4, 9, 0) }),
      msg({ message_id: 'm4', created_at: localIso(2026, 9, 5, 9, 0) }),
    ];
    const days = buildTimeline({
      messages: across,
      currentUserId: ME,
      now: NOW,
    }).filter((i) => i.type === 'day');
    expect(days.map((d) => (d.type === 'day' ? d.dayKey : ''))).toEqual([
      '2026-09-05',
      '2026-09-04',
      '2026-09-03',
    ]);
  });

  it('labels the topmost loaded day, even in the middle of a history', () => {
    const items = buildTimeline({ messages: oneDay, currentUserId: ME, now: NOW });
    const top = items[items.length - 1];
    expect(top.type).toBe('day');
    expect(top.type === 'day' && top.label).toBe('Today');
  });

  it('groups a run into one heading: name on the oldest, time on the newest', () => {
    const items = buildTimeline({ messages: oneDay, currentUserId: ME, now: NOW });
    // m1 10:00 and m2 10:02 are one run; m3 10:30 breaks it on the gap.
    expect(messageItem(items, 'm1').showSender).toBe(true);
    expect(messageItem(items, 'm1').showTime).toBe(false);
    expect(messageItem(items, 'm2').showSender).toBe(false);
    expect(messageItem(items, 'm2').showTime).toBe(true);
    expect(messageItem(items, 'm3').showSender).toBe(true);
    expect(messageItem(items, 'm3').showTime).toBe(true);
  });

  it('breaks the run when the sender changes', () => {
    const items = buildTimeline({ messages: oneDay, currentUserId: ME, now: NOW });
    // m4 is a minute after m3 but from someone else.
    expect(messageItem(items, 'm4').showSender).toBe(true);
    expect(messageItem(items, 'm3').showTime).toBe(true);
  });

  it('treats RUN_GAP_MS as inclusive, and one second past it as a break', () => {
    const at = localIso(2026, 9, 5, 10, 0);
    const exactly = new Date(new Date(at).getTime() + RUN_GAP_MS).toISOString();
    const justOver = new Date(new Date(at).getTime() + RUN_GAP_MS + 1000).toISOString();

    const grouped = buildTimeline({
      messages: [msg({ message_id: 'm1', created_at: at }), msg({ message_id: 'm2', created_at: exactly })],
      currentUserId: ME,
      now: NOW,
    });
    expect(messageItem(grouped, 'm2').showSender).toBe(false);

    const split = buildTimeline({
      messages: [msg({ message_id: 'm1', created_at: at }), msg({ message_id: 'm2', created_at: justOver })],
      currentUserId: ME,
      now: NOW,
    });
    expect(messageItem(split, 'm2').showSender).toBe(true);
  });

  it('breaks the run across midnight, even a minute apart', () => {
    const items = buildTimeline({
      messages: [
        msg({ message_id: 'm1', created_at: localIso(2026, 9, 4, 23, 59) }),
        msg({ message_id: 'm2', created_at: localIso(2026, 9, 5, 0, 0) }),
      ],
      currentUserId: ME,
      now: NOW,
    });
    expect(messageItem(items, 'm2').showSender).toBe(true);
    expect(messageItem(items, 'm1').showTime).toBe(true);
  });

  it('never folds a card into a run, in either direction', () => {
    const items = buildTimeline({
      messages: [
        msg({ message_id: 'm1', created_at: localIso(2026, 9, 5, 10, 0) }),
        msg({
          message_id: 'm2',
          kind: 'session',
          session_id: 's1',
          body: 'Ada proposed a study time',
          created_at: localIso(2026, 9, 5, 10, 1),
        }),
        msg({ message_id: 'm3', created_at: localIso(2026, 9, 5, 10, 2) }),
      ],
      currentUserId: ME,
      now: NOW,
    });
    for (const key of ['m1', 'm2', 'm3']) {
      expect(messageItem(items, key).showSender).toBe(true);
      expect(messageItem(items, key).showTime).toBe(true);
    }
    expect(messageItem(items, 'm2').kind).toBe('session');
  });

  it('marks my own messages, and marks nothing when nobody is signed in', () => {
    const mine = buildTimeline({ messages: oneDay, currentUserId: ME, now: NOW });
    expect(messageItem(mine, 'm1').isMine).toBe(true);
    expect(messageItem(mine, 'm4').isMine).toBe(false);

    const anonymous = buildTimeline({ messages: oneDay, currentUserId: null, now: NOW });
    expect(anonymous.every((i) => i.type !== 'message' || !i.isMine)).toBe(true);
  });

  it('flags only the messages the outbox still holds', () => {
    const items = buildTimeline({
      messages: oneDay,
      currentUserId: ME,
      pendingIds: new Set(['m3']),
      now: NOW,
    });
    expect(messageItem(items, 'm3').pending).toBe(true);
    expect(messageItem(items, 'm1').pending).toBe(false);
  });

  it('defaults everything to settled when no outbox is passed', () => {
    const items = buildTimeline({ messages: oneDay, currentUserId: ME, now: NOW });
    expect(items.every((i) => i.type !== 'message' || !i.pending)).toBe(true);
  });

  it('keeps a deleted message in place, so the conversation keeps its shape', () => {
    const items = buildTimeline({
      messages: [
        msg({ message_id: 'm1' }),
        msg({
          message_id: 'm2',
          body: '',
          created_at: localIso(2026, 9, 5, 10, 1),
          deleted_at: localIso(2026, 9, 5, 10, 5),
        }),
      ],
      currentUserId: ME,
      now: NOW,
    });
    expect(messageItem(items, 'm2').kind).toBe('text');
    expect(items.filter((i) => i.type === 'message')).toHaveLength(2);
  });
});

describe('canDeleteMessage / deletedMessageText', () => {
  it('lets me delete my own message, once', () => {
    expect(canDeleteMessage(msg({ sender_id: ME }), ME)).toBe(true);
    expect(
      canDeleteMessage(
        msg({ sender_id: ME, deleted_at: localIso(2026, 9, 5, 11, 0) }),
        ME
      )
    ).toBe(false);
  });

  it('offers no moderation path, not even to the group’s creator', () => {
    expect(canDeleteMessage(msg({ sender_id: OTHER }), ME)).toBe(false);
  });

  it('is false with nobody signed in', () => {
    expect(canDeleteMessage(msg({ sender_id: ME }), null)).toBe(false);
  });

  it('says what a deleted message reads as, and nothing for a live one', () => {
    expect(deletedMessageText(msg())).toBeNull();
    expect(
      deletedMessageText(msg({ body: '', deleted_at: localIso(2026, 9, 5, 11, 0) }))
    ).toBe('This message was deleted');
  });
});

describe('unreadBadge', () => {
  it('shows nothing when there is nothing unread', () => {
    expect(unreadBadge(0)).toBeNull();
    expect(unreadBadge(-3)).toBeNull();
    expect(unreadBadge(Number.NaN)).toBeNull();
  });

  it('counts up to 99 and caps after that', () => {
    expect(unreadBadge(1)).toBe('1');
    expect(unreadBadge(99)).toBe('99');
    expect(unreadBadge(100)).toBe('99+');
    expect(unreadBadge(4210)).toBe('99+');
  });

  it('never renders a fraction', () => {
    expect(unreadBadge(3.7)).toBe('3');
  });
});

describe('lastMessageLine', () => {
  it('names the sender from the roster the caller already holds', () => {
    expect(
      lastMessageLine({ last_body: 'see you at 4', last_sender_id: OTHER }, nameFor, ME)
    ).toBe('Chidi: see you at 4');
  });

  it('says "You" for my own last message', () => {
    expect(
      lastMessageLine({ last_body: 'on my way', last_sender_id: ME }, nameFor, ME)
    ).toBe('You: on my way');
  });

  it('falls back to the bare body when the name is unknown', () => {
    expect(
      lastMessageLine({ last_body: 'hello', last_sender_id: 'stranger' }, nameFor, ME)
    ).toBe('hello');
    expect(lastMessageLine({ last_body: 'hello', last_sender_id: null }, nameFor, ME)).toBe(
      'hello'
    );
  });

  it('renders empty for a group with no messages yet, so the caller can prompt', () => {
    expect(lastMessageLine({ last_body: null, last_sender_id: null }, nameFor, ME)).toBe('');
    expect(lastMessageLine({ last_body: '   ', last_sender_id: ME }, nameFor, ME)).toBe('');
  });

  it('names me like anyone else when no current user is given', () => {
    expect(lastMessageLine({ last_body: 'hi', last_sender_id: ME }, nameFor)).toBe('Ada: hi');
  });
});

describe('totalUnread / unreadSummary', () => {
  it('adds up only the groups that actually have something unread', () => {
    const rows = [{ unread_count: 3 }, { unread_count: 0 }, { unread_count: 1 }];
    expect(totalUnread(rows)).toBe(4);
    expect(unreadSummary(rows)).toBe('4 unread messages in 2 groups');
  });

  it('says nothing at all when nothing is unread', () => {
    expect(totalUnread([])).toBe(0);
    expect(unreadSummary([])).toBeNull();
    // The RPC returns a row per membership, so all-zero is the common case.
    expect(unreadSummary([{ unread_count: 0 }, { unread_count: 0 }])).toBeNull();
  });

  it('leaves the group out of the sentence when there is only one', () => {
    expect(unreadSummary([{ unread_count: 1 }])).toBe('1 unread message');
    expect(unreadSummary([{ unread_count: 7 }, { unread_count: 0 }])).toBe(
      '7 unread messages'
    );
  });

  it('does not cap, unlike the badge — this is prose, not a chip', () => {
    expect(unreadSummary([{ unread_count: 143 }, { unread_count: 8 }])).toBe(
      '151 unread messages in 2 groups'
    );
    expect(unreadBadge(151)).toBe('99+');
  });

  it('ignores a count that is negative, fractional or not a number', () => {
    const rows = [
      { unread_count: -4 },
      { unread_count: Number.NaN },
      { unread_count: 2.9 },
    ];
    expect(totalUnread(rows)).toBe(2);
    expect(unreadSummary(rows)).toBe('2 unread messages');
  });
});

describe('formatDuration', () => {
  it('reads naturally at every shape', () => {
    expect(formatDuration(SESSION_DURATION_MIN)).toBe('15 minutes');
    expect(formatDuration(1)).toBe('1 minute');
    expect(formatDuration(60)).toBe('1 hour');
    expect(formatDuration(90)).toBe('1 hour 30 minutes');
    expect(formatDuration(120)).toBe('2 hours');
    expect(formatDuration(SESSION_DURATION_MAX)).toBe('8 hours');
  });

  it('never renders a negative or empty length as nothing', () => {
    expect(formatDuration(0)).toBe('0 minutes');
    expect(formatDuration(-30)).toBe('0 minutes');
  });
});

describe('sessionWhenLabel', () => {
  it('reads "Today, 4pm – 6pm", ending where duration_min puts it', () => {
    expect(
      sessionWhenLabel(localIso(2026, 9, 5, 16, 0), 120, new Date(2026, 8, 5, 9, 0))
    ).toBe('Today, 4pm – 6pm');
  });

  it('labels a day that is neither today nor yesterday', () => {
    expect(
      sessionWhenLabel(localIso(2026, 9, 12, 9, 30), 45, new Date(2026, 8, 5, 9, 0))
    ).toBe('12 September, 9:30am – 10:15am');
  });

  it('returns empty for an unparseable start', () => {
    expect(sessionWhenLabel('sometime', 60)).toBe('');
  });
});

describe('isSessionPast', () => {
  const now = new Date(2026, 8, 5, 12, 0);
  const minutesAgo = (n: number) =>
    new Date(now.getTime() - n * 60_000).toISOString();

  it('keeps a session you are sitting in on screen', () => {
    expect(isSessionPast(minutesAgo(30), now)).toBe(false);
    expect(isSessionPast(minutesAgo(59), now)).toBe(false);
  });

  it('mirrors group_sessions exactly: past once the grace period has elapsed', () => {
    expect(isSessionPast(new Date(now.getTime() - SESSION_PAST_GRACE_MS).toISOString(), now)).toBe(
      false
    );
    expect(isSessionPast(minutesAgo(61), now)).toBe(true);
  });

  it('is not past when it has not started, or cannot be read', () => {
    expect(isSessionPast(minutesAgo(-30), now)).toBe(false);
    expect(isSessionPast('whenever', now)).toBe(false);
  });
});

describe('sessionRuleLabel', () => {
  it('states 0012’s rule in words, from the numbers the view supplies', () => {
    expect(sessionRuleLabel(3, 3)).toBe('Needs all 3'); // under four: everybody
    expect(sessionRuleLabel(5, 3)).toBe('Needs 3 of 5'); // four or more: a majority
    expect(sessionRuleLabel(4, 3)).toBe('Needs 3 of 4');
  });

  it('handles a group of one, and a view row that counted nobody', () => {
    expect(sessionRuleLabel(1, 1)).toBe('Needs just you');
    expect(sessionRuleLabel(0, 0)).toBe('Waiting on the group');
  });

  it('does not promise more yeses than there are people', () => {
    // A threshold above the count would read as unreachable; it is not.
    expect(sessionRuleLabel(3, 5)).toBe('Needs all 3');
  });
});

describe('yesStillNeeded', () => {
  it('counts down to the threshold while it is still proposed', () => {
    expect(yesStillNeeded(sessionRow({ yes_count: 1, confirm_threshold: 3 }))).toBe(2);
    expect(yesStillNeeded(sessionRow({ yes_count: 3, confirm_threshold: 3 }))).toBe(0);
  });

  it('is zero once the trigger has settled the session either way', () => {
    expect(
      yesStillNeeded(sessionRow({ status: 'confirmed', yes_count: 3, confirm_threshold: 3 }))
    ).toBe(0);
    expect(
      yesStillNeeded(sessionRow({ status: 'cancelled', yes_count: 0, confirm_threshold: 3 }))
    ).toBe(0);
  });

  it('never goes negative', () => {
    expect(yesStillNeeded(sessionRow({ yes_count: 9, confirm_threshold: 3 }))).toBe(0);
  });
});

describe('sessionTallyLabel', () => {
  it('reports progress towards the threshold', () => {
    expect(sessionTallyLabel(sessionRow({ yes_count: 2, confirm_threshold: 3 }))).toBe(
      '2 of 3 yes so far'
    );
  });

  it('mentions the noes only when there are some', () => {
    expect(
      sessionTallyLabel(sessionRow({ yes_count: 2, confirm_threshold: 3, no_count: 1 }))
    ).toBe('2 of 3 yes so far · 1 cannot');
  });

  it('stops counting once the session is settled', () => {
    expect(sessionTallyLabel(sessionRow({ status: 'confirmed', yes_count: 3 }))).toBe(
      'Confirmed · 3 yes'
    );
    expect(sessionTallyLabel(sessionRow({ status: 'cancelled', yes_count: 3 }))).toBe('Cancelled');
  });
});

describe('waitingOnLabel', () => {
  it('names the one person holding it up', () => {
    expect(
      waitingOnLabel([
        attendee({ user_id: 'u1', full_name: 'Ada', response: 'yes' }),
        attendee({ user_id: 'u2', full_name: 'Chidi', response: null }),
      ])
    ).toBe('Waiting on Chidi');
  });

  it('names both when there are two', () => {
    expect(
      waitingOnLabel([
        attendee({ user_id: 'u1', full_name: 'Ada' }),
        attendee({ user_id: 'u2', full_name: 'Chidi' }),
      ])
    ).toBe('Waiting on Ada and Chidi');
  });

  it('counts the rest beyond the first once there are three or more', () => {
    expect(
      waitingOnLabel([
        attendee({ user_id: 'u1', full_name: 'Ada' }),
        attendee({ user_id: 'u2', full_name: 'Chidi' }),
        attendee({ user_id: 'u3', full_name: 'Bisi' }),
      ])
    ).toBe('Waiting on Ada and 2 others');
  });

  it('says nothing once everybody has answered', () => {
    expect(
      waitingOnLabel([
        attendee({ response: 'yes' }),
        attendee({ user_id: 'u2', response: 'no' }),
        attendee({ user_id: 'u3', response: 'maybe' }),
      ])
    ).toBe('');
    expect(waitingOnLabel([])).toBe('');
  });

  it('still names a member with no profile name', () => {
    expect(waitingOnLabel([attendee({ full_name: null })])).toBe('Waiting on Unnamed student');
    expect(waitingOnLabel([attendee({ full_name: '   ' })])).toBe('Waiting on Unnamed student');
  });

  it('treats every real response value as an answer', () => {
    for (const response of ALL_RESPONSES) {
      expect(waitingOnLabel([attendee({ response })])).toBe('');
    }
  });
});

describe('canCancelSession', () => {
  it('allows the proposer and the group’s creator', () => {
    expect(canCancelSession(sessionRow({ proposed_by: ME }), ME, false)).toBe(true);
    expect(canCancelSession(sessionRow({ proposed_by: OTHER }), ME, true)).toBe(true);
  });

  it('refuses anybody else in the group', () => {
    expect(canCancelSession(sessionRow({ proposed_by: OTHER }), ME, false)).toBe(false);
    expect(canCancelSession(sessionRow({ proposed_by: OTHER }), null, true)).toBe(false);
  });

  it('still allows cancelling a confirmed session', () => {
    expect(
      canCancelSession(sessionRow({ status: 'confirmed', proposed_by: ME }), ME, false)
    ).toBe(true);
  });

  it('treats cancelled as terminal — an uncancel is a new proposal', () => {
    expect(
      canCancelSession(sessionRow({ status: 'cancelled', proposed_by: ME }), ME, true)
    ).toBe(false);
  });
});

describe('canRespondToSession', () => {
  const now = new Date(2026, 8, 5, 12, 0);
  const future = localIso(2026, 9, 6, 16, 0);

  it('accepts a tap while the session is live', () => {
    expect(canRespondToSession(sessionRow({ starts_at: future }), now)).toBe(true);
    expect(
      canRespondToSession(sessionRow({ status: 'confirmed', starts_at: future }), now)
    ).toBe(true);
  });

  it('refuses once it is cancelled', () => {
    expect(
      canRespondToSession(sessionRow({ status: 'cancelled', starts_at: future }), now)
    ).toBe(false);
  });

  it('follows the same one-hour grace as the view', () => {
    const halfAnHourIn = new Date(now.getTime() - 30 * 60_000).toISOString();
    const yesterday = localIso(2026, 9, 4, 16, 0);
    expect(canRespondToSession(sessionRow({ starts_at: halfAnHourIn }), now)).toBe(true);
    expect(canRespondToSession(sessionRow({ starts_at: yesterday }), now)).toBe(false);
  });
});

describe('validateSessionProposal', () => {
  const now = new Date(2026, 8, 5, 12, 0);
  const future = localIso(2026, 9, 6, 16, 0);

  it('accepts a future start of a legal length', () => {
    expect(validateSessionProposal({ startsAt: future, durationMin: 120, now })).toBeNull();
  });

  it('refuses a start that is not in the future, as propose_session does', () => {
    expect(
      validateSessionProposal({
        startsAt: localIso(2026, 9, 5, 9, 0),
        durationMin: 60,
        now,
      })
    ).toBe('Pick a start time in the future');
    // p_starts_at <= now() is refused, so "right now" is not a valid start either.
    expect(
      validateSessionProposal({ startsAt: now.toISOString(), durationMin: 60, now })
    ).toBe('Pick a start time in the future');
  });

  it('refuses a date it cannot read', () => {
    expect(
      validateSessionProposal({ startsAt: 'tomorrow-ish', durationMin: 60, now })
    ).toBe('Pick a date and time');
  });

  it('mirrors the duration CHECK at both ends', () => {
    const tooLong = 'A session has to be between 15 minutes and 8 hours long';
    expect(
      validateSessionProposal({ startsAt: future, durationMin: SESSION_DURATION_MIN, now })
    ).toBeNull();
    expect(
      validateSessionProposal({ startsAt: future, durationMin: SESSION_DURATION_MAX, now })
    ).toBeNull();
    expect(
      validateSessionProposal({
        startsAt: future,
        durationMin: SESSION_DURATION_MIN - 1,
        now,
      })
    ).toBe(tooLong);
    expect(
      validateSessionProposal({
        startsAt: future,
        durationMin: SESSION_DURATION_MAX + 1,
        now,
      })
    ).toBe(tooLong);
    expect(
      validateSessionProposal({ startsAt: future, durationMin: Number.NaN, now })
    ).toBe(tooLong);
  });

  it('mirrors the location CHECK, measured trimmed, and allows none at all', () => {
    const at = (location: string | null) =>
      validateSessionProposal({ startsAt: future, durationMin: 60, location, now });
    expect(at('x'.repeat(SESSION_LOCATION_MAX))).toBeNull();
    expect(at(`  ${'x'.repeat(SESSION_LOCATION_MAX)}  `)).toBeNull();
    expect(at('x'.repeat(SESSION_LOCATION_MAX + 1))).toBe(
      `Keep the location under ${SESSION_LOCATION_MAX} characters`
    );
    expect(at(null)).toBeNull();
    expect(at('')).toBeNull();
    expect(validateSessionProposal({ startsAt: future, durationMin: 60, now })).toBeNull();
  });

  it('bounds the note by a message body, since that is what it becomes', () => {
    // propose_session writes the note as the timeline message's body, so the
    // limit that catches it is messages_body_shape — not a limit of its own.
    const at = (note: string | null) =>
      validateSessionProposal({ startsAt: future, durationMin: 60, note, now });
    expect(at('Library, ground floor')).toBeNull();
    expect(at('x'.repeat(MESSAGE_MAX_LENGTH))).toBeNull();
    expect(at(`  ${'x'.repeat(MESSAGE_MAX_LENGTH)}  `)).toBeNull();
    expect(at('x'.repeat(MESSAGE_MAX_LENGTH + 1))).toBe(
      `Keep the note under ${MESSAGE_MAX_LENGTH} characters`
    );
    // Blank is legal: the RPC substitutes "Proposed a study session".
    expect(at('')).toBeNull();
    expect(at('   ')).toBeNull();
    expect(at(null)).toBeNull();
  });
});

describe('formatTimeOfDay', () => {
  it('words a time of day exactly as formatClock words an instant', () => {
    // The picker chip and the message timestamp must not disagree about 4pm.
    expect(formatTimeOfDay(16 * 60)).toBe('4pm');
    expect(formatTimeOfDay(9 * 60 + 30)).toBe('9:30am');
    expect(formatTimeOfDay(12 * 60)).toBe('12pm');
    expect(formatTimeOfDay(0)).toBe('12am');
    expect(formatTimeOfDay(16 * 60 + 5)).toBe(
      formatClock(localIso(2026, 9, 5, 16, 5))
    );
  });

  it('wraps rather than rendering a 25th hour', () => {
    expect(formatTimeOfDay(1440)).toBe('12am');
    expect(formatTimeOfDay(-30)).toBe('11:30pm');
  });
});

describe('proposalDayOptions', () => {
  const now = new Date(2026, 8, 20, 15, 0); // 20 September 2026, local

  it('starts at today and runs two weeks out, labelled for a human', () => {
    const options = proposalDayOptions(now);
    expect(options).toHaveLength(PROPOSAL_DAYS_AHEAD);
    expect(options[0]).toEqual({ dayKey: '2026-09-20', label: 'Today' });
    expect(options[1]).toEqual({ dayKey: '2026-09-21', label: 'Tomorrow' });
    expect(options[2]).toEqual({ dayKey: '2026-09-22', label: '22 September' });
    expect(options[13].dayKey).toBe('2026-10-03');
  });

  it('steps by calendar date, not by 24 hours', () => {
    // The reason this walks Y/M/D components: adding 86,400,000ms across a DST
    // change repeats or skips a day, and a picker that offers Monday twice is
    // worse than one that offers no Sunday.
    const keys = proposalDayOptions(now, 14).map((o) => o.dayKey);
    expect(new Set(keys).size).toBe(14);
    for (let i = 1; i < keys.length; i += 1) {
      expect(keys[i] > keys[i - 1]).toBe(true);
    }
  });

  it('crosses a month and a year boundary without a gap', () => {
    expect(proposalDayOptions(new Date(2026, 7, 30, 9, 0), 3).map((o) => o.dayKey)).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
    ]);
    expect(proposalDayOptions(new Date(2026, 11, 31, 9, 0), 2).map((o) => o.dayKey)).toEqual([
      '2026-12-31',
      '2027-01-01',
    ]);
  });

  it('always offers today, however few days are asked for', () => {
    expect(proposalDayOptions(now, 0)).toHaveLength(1);
    expect(proposalDayOptions(now, -5)[0].label).toBe('Today');
  });
});

describe('proposalTimeOptions', () => {
  it('covers the study day at half-hour steps, inclusive of both ends', () => {
    const options = proposalTimeOptions();
    expect(options[0]).toEqual({ minutes: PROPOSAL_FIRST_HOUR * 60, label: '6am' });
    expect(options[options.length - 1]).toEqual({
      minutes: PROPOSAL_LAST_HOUR * 60,
      label: '10pm',
    });
    expect(options).toHaveLength(
      ((PROPOSAL_LAST_HOUR - PROPOSAL_FIRST_HOUR) * 60) / PROPOSAL_STEP_MIN + 1
    );
  });

  it('is strictly increasing, so the grid reads in order', () => {
    const minutes = proposalTimeOptions().map((o) => o.minutes);
    for (let i = 1; i < minutes.length; i += 1) {
      expect(minutes[i] - minutes[i - 1]).toBe(PROPOSAL_STEP_MIN);
    }
  });
});

describe('SESSION_DURATION_CHOICES', () => {
  it('offers nothing the RPC would refuse', () => {
    for (const minutes of SESSION_DURATION_CHOICES) {
      expect(minutes).toBeGreaterThanOrEqual(SESSION_DURATION_MIN);
      expect(minutes).toBeLessThanOrEqual(SESSION_DURATION_MAX);
      expect(formatDuration(minutes).length).toBeGreaterThan(0);
    }
  });
});

describe('combineLocalDateTime', () => {
  it('reads the chips back as the local wall-clock time they named', () => {
    // Compared against a locally built Date rather than a 'Z' string: the point
    // of this function is that 4pm means 4pm where the student is standing.
    expect(combineLocalDateTime('2026-09-21', 16 * 60)).toBe(
      localIso(2026, 9, 21, 16, 0)
    );
    expect(combineLocalDateTime('2026-09-21', 9 * 60 + 30)).toBe(
      localIso(2026, 9, 21, 9, 30)
    );
  });

  it('round-trips through the labels the card will render', () => {
    const now = new Date(2026, 8, 20, 15, 0);
    const iso = combineLocalDateTime('2026-09-21', 16 * 60);
    expect(localDayKey(iso)).toBe('2026-09-21');
    expect(formatClock(iso)).toBe('4pm');
    expect(sessionWhenLabel(iso, 120, now)).toBe('Tomorrow, 4pm – 6pm');
  });

  it('produces something validateSessionProposal accepts', () => {
    const now = new Date(2026, 8, 20, 15, 0);
    expect(
      validateSessionProposal({
        startsAt: combineLocalDateTime('2026-09-21', 16 * 60),
        durationMin: 120,
        now,
      })
    ).toBeNull();
  });

  it('returns empty for a malformed key instead of an Invalid Date', () => {
    expect(combineLocalDateTime('', 600)).toBe('');
    expect(combineLocalDateTime('rubbish', 600)).toBe('');
    expect(combineLocalDateTime('2026-09', 600)).toBe('');
  });

  it('clamps a nonsense time of day rather than shifting the date', () => {
    expect(combineLocalDateTime('2026-09-21', -60)).toBe(localIso(2026, 9, 21, 0, 0));
  });
});

describe('isProposalSlotPast', () => {
  const now = new Date(2026, 8, 20, 15, 0); // 20 September 2026, 3pm local

  it('greys out what has been and gone today, and now itself', () => {
    expect(isProposalSlotPast('2026-09-20', 9 * 60, now)).toBe(true);
    expect(isProposalSlotPast('2026-09-20', 15 * 60, now)).toBe(true);
    expect(isProposalSlotPast('2026-09-20', 15 * 60 + 30, now)).toBe(false);
  });

  it('leaves every later day alone', () => {
    expect(isProposalSlotPast('2026-09-21', 6 * 60, now)).toBe(false);
  });

  it('agrees with validateSessionProposal about the same slot', () => {
    // Two ways of saying the same thing, so the chip cannot be tappable while
    // the form refuses it — or greyed out while the form would have taken it.
    for (const [dayKey, minutes] of [
      ['2026-09-20', 9 * 60],
      ['2026-09-20', 15 * 60],
      ['2026-09-20', 20 * 60],
      ['2026-09-21', 6 * 60],
    ] as const) {
      const startsAt = combineLocalDateTime(dayKey, minutes);
      const refused =
        validateSessionProposal({ startsAt, durationMin: 60, now }) !== null;
      expect(isProposalSlotPast(dayKey, minutes, now)).toBe(refused);
    }
  });

  it('says nothing is past when the key cannot be read', () => {
    expect(isProposalSlotPast('', 600, now)).toBe(false);
  });
});

describe('firstOpenProposalSlot', () => {
  it('opens on the next slot still to come today', () => {
    const at = firstOpenProposalSlot(new Date(2026, 8, 20, 15, 0));
    expect(at).toEqual({ dayKey: '2026-09-20', minutes: 15 * 60 + 30 });
  });

  it('opens on the first slot of the day when the day has not started', () => {
    const at = firstOpenProposalSlot(new Date(2026, 8, 20, 4, 0));
    expect(at).toEqual({ dayKey: '2026-09-20', minutes: PROPOSAL_FIRST_HOUR * 60 });
  });

  it('rolls onto tomorrow once today is spent', () => {
    // 11pm: every chip on today is behind us, so opening on one would show a
    // greyed slot with the form already refusing it.
    const at = firstOpenProposalSlot(new Date(2026, 8, 20, 23, 0));
    expect(at).toEqual({ dayKey: '2026-09-21', minutes: PROPOSAL_FIRST_HOUR * 60 });
  });

  it('always names a slot the grid itself offers, and one the form accepts', () => {
    for (const now of [
      new Date(2026, 8, 20, 5, 59),
      new Date(2026, 8, 20, 15, 1),
      new Date(2026, 8, 20, 21, 59),
      new Date(2026, 11, 31, 23, 45), // and across a year boundary
    ]) {
      const at = firstOpenProposalSlot(now);
      expect(proposalDayOptions(now).map((d) => d.dayKey)).toContain(at.dayKey);
      expect(proposalTimeOptions().map((t) => t.minutes)).toContain(at.minutes);
      expect(
        validateSessionProposal({
          startsAt: combineLocalDateTime(at.dayKey, at.minutes),
          durationMin: 60,
          now,
        })
      ).toBeNull();
    }
  });
});

describe('formatFileSize', () => {
  it('renders the 25 MB ceiling as exactly what the error message promises', () => {
    // Binary units, or the limit reads back as 26.2 MB and the copy is a lie.
    expect(formatFileSize(MATERIALS_MAX_BYTES)).toBe('25 MB');
  });

  it('keeps bytes whole and larger units to one decimal', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(812)).toBe('812 B');
    expect(formatFileSize(1023)).toBe('1023 B');
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(25_088)).toBe('24.5 KB');
    expect(formatFileSize(1024 * 1024)).toBe('1 MB');
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1 GB');
  });

  it('renders nothing it cannot measure', () => {
    expect(formatFileSize(-1)).toBe('');
    expect(formatFileSize(Number.NaN)).toBe('');
  });
});

describe('fileExtension', () => {
  it('lowercases, drops the dot, and takes only the last one', () => {
    expect(fileExtension('notes.pdf')).toBe('pdf');
    expect(fileExtension('NOTES.PDF')).toBe('pdf');
    expect(fileExtension('lecture.tar.gz')).toBe('gz');
    expect(fileExtension('  spaced.txt  ')).toBe('txt');
  });

  it('ignores any folders the picker hands over with the name', () => {
    expect(fileExtension('C:\\Users\\me\\notes.docx')).toBe('docx');
    expect(fileExtension('/storage/emulated/0/notes.docx')).toBe('docx');
  });

  it('finds nothing when there is no extension to find', () => {
    expect(fileExtension('README')).toBe('');
    expect(fileExtension('.env')).toBe(''); // a dotfile is not an extension
    expect(fileExtension('trailing.')).toBe('');
    expect(fileExtension('')).toBe('');
  });
});

describe('fileKind', () => {
  it('reads the MIME type first', () => {
    expect(fileKind('application/pdf')).toBe('pdf');
    expect(fileKind('APPLICATION/PDF')).toBe('pdf');
    expect(fileKind('image/png')).toBe('image');
    expect(fileKind('audio/mpeg')).toBe('audio');
    expect(fileKind('video/mp4')).toBe('video');
    expect(fileKind('text/plain')).toBe('text');
  });

  it('recognises the office family by substring, whichever suite wrote it', () => {
    expect(
      fileKind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    ).toBe('sheet');
    expect(fileKind('application/vnd.ms-excel')).toBe('sheet');
    expect(
      fileKind('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    ).toBe('slides');
    expect(fileKind('application/msword')).toBe('doc');
    expect(fileKind('application/vnd.oasis.opendocument.text')).toBe('doc');
    expect(fileKind('application/zip')).toBe('archive');
  });

  it('falls back to the extension for octet-stream, which pickers hand over often', () => {
    expect(fileKind('application/octet-stream', 'lecture-3.pdf')).toBe('pdf');
    expect(fileKind('application/octet-stream', 'data.csv')).toBe('sheet');
    expect(fileKind('application/octet-stream', 'mystery.qqq')).toBe('file');
    expect(fileKind('application/octet-stream')).toBe('file');
  });
});

describe('validateUpload', () => {
  const upload = (over: Partial<Parameters<typeof validateUpload>[0]> = {}) =>
    validateUpload({
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      ...over,
    });

  it('accepts an ordinary file', () => {
    expect(upload()).toBeNull();
  });

  it('accepts the size CHECK’s own boundaries, both ends inclusive', () => {
    expect(upload({ sizeBytes: 1 })).toBeNull();
    expect(upload({ sizeBytes: MATERIALS_MAX_BYTES })).toBeNull();
  });

  it('refuses one byte past the limit, before the bytes go anywhere', () => {
    expect(upload({ sizeBytes: MATERIALS_MAX_BYTES + 1 })).toBe(
      'Files have to be under 25 MB'
    );
  });

  it('refuses an empty or unmeasurable file', () => {
    expect(upload({ sizeBytes: 0 })).toBe('That file is empty');
    expect(upload({ sizeBytes: Number.NaN })).toBe('That file is empty');
  });

  it('mirrors the file_name CHECK: 1 to 255 characters, trimmed', () => {
    expect(upload({ fileName: 'x'.repeat(FILE_NAME_MAX_LENGTH) })).toBeNull();
    const named = `That file needs a name, under ${FILE_NAME_MAX_LENGTH} characters`;
    expect(upload({ fileName: 'x'.repeat(FILE_NAME_MAX_LENGTH + 1) })).toBe(named);
    expect(upload({ fileName: '' })).toBe(named);
    expect(upload({ fileName: '   ' })).toBe(named);
  });

  it('refuses a file with no MIME type, which the CHECK also requires', () => {
    expect(upload({ mimeType: '' })).toBe('That file has no type, so it cannot be shared');
    expect(upload({ mimeType: '  ' })).toBe('That file has no type, so it cannot be shared');
  });
});

describe('safePathSegment', () => {
  it('leaves an ordinary name alone', () => {
    expect(safePathSegment('lecture 3 notes.pdf')).toBe('lecture 3 notes.pdf');
  });

  it('collapses anything that would change the path’s shape', () => {
    expect(safePathSegment('sub/dir/notes.pdf')).toBe('sub_dir_notes.pdf');
    expect(safePathSegment('a//b')).toBe('a_b');
    expect(safePathSegment('a\\b')).toBe('a_b');
  });

  it('cannot be talked into climbing out of its own folder', () => {
    const escaped = safePathSegment('../../etc/passwd');
    expect(escaped).not.toContain('/');
    expect(escaped).not.toContain('\\');
    expect(escaped.startsWith('.')).toBe(false);
  });

  it('strips control characters, which Storage rejects outright', () => {
    expect(safePathSegment('a\u0000b\u001fc\u007f.txt')).toBe('abc.txt');
  });

  it('trims to the same 255 characters the file_name CHECK allows', () => {
    expect(safePathSegment('x'.repeat(300))).toHaveLength(FILE_NAME_MAX_LENGTH);
  });

  it('always returns something, because the path needs a last segment', () => {
    expect(safePathSegment('   ')).toBe('file');
    expect(safePathSegment('...')).toBe('file');
    expect(safePathSegment('')).toBe('file');
  });
});

describe('materialStoragePath', () => {
  it('is the path attach_material demands: group, material, then the name', () => {
    expect(materialStoragePath('g1', 'mat1', 'notes.pdf')).toBe('g1/mat1/notes.pdf');
  });

  it('stays exactly three segments however the file was named', () => {
    for (const name of ['notes.pdf', 'sub/dir/notes.pdf', '../../passwd', '   ']) {
      const path = materialStoragePath('g1', 'mat1', name);
      expect(path.split('/')).toHaveLength(3);
      expect(path.startsWith('g1/mat1/')).toBe(true);
      expect(path.length).toBeGreaterThan('g1/mat1/'.length);
    }
  });
});

describe('canDeleteMaterial / canDownloadMaterial / materialStateLabel', () => {
  it('lets whoever shared it, or the group’s creator, remove it', () => {
    expect(canDeleteMaterial(materialRow({ uploaded_by: ME }), ME, false)).toBe(true);
    expect(canDeleteMaterial(materialRow({ uploaded_by: OTHER }), ME, true)).toBe(true);
  });

  it('refuses anybody else, and anybody not signed in', () => {
    expect(canDeleteMaterial(materialRow({ uploaded_by: OTHER }), ME, false)).toBe(false);
    expect(canDeleteMaterial(materialRow({ uploaded_by: ME }), null, true)).toBe(false);
  });

  it('is idempotent about an already-removed file, as delete_material is', () => {
    const gone = materialRow({
      uploaded_by: ME,
      deleted_at: localIso(2026, 9, 5, 11, 0),
      deleted_by: ME,
    });
    expect(canDeleteMaterial(gone, ME, true)).toBe(false);
  });

  it('revokes the download for everybody once it is removed, uploader included', () => {
    expect(canDownloadMaterial(materialRow())).toBe(true);
    expect(
      canDownloadMaterial(materialRow({ deleted_at: localIso(2026, 9, 5, 11, 0) }))
    ).toBe(false);
  });

  it('explains the gap in the files tab instead of leaving one', () => {
    expect(materialStateLabel(materialRow())).toBe('');
    expect(
      materialStateLabel(
        materialRow({ deleted_at: localIso(2026, 9, 5, 11, 0), deleted_by: OTHER }),
        nameFor
      )
    ).toBe('Removed by Chidi');
  });

  it('says only "Removed" when the name is not to hand', () => {
    const gone = materialRow({ deleted_at: localIso(2026, 9, 5, 11, 0), deleted_by: OTHER });
    expect(materialStateLabel(gone)).toBe('Removed');
    expect(materialStateLabel(gone, () => null)).toBe('Removed');
    expect(materialStateLabel({ deleted_at: localIso(2026, 9, 5, 11, 0), deleted_by: null })).toBe(
      'Removed'
    );
  });
});

describe('MATERIALS_ALLOWED_MIME_TYPES', () => {
  it('is the fifteen types the bucket allows in 0017', () => {
    expect(MATERIALS_ALLOWED_MIME_TYPES).toHaveLength(15);
    expect(MATERIALS_ALLOWED_MIME_TYPES).toContain('application/pdf');
    expect(MATERIALS_ALLOWED_MIME_TYPES).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(MATERIALS_ALLOWED_MIME_TYPES).toContain('application/zip');
  });

  it('holds bare lowercase types, since that is what Storage compares', () => {
    for (const mime of MATERIALS_ALLOWED_MIME_TYPES) {
      expect(mime).toBe(mime.toLowerCase().trim());
      expect(mime).not.toContain(';');
      expect(mime.split('/')).toHaveLength(2);
    }
  });

  it('never offers a type the bucket would reject', () => {
    // The picker is handed this array as its filter, so anything in it that
    // Storage does not take is a file a student can choose and then fail to
    // upload. `uploadMimeType` is the same list, so it must accept all of it.
    for (const mime of MATERIALS_ALLOWED_MIME_TYPES) {
      expect(uploadMimeType(mime, 'whatever.bin')).toBe(mime);
    }
  });
});

describe('uploadMimeType', () => {
  it('takes the picker at its word when the bucket allows the type', () => {
    expect(uploadMimeType('application/pdf', 'notes.pdf')).toBe('application/pdf');
    expect(uploadMimeType('image/png', 'diagram.png')).toBe('image/png');
  });

  it('normalises case, padding and a charset parameter', () => {
    expect(uploadMimeType('  Application/PDF  ', 'notes.pdf')).toBe('application/pdf');
    expect(uploadMimeType('text/plain; charset=utf-8', 'notes.txt')).toBe('text/plain');
    expect(uploadMimeType('TEXT/CSV;charset=UTF-8', 'marks.csv')).toBe('text/csv');
  });

  it('corrects the octet-stream an Android picker reports for a real PDF', () => {
    expect(uploadMimeType('application/octet-stream', 'lecture-3.pdf')).toBe('application/pdf');
    expect(uploadMimeType('application/octet-stream', 'week1.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
  });

  it('falls back to the extension when the picker reported nothing at all', () => {
    // `DocumentPickerAsset.mimeType` is optional, so both of these happen.
    expect(uploadMimeType(undefined, 'slides.pptx')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    );
    expect(uploadMimeType(null, 'photo.JPEG')).toBe('image/jpeg');
    expect(uploadMimeType('', 'sheet.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
  });

  it('refuses rather than guessing when neither the type nor the name is allowed', () => {
    expect(uploadMimeType('video/mp4', 'clip.mp4')).toBeNull();
    expect(uploadMimeType('application/octet-stream', 'mystery')).toBeNull();
    expect(uploadMimeType('application/x-rar-compressed', 'notes.rar')).toBeNull();
    expect(uploadMimeType(undefined, '')).toBeNull();
  });

  it('is stricter than fileKind, which only has an icon riding on it', () => {
    // fileKind maps .mp4 to a family happily; the bucket has no type for it, so
    // the upload must never start.
    expect(fileKind('video/mp4', 'clip.mp4')).toBe('video');
    expect(uploadMimeType('video/mp4', 'clip.mp4')).toBeNull();
  });
});

describe('sharedFileBody', () => {
  it('mirrors the SQL default when no note was typed', () => {
    expect(sharedFileBody(null, 'lecture-3.pdf')).toBe('Shared lecture-3.pdf');
    expect(sharedFileBody(undefined, 'lecture-3.pdf')).toBe('Shared lecture-3.pdf');
    expect(sharedFileBody('', 'lecture-3.pdf')).toBe('Shared lecture-3.pdf');
    expect(sharedFileBody('   \n  ', 'lecture-3.pdf')).toBe('Shared lecture-3.pdf');
  });

  it('uses the note, trimmed, exactly as btrim would', () => {
    expect(sharedFileBody('  week 3 notes  ', 'lecture-3.pdf')).toBe('week 3 notes');
  });

  it('trims the file name too, because attach_material stores it trimmed', () => {
    expect(sharedFileBody(null, '  lecture-3.pdf ')).toBe('Shared lecture-3.pdf');
  });

  it('produces a body validateMessageBody would accept', () => {
    // The RPC writes this straight into `messages.body`, so a name at the 255
    // limit must not overflow the column's own bound.
    const body = sharedFileBody(null, 'x'.repeat(FILE_NAME_MAX_LENGTH));
    expect(validateMessageBody(body)).toBeNull();
  });
});

describe('materialNote', () => {
  it('drops the default body, which would print the file name twice', () => {
    expect(materialNote('Shared lecture-3.pdf', 'lecture-3.pdf')).toBeNull();
  });

  it('keeps a real note', () => {
    expect(materialNote('week 3 notes', 'lecture-3.pdf')).toBe('week 3 notes');
  });

  it('keeps a note that merely starts the same way as the default', () => {
    expect(materialNote('Shared this one already, sorry', 'lecture-3.pdf')).toBe(
      'Shared this one already, sorry'
    );
    expect(materialNote('Shared lecture-3.pdf earlier too', 'lecture-3.pdf')).toBe(
      'Shared lecture-3.pdf earlier too'
    );
  });

  it('round-trips whatever sharedFileBody produced', () => {
    // The two are used together: one builds the body the RPC writes, the other
    // reads it back, so a default must always come back as null and a note as
    // itself.
    expect(materialNote(sharedFileBody(null, 'a.pdf'), 'a.pdf')).toBeNull();
    expect(materialNote(sharedFileBody('  hello  ', 'a.pdf'), 'a.pdf')).toBe('hello');
  });

  it('says nothing rather than printing whitespace', () => {
    expect(materialNote('', 'a.pdf')).toBeNull();
    expect(materialNote('   ', 'a.pdf')).toBeNull();
  });
});

describe('materialWhenLabel', () => {
  const now = new Date(2026, 8, 20, 15, 0); // 20 September 2026, local

  it('keeps the clock for today and yesterday', () => {
    // The files tab has no day separators, so the day has to be in the row —
    // and for something this recent the time of day is still worth knowing.
    expect(materialWhenLabel(localIso(2026, 9, 20, 16, 5), now)).toBe('Today · 4:05pm');
    expect(materialWhenLabel(localIso(2026, 9, 19, 8, 0), now)).toBe('Yesterday · 8am');
  });

  it('drops the clock for anything older', () => {
    expect(materialWhenLabel(localIso(2026, 9, 5, 16, 5), now)).toBe('5 September');
    expect(materialWhenLabel(localIso(2026, 9, 18, 23, 59), now)).toBe('18 September');
  });

  it('keeps the year once the file is from another one', () => {
    expect(materialWhenLabel(localIso(2025, 11, 30, 9, 0), now)).toBe('30 November 2025');
  });

  it('crosses a year boundary to find yesterday', () => {
    expect(
      materialWhenLabel(localIso(2025, 12, 31, 21, 30), new Date(2026, 0, 1, 9, 0))
    ).toBe('Yesterday · 9:30pm');
  });

  it('renders nothing for an unparseable instant, rather than "Invalid Date"', () => {
    // A bad row should cost its own row's timestamp and nothing else — the card
    // renders an empty string in the corner and the file is still downloadable.
    expect(materialWhenLabel('not a date', now)).toBe('');
    expect(materialWhenLabel('', now)).toBe('');
  });
});

