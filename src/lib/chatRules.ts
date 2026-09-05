import { MATERIALS_MAX_BYTES } from '@/types/database';
import type {
  GroupMaterialRow,
  GroupSessionRow,
  Message,
  MessageKind,
  SessionResponseValue,
  SessionStatus,
  UnreadCountRow,
} from '@/types/database';

/**
 * Pure presentation and permission logic for the group timeline.
 *
 * Same split, and the same reason, as `groupRules.ts`: the rules below are
 * enforced by the Stage 3 and Stage 4 RPCs, and the screen needs the same
 * answers to decide what to render. Written inline across a chat screen, three
 * card renderers and a files tab, they would drift from the SQL within a
 * session. Here they are pure functions over plain rows, so a test notices.
 *
 * DISPLAY ONLY. Every permission check here is re-checked by the RPC that
 * performs the action; a stale client must never be the thing standing between
 * a student and a rule — nor the thing enforcing one.
 *
 * Dates: every label is computed in the DEVICE's local timezone. `created_at`
 * and `starts_at` arrive as UTC ISO strings, and a day separator that says
 * "Today" has to mean the student's today. No `Intl` anywhere — Hermes on
 * Android has shipped without it, and a formatter that throws on one platform
 * is worse than a hand-rolled one that reads the same everywhere.
 */

// ---------------------------------------------------------------------------
// What you type (messages_body_shape, 0013)
// ---------------------------------------------------------------------------

/** `length(btrim(body)) between 1 and 2000` — the CHECK, mirrored exactly. */
export const MESSAGE_MAX_LENGTH = 2000;

/** What actually goes on the wire: the trimmed body, as the CHECK measures it. */
export function normaliseMessageBody(body: string): string {
  return body.trim();
}

/**
 * Null when the body is sendable, else the reason.
 *
 * Bounds mirror the SQL rather than being merely stricter, because a body the
 * client accepts and Postgres rejects fails after the round trip — and offline,
 * not until the queue drains, long after the student has moved on.
 */
export function validateMessageBody(body: string): string | null {
  const trimmed = normaliseMessageBody(body);
  if (trimmed.length === 0) return 'Type something first';
  if (trimmed.length > MESSAGE_MAX_LENGTH) {
    return `Messages are up to ${MESSAGE_MAX_LENGTH} characters`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ordering and merging
// ---------------------------------------------------------------------------

/**
 * Newest first, `message_id` descending as the tiebreak.
 *
 * The same order as the index the server pages by — `(group_id, created_at
 * desc, message_id desc)` in 0013 — and the tiebreak is the point of it.
 * `created_at` is not unique: two members on a fast connection can land in the
 * same millisecond, and `now()` is fixed for a whole transaction. Without a
 * second key those two messages swap places between renders, and a keyset
 * cursor built on the timestamp alone loses whichever one sits on the page
 * boundary.
 */
export function compareMessagesNewestFirst(a: Message, b: Message): number {
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? 1 : -1;
  }
  if (a.message_id === b.message_id) return 0;
  return a.message_id < b.message_id ? 1 : -1;
}

/**
 * Fold `incoming` into `current`, de-duped by `message_id`, newest first.
 *
 * Incoming wins, which is what makes every path through the screen the same
 * operation: the first page, an older page, a Realtime insert landing on top of
 * its own optimistic bubble, a Realtime update carrying a soft delete, and the
 * optimistic bubble itself. The server row replacing the local one is not a
 * special case — it is a row with an id the list already holds, and the newer
 * copy is the truer one.
 *
 * This is why `message_id` is generated on the device (0013). Without a shared
 * identity, de-duping an echo means guessing from the body and a timestamp,
 * which double-renders anyone who sends the same word twice.
 */
export function upsertMessages(
  current: readonly Message[],
  incoming: readonly Message[]
): Message[] {
  if (incoming.length === 0) return [...current];
  const byId = new Map<string, Message>();
  for (const m of current) byId.set(m.message_id, m);
  for (const m of incoming) byId.set(m.message_id, m);
  return [...byId.values()].sort(compareMessagesNewestFirst);
}

/** Where the next (older) page starts. Null when there is nothing loaded yet. */
export interface MessageCursor {
  created_at: string;
  message_id: string;
}

/**
 * The keyset cursor for `loadOlder()`: the oldest message currently held.
 *
 * Both columns, because both are needed — see the comparator. A fetch that asks
 * only for `created_at < cursor` silently drops every other message sharing that
 * exact timestamp, and the one it drops is invisible: it never appears in either
 * page, so the gap looks like nothing happened.
 */
export function nextPageCursor(
  messages: readonly Message[]
): MessageCursor | null {
  if (messages.length === 0) return null;
  let oldest = messages[0];
  for (const m of messages) {
    if (compareMessagesNewestFirst(m, oldest) > 0) oldest = m;
  }
  return { created_at: oldest.created_at, message_id: oldest.message_id };
}

// ---------------------------------------------------------------------------
// Dates, in the student's own timezone
// ---------------------------------------------------------------------------

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The local calendar day an instant falls in, as `YYYY-MM-DD`.
 *
 * Local, not UTC, and that is the whole reason this function exists: a message
 * sent at 00:30 in Lagos is 23:30 the previous day in UTC, so grouping by the
 * ISO string's date part puts it under yesterday's separator. Returns '' for an
 * unparseable value so a bad row renders without a separator rather than
 * crashing the list.
 */
export function localDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/**
 * A day separator's text: "Today", "Yesterday", "5 September", or with the year
 * once the day is outside the current one.
 *
 * `now` is injected rather than read from the clock so the boundary cases are
 * testable — and so a screen left open across midnight can rebuild against a
 * fresh `now` instead of insisting it is still yesterday.
 */
export function dayLabel(dayKey: string, now: Date = new Date()): string {
  if (!dayKey) return '';
  const [y, m, d] = dayKey.split('-').map(Number);
  if (!y || !m || !d) return dayKey;

  const todayKey = localDayKey(now.toISOString());
  if (dayKey === todayKey) return 'Today';

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey === localDayKey(yesterday.toISOString())) return 'Yesterday';

  const month = MONTHS[m - 1] ?? '';
  return y === now.getFullYear() ? `${d} ${month}` : `${d} ${month} ${y}`;
}

/**
 * "4:05pm", "8am", "12pm".
 *
 * Twelve-hour and lowercase to match the availability grid's own wording
 * ("8am – 12pm" in `SLOTS`), so the two screens do not disagree about what an
 * afternoon looks like. Minutes are dropped when they are zero.
 */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const h24 = d.getHours();
  const suffix = h24 < 12 ? 'am' : 'pm';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mins = d.getMinutes();
  return mins === 0 ? `${h12}${suffix}` : `${h12}:${two(mins)}${suffix}`;
}

// ---------------------------------------------------------------------------
// The timeline the chat screen renders
// ---------------------------------------------------------------------------

/** How close two messages must be to share one sender heading. */
export const RUN_GAP_MS = 5 * 60 * 1000;

/**
 * Which card to render.
 *
 * Falls back to the plain bubble for a kind this build does not know, or for a
 * kind whose referent is missing — a `'session'` row with no `session_id` cannot
 * render a session card, and `body` carries a human sentence for every kind
 * precisely so the fallback says something true. A future migration adding a
 * fourth kind must not blank the screen of an app already on someone's phone.
 */
export function renderKind(message: Message): MessageKind {
  if (message.kind === 'session') return message.session_id ? 'session' : 'text';
  if (message.kind === 'file') return message.material_id ? 'file' : 'text';
  return 'text';
}

export interface TimelineMessageItem {
  type: 'message';
  key: string;
  message: Message;
  kind: MessageKind;
  isMine: boolean;
  /** First of a run read oldest-first: the sender's name belongs here. */
  showSender: boolean;
  /** Last of a run read oldest-first: the timestamp belongs here. */
  showTime: boolean;
  /** Queued in the outbox and not yet acknowledged — render as "sending". */
  pending: boolean;
}

export interface TimelineDayItem {
  type: 'day';
  key: string;
  dayKey: string;
  label: string;
}

export type TimelineItem = TimelineMessageItem | TimelineDayItem;

function millis(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Flatten messages into what an INVERTED `FlatList` wants: newest first, so
 * index 0 sits at the bottom of the screen.
 *
 * That inversion is why a day separator is emitted AFTER the messages it labels.
 * A higher index renders higher up, so "Today" has to follow today's oldest
 * loaded message to appear above it. Getting this backwards labels every block
 * with the wrong day, which reads as a timezone bug and is not one.
 *
 * The topmost loaded day always gets a separator, even mid-history: it is
 * rebuilt from the whole list on every page, so the label moves up as older
 * messages arrive rather than being wrong in the meantime.
 *
 * Runs only ever group plain text from one sender on one local day within
 * `RUN_GAP_MS`. Session and file cards always carry their own heading — a card
 * silently attributed to the bubble above it is worse than a repeated name.
 */
export function buildTimeline(input: {
  messages: readonly Message[];
  currentUserId: string | null;
  pendingIds?: ReadonlySet<string>;
  now?: Date;
}): TimelineItem[] {
  const now = input.now ?? new Date();
  const pending = input.pendingIds;
  const sorted = [...input.messages].sort(compareMessagesNewestFirst);
  const items: TimelineItem[] = [];

  for (let i = 0; i < sorted.length; i += 1) {
    const m = sorted[i];
    const older = sorted[i + 1];
    const newer = sorted[i - 1];
    const kind = renderKind(m);
    const day = localDayKey(m.created_at);

    const runs = (other: Message | undefined): boolean =>
      !!other &&
      kind === 'text' &&
      renderKind(other) === 'text' &&
      other.sender_id === m.sender_id &&
      localDayKey(other.created_at) === day &&
      Math.abs(millis(m.created_at) - millis(other.created_at)) <= RUN_GAP_MS;

    items.push({
      type: 'message',
      key: m.message_id,
      message: m,
      kind,
      isMine: !!input.currentUserId && m.sender_id === input.currentUserId,
      showSender: !runs(older),
      showTime: !runs(newer),
      pending: pending?.has(m.message_id) ?? false,
    });

    if (!older || localDayKey(older.created_at) !== day) {
      items.push({
        type: 'day',
        key: `day:${day}`,
        dayKey: day,
        label: dayLabel(day, now),
      });
    }
  }

  return items;
}

/**
 * Mirrors `delete_my_message` (0014): your own message, and not already gone.
 *
 * Only your own — there is deliberately no moderation path, not even for the
 * group's creator, and no edit RPC at all. Both would need a history to be
 * honest about, which this table does not keep.
 */
export function canDeleteMessage(
  message: Message,
  currentUserId: string | null
): boolean {
  return (
    !!currentUserId &&
    message.sender_id === currentUserId &&
    message.deleted_at === null
  );
}

/**
 * What a deleted message reads as, or null when there is real text to render.
 *
 * The row survives so the conversation keeps its shape; the text does not. 0013
 * blanks `body` rather than hiding it, because RLS grants rows and not columns —
 * anything left in the column is delivered to every subscriber whatever the
 * client chooses to draw.
 */
export function deletedMessageText(message: Message): string | null {
  return message.deleted_at === null ? null : 'This message was deleted';
}

// ---------------------------------------------------------------------------
// Unread badges (my_unread_counts, 0014)
// ---------------------------------------------------------------------------

/** Badge text, or null when there is nothing to show. Caps at "99+". */
export function unreadBadge(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? '99+' : String(Math.floor(count));
}

/**
 * The one-line preview under a group's name: "Ada: see you at 4".
 *
 * `nameFor` resolves the sender, because `my_unread_counts` returns
 * `last_sender_id` and no name — `public.users` is own-row-only under RLS, so
 * names come from the roster the caller already holds. Returns '' when the group
 * has no messages, which the caller renders as a prompt rather than a blank.
 */
export function lastMessageLine(
  row: Pick<UnreadCountRow, 'last_body' | 'last_sender_id'>,
  nameFor: (userId: string) => string | null,
  currentUserId: string | null = null
): string {
  const body = (row.last_body ?? '').trim();
  if (!body) return '';
  if (!row.last_sender_id) return body;
  if (currentUserId && row.last_sender_id === currentUserId) return `You: ${body}`;
  const name = (nameFor(row.last_sender_id) ?? '').trim();
  return name ? `${name}: ${body}` : body;
}

// ---------------------------------------------------------------------------
// Study times (0016)
// ---------------------------------------------------------------------------

export const SESSION_DURATION_MIN = 15;
export const SESSION_DURATION_MAX = 480;
export const SESSION_LOCATION_MAX = 200;

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  proposed: 'Proposed',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
};

export const SESSION_RESPONSE_LABEL: Record<SessionResponseValue, string> = {
  yes: 'I can make it',
  no: 'I cannot',
  maybe: 'Maybe',
};

/** "45 minutes", "2 hours", "1 hour 30 minutes". */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  const hPart = h > 0 ? `${h} hour${h === 1 ? '' : 's'}` : '';
  const mPart = m > 0 ? `${m} minute${m === 1 ? '' : 's'}` : '';
  if (hPart && mPart) return `${hPart} ${mPart}`;
  return hPart || mPart || '0 minutes';
}

/**
 * "Today, 4pm – 6pm" — when the session is, and for how long.
 *
 * The end is computed from `duration_min` because the table stores a length and
 * not an `ends_at` (0016), so an end time cannot precede its own start however
 * the row was written.
 */
export function sessionWhenLabel(
  startsAt: string,
  durationMin: number,
  now: Date = new Date()
): string {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return '';
  const end = new Date(start.getTime() + Math.max(0, durationMin) * 60_000);
  const day = dayLabel(localDayKey(startsAt), now);
  return `${day}, ${formatClock(startsAt)} – ${formatClock(end.toISOString())}`;
}

/**
 * Mirrors `group_sessions`'s own definition of past: started more than an hour
 * ago. A session you are currently sitting in is exactly the one you want on
 * screen, so the grace period is deliberate and the client must not tighten it —
 * a card the screen hides but the RPC still returns reads as a lost session.
 */
export const SESSION_PAST_GRACE_MS = 60 * 60 * 1000;

export function isSessionPast(startsAt: string, now: Date = new Date()): boolean {
  const start = millis(startsAt);
  if (start === 0) return false;
  return now.getTime() - start > SESSION_PAST_GRACE_MS;
}

/**
 * The rule in force on this session, in words: "Needs all 3", "Needs 3 of 5".
 *
 * Both numbers come from `group_sessions`, and the client must NOT re-derive
 * either. The threshold is 0012's shape — everybody below four members, a
 * majority at four or more — but `members_counted` is members enrolled in the
 * group's COURSE, which is smaller than the roster once somebody drops it. A
 * card that counted the roster would name a rule the trigger is not applying.
 */
export function sessionRuleLabel(
  membersCounted: number,
  confirmThreshold: number
): string {
  if (membersCounted <= 0) return 'Waiting on the group';
  if (membersCounted === 1) return 'Needs just you';
  if (confirmThreshold >= membersCounted) return `Needs all ${membersCounted}`;
  return `Needs ${confirmThreshold} of ${membersCounted}`;
}

/** How many more yeses would confirm it. Zero once it is confirmed or moot. */
export function yesStillNeeded(
  row: Pick<GroupSessionRow, 'status' | 'yes_count' | 'confirm_threshold'>
): number {
  if (row.status !== 'proposed') return 0;
  return Math.max(0, row.confirm_threshold - row.yes_count);
}

/** The tally line: "2 of 3 yes so far", "Confirmed · 3 yes", "Cancelled". */
export function sessionTallyLabel(
  row: Pick<
    GroupSessionRow,
    'status' | 'yes_count' | 'confirm_threshold' | 'no_count'
  >
): string {
  if (row.status === 'cancelled') return 'Cancelled';
  if (row.status === 'confirmed') return `Confirmed · ${row.yes_count} yes`;
  const tally = `${row.yes_count} of ${row.confirm_threshold} yes so far`;
  return row.no_count > 0 ? `${tally} · ${row.no_count} cannot` : tally;
}

/**
 * "Waiting on Ada", "Waiting on Ada and 2 others", or '' when everybody has
 * answered.
 *
 * This is what `session_attendees` returning the WHOLE roster buys (0016): a
 * table of only the people who replied cannot name the people who have not, so
 * the card could only ever say "3 replied" and leave the group guessing which
 * three.
 */
export function waitingOnLabel(
  attendees: readonly { full_name: string | null; response: unknown }[]
): string {
  const waiting = attendees
    .filter((a) => a.response === null || a.response === undefined)
    .map((a) => (a.full_name ?? '').trim() || 'Unnamed student');
  if (waiting.length === 0) return '';
  if (waiting.length === 1) return `Waiting on ${waiting[0]}`;
  if (waiting.length === 2) return `Waiting on ${waiting[0]} and ${waiting[1]}`;
  return `Waiting on ${waiting[0]} and ${waiting.length - 1} others`;
}

/**
 * Mirrors `cancel_session` (0016): the proposer or the group's creator, and only
 * while it is not already cancelled — that state is terminal, so an uncancel is
 * a new proposal, not an edit.
 */
export function canCancelSession(
  row: Pick<GroupSessionRow, 'status' | 'proposed_by'>,
  currentUserId: string | null,
  isGroupCreator: boolean
): boolean {
  if (!currentUserId) return false;
  if (row.status === 'cancelled') return false;
  return row.proposed_by === currentUserId || isGroupCreator;
}

/** Whether the yes/no/maybe buttons should accept a tap at all. */
export function canRespondToSession(
  row: Pick<GroupSessionRow, 'status' | 'starts_at'>,
  now: Date = new Date()
): boolean {
  return row.status !== 'cancelled' && !isSessionPast(row.starts_at, now);
}

/**
 * Validates a proposal against `propose_session`'s own checks: a start strictly
 * in the future, 15 to 480 minutes, an optional location under 200 characters.
 *
 * The future check is the one worth catching locally. Offline it is the whole
 * problem: a session queued for 4pm today and drained at 5pm is refused by the
 * server with nothing left to do about it, so the picker should not accept a
 * past time in the first place. `session.propose` still queues — the honest
 * failure case is a time that passed while the queue sat, not one that was
 * already gone when it was typed.
 */
export function validateSessionProposal(input: {
  startsAt: string;
  durationMin: number;
  location?: string | null;
  now?: Date;
}): string | null {
  const now = input.now ?? new Date();
  const start = new Date(input.startsAt);
  if (Number.isNaN(start.getTime())) return 'Pick a date and time';
  if (start.getTime() <= now.getTime()) return 'Pick a start time in the future';
  if (
    !Number.isFinite(input.durationMin) ||
    input.durationMin < SESSION_DURATION_MIN ||
    input.durationMin > SESSION_DURATION_MAX
  ) {
    return 'A session has to be between 15 minutes and 8 hours long';
  }
  if ((input.location ?? '').trim().length > SESSION_LOCATION_MAX) {
    return `Keep the location under ${SESSION_LOCATION_MAX} characters`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared files (0017, 0018) — Stage 4's half of the timeline
// ---------------------------------------------------------------------------

export const FILE_NAME_MAX_LENGTH = 255;

/**
 * "812 B", "24.5 KB", "25 MB". Binary units, so the 26,214,400-byte ceiling in
 * the `size_bytes` CHECK reads back as the "25 MB" the error message promises
 * rather than as 26.2 MB.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * A coarse family for the file card's icon.
 *
 * Returns a semantic key rather than an icon name: this module has no business
 * knowing which icon set the screens use, and the mapping belongs next to them.
 * MIME first, extension only as a fallback — a phone's document picker is quite
 * capable of handing over `application/octet-stream` for a perfectly ordinary
 * PDF.
 */
export type FileKind =
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slides'
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'text'
  | 'file';

const EXTENSION_KINDS: Record<string, FileKind> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  rtf: 'doc',
  odt: 'doc',
  xls: 'sheet',
  xlsx: 'sheet',
  csv: 'sheet',
  ods: 'sheet',
  ppt: 'slides',
  pptx: 'slides',
  odp: 'slides',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  heic: 'image',
  mp3: 'audio',
  m4a: 'audio',
  wav: 'audio',
  ogg: 'audio',
  mp4: 'video',
  mov: 'video',
  mkv: 'video',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  txt: 'text',
  md: 'text',
};

/** The extension, lowercased, without the dot. '' when there is not one. */
export function fileExtension(fileName: string): string {
  const base = fileName.trim().split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function fileKind(mimeType: string, fileName = ''): FileKind {
  const mime = mimeType.trim().toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/')) return 'text';
  if (mime.includes('spreadsheet') || mime.includes('excel')) return 'sheet';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return 'slides';
  if (mime.includes('word') || mime.includes('opendocument.text')) return 'doc';
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('tar')) {
    return 'archive';
  }
  return EXTENSION_KINDS[fileExtension(fileName)] ?? 'file';
}

/**
 * Validates an upload against `attach_material`'s own checks (0017): a name of
 * 1 to 255 characters, a non-empty MIME type, and 1 byte to 25 MB.
 *
 * Worth checking here rather than only server-side because the round trip this
 * saves is not a request — it is an UPLOAD. Discovering a 40 MB file is too big
 * after pushing 40 MB over a student's mobile data is the kind of thing they pay
 * for by the megabyte.
 */
export function validateUpload(input: {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}): string | null {
  const name = input.fileName.trim();
  if (name.length === 0 || name.length > FILE_NAME_MAX_LENGTH) {
    return `That file needs a name, under ${FILE_NAME_MAX_LENGTH} characters`;
  }
  if (input.mimeType.trim().length === 0) {
    return 'That file has no type, so it cannot be shared';
  }
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes < 1) {
    return 'That file is empty';
  }
  if (input.sizeBytes > MATERIALS_MAX_BYTES) {
    return `Files have to be under ${formatFileSize(MATERIALS_MAX_BYTES)}`;
  }
  return null;
}

/**
 * The last segment of the storage path, with anything that would change the
 * path's SHAPE removed.
 *
 * `attach_material` only checks that the path starts with
 * `<group_id>/<material_id>/` and carries something after it, so a name holding
 * a slash would pass the RPC and quietly create a nested folder in the bucket —
 * a path that no longer matches the one the row records. The real name is kept
 * in `materials.file_name`, which is what the card renders, so nothing about
 * this sanitising is visible to the student.
 */
export function safePathSegment(fileName: string): string {
  const cleaned = fileName
    .trim()
    .replace(/[\\/]+/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^\.+/, '')
    .slice(0, FILE_NAME_MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : 'file';
}

/**
 * `<group_id>/<material_id>/<file_name>` — and this string IS the permission.
 *
 * The Storage INSERT policy reads the first folder to decide whether you may
 * write, and `attach_material` refuses any path that does not begin with the
 * group and material it claims to be (0017). Both halves must therefore be
 * decided before the bytes go up, which is why `material_id` is generated on the
 * device like `message_id`.
 */
export function materialStoragePath(
  groupId: string,
  materialId: string,
  fileName: string
): string {
  return `${groupId}/${materialId}/${safePathSegment(fileName)}`;
}

/**
 * Mirrors `delete_material` (0017): whoever shared it, or the group's creator.
 *
 * Removing it revokes the download for everybody at once — including the
 * uploader — because the Storage read policy asks the `materials` row. Which is
 * also why the caller must take the bytes out of the bucket BEFORE calling the
 * RPC (invariant 8): afterwards nobody can reach them to clean up.
 */
export function canDeleteMaterial(
  row: Pick<GroupMaterialRow, 'uploaded_by' | 'deleted_at'>,
  currentUserId: string | null,
  isGroupCreator: boolean
): boolean {
  if (!currentUserId) return false;
  if (row.deleted_at !== null) return false;
  return row.uploaded_by === currentUserId || isGroupCreator;
}

/**
 * What the files tab says about a removed file: "Removed by Ada", or '' while it
 * is still there.
 *
 * `group_materials` returns removed rows by default and marks them rather than
 * hiding them, so the tab can explain a gap instead of leaving one — somebody
 * looking for a file they know was shared deserves an answer.
 */
export function materialStateLabel(
  row: Pick<GroupMaterialRow, 'deleted_at' | 'deleted_by'>,
  nameFor: (userId: string) => string | null = () => null
): string {
  if (row.deleted_at === null) return '';
  const name = row.deleted_by ? (nameFor(row.deleted_by) ?? '').trim() : '';
  return name ? `Removed by ${name}` : 'Removed';
}

/** Whether the file can still be downloaded. Removal revokes it for everybody. */
export function canDownloadMaterial(
  row: Pick<GroupMaterialRow, 'deleted_at'>
): boolean {
  return row.deleted_at === null;
}
