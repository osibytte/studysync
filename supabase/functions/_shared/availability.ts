/**
 * Weekly availability encoding.
 *
 * DECISION (2026-09-03): availability is a fixed 7-day x 4-slot grid, not
 * arbitrary time ranges. Students tap a grid (28 taps max) instead of typing
 * times, which protects the 5-minute onboarding target, and schedule overlap
 * reduces to counting shared ticks instead of intersecting intervals.
 *
 * Wire format is a 28-character string of '0'/'1', stored in Postgres as
 * `bit(28)`. Bit index 0 is the LEFTMOST character — this matches Postgres's
 * own bit-string text representation, so the same string round-trips through
 * the database unchanged.
 *
 *   bitIndex = dayIndex * 4 + slotIndex
 *
 * The SQL function `availability_overlap(a, b)` in 0001_stage1_schema.sql
 * relies on this exact layout. If you change SLOTS_PER_DAY or the ordering
 * here, that function and the bit(28) column width must change with it.
 */

export const DAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export type Day = (typeof DAYS)[number];

/**
 * Four blocks rather than hourly slots. Hourly would be 7x15=105 taps, which
 * no student will complete honestly; four blocks is coarse enough to fill in
 * quickly and still granular enough that "we're both free Tuesday evening"
 * means something you can actually act on.
 */
export const SLOTS = [
  { label: 'Morning', hint: '8am – 12pm' },
  { label: 'Afternoon', hint: '12pm – 4pm' },
  { label: 'Evening', hint: '4pm – 8pm' },
  { label: 'Night', hint: '8pm – 11pm' },
] as const;

export const DAYS_PER_WEEK = DAYS.length; // 7
export const SLOTS_PER_DAY = SLOTS.length; // 4
export const TOTAL_SLOTS = DAYS_PER_WEEK * SLOTS_PER_DAY; // 28

/** Short day labels for the grid header, where horizontal space is tight. */
export const DAY_ABBR = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/**
 * In-memory representation: a flat boolean array of length 28.
 *
 * Flat rather than nested (boolean[7][4]) because it maps 1:1 onto the bit
 * index, so encode/decode stay trivial and there is no chance of transposing
 * days and slots by accident.
 */
export type AvailabilityGrid = boolean[];

export function bitIndex(dayIndex: number, slotIndex: number): number {
  return dayIndex * SLOTS_PER_DAY + slotIndex;
}

export function emptyGrid(): AvailabilityGrid {
  return new Array(TOTAL_SLOTS).fill(false);
}

/** Wire string of 28 zeros — the column default, useful in tests and resets. */
export const EMPTY_MASK = '0'.repeat(TOTAL_SLOTS);

/** True if a mask is exactly 28 characters of '0'/'1' and nothing else. */
export function isValidMask(mask: string): boolean {
  return mask.length === TOTAL_SLOTS && /^[01]+$/.test(mask);
}

/** Grid -> wire string for writing to Postgres. */
export function encodeAvailability(grid: AvailabilityGrid): string {
  if (grid.length !== TOTAL_SLOTS) {
    throw new Error(
      `Availability grid must have exactly ${TOTAL_SLOTS} entries, got ${grid.length}`
    );
  }
  return grid.map((free) => (free ? '1' : '0')).join('');
}

/**
 * Wire string -> grid for reading from Postgres.
 *
 * Returns an empty grid for null/undefined/malformed input rather than
 * throwing. A corrupt availability value should degrade the student's match
 * quality, not crash the profile screen they need in order to fix it.
 */
export function decodeAvailability(mask: string | null | undefined): AvailabilityGrid {
  if (!mask || !isValidMask(mask)) return emptyGrid();
  return mask.split('').map((c) => c === '1');
}

/** Flip one slot, returning a new grid. Never mutates — safe for setState. */
export function toggleSlot(
  grid: AvailabilityGrid,
  dayIndex: number,
  slotIndex: number
): AvailabilityGrid {
  if (dayIndex < 0 || dayIndex >= DAYS_PER_WEEK || slotIndex < 0 || slotIndex >= SLOTS_PER_DAY) {
    throw new Error(`Slot out of range: day ${dayIndex}, slot ${slotIndex}`);
  }
  const i = bitIndex(dayIndex, slotIndex);
  const next = [...grid];
  next[i] = !next[i];
  return next;
}

export function isSlotSelected(
  grid: AvailabilityGrid,
  dayIndex: number,
  slotIndex: number
): boolean {
  return grid[bitIndex(dayIndex, slotIndex)] === true;
}

/** Tick or clear a whole day at once — the "free all day" shortcut. */
export function setDay(
  grid: AvailabilityGrid,
  dayIndex: number,
  value: boolean
): AvailabilityGrid {
  const next = [...grid];
  for (let s = 0; s < SLOTS_PER_DAY; s++) next[bitIndex(dayIndex, s)] = value;
  return next;
}

export function countSelected(grid: AvailabilityGrid): number {
  return grid.reduce((n, free) => (free ? n + 1 : n), 0);
}

/**
 * Client-side mirror of the SQL `availability_overlap`. Counts slots both
 * students are free.
 *
 * Kept in TS as well as SQL so the UI can show "3 shared slots" on a match
 * card without a round trip. The two implementations must agree — the unit
 * tests pin the behaviour on this side.
 */
export function overlapCount(a: AvailabilityGrid, b: AvailabilityGrid): number {
  const n = Math.min(a.length, b.length);
  let count = 0;
  for (let i = 0; i < n; i++) if (a[i] && b[i]) count++;
  return count;
}

/** Same as overlapCount, but straight off two wire strings. */
export function overlapCountFromMasks(a: string, b: string): number {
  return overlapCount(decodeAvailability(a), decodeAvailability(b));
}

/**
 * Normalised overlap in [0, 1] for the compatibility score's schedule term.
 *
 * Denominator is the smaller of the two students' free-slot counts, not
 * TOTAL_SLOTS. Dividing by 28 would mean a student who is only free 4 hours a
 * week can never score above 0.14 on schedule, no matter how perfectly those
 * hours line up. Using the smaller count asks the question that matters: of
 * the times the more-constrained student is free, how many does the other
 * one share?
 *
 * Returns 0 when either student has no availability at all — no free time
 * means no schedule compatibility, and it keeps the divisor non-zero.
 */
export function scheduleOverlapScore(a: AvailabilityGrid, b: AvailabilityGrid): number {
  const aCount = countSelected(a);
  const bCount = countSelected(b);
  if (aCount === 0 || bCount === 0) return 0;
  return overlapCount(a, b) / Math.min(aCount, bCount);
}

/**
 * A group's representative availability grid — the slots the group can
 * *commonly* meet, used as the `Candidate.availability` the scorer overlaps a
 * requester against.
 *
 * A slot counts as "the group is free then" when at least half the members are
 * free then (majority rule, `freeCount >= ceil(n/2)`). Two deliberate choices:
 *
 *   * Not strict intersection. Requiring *every* member to be free would let a
 *     single busy member collapse the grid to empty, and a large group would
 *     almost never share a common slot — matching would then score every group
 *     0 on schedule and the term would be dead weight.
 *   * A one-member group reduces to exactly that member's own grid (ceil(1/2)=1),
 *     which is what a lone-student "form a new group" candidate should score as.
 *
 * NOT the same rule as the group detail screen's "when you can all meet", which
 * since migration 0012 requires EVERY member while the group is under four. That
 * heading answers "when do we meet" and has an exact answer for two people; this
 * function answers "how well would a newcomer fit here", and an intersection
 * would score most young groups 0 on schedule overlap — burying the groups that
 * most need members. The divergence is deliberate; change this one only for a
 * scoring reason, and change `group_common_availability` (0012) for a display one.
 *
 * Returns an empty grid for no members, keeping the scorer's divisor non-zero.
 */
export function groupCommonAvailability(grids: AvailabilityGrid[]): AvailabilityGrid {
  const out = emptyGrid();
  const n = grids.length;
  if (n === 0) return out;
  const needed = Math.ceil(n / 2);
  for (let i = 0; i < TOTAL_SLOTS; i++) {
    let free = 0;
    for (const g of grids) if (g[i]) free++;
    out[i] = free >= needed;
  }
  return out;
}

/** Human-readable slot list, e.g. "Mon evening, Wed morning". For match cards. */
export function describeSelection(grid: AvailabilityGrid, limit = 3): string {
  const picked: string[] = [];
  for (let d = 0; d < DAYS_PER_WEEK; d++) {
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      if (grid[bitIndex(d, s)]) {
        picked.push(`${DAY_ABBR[d]} ${SLOTS[s].label.toLowerCase()}`);
      }
    }
  }
  if (picked.length === 0) return 'No availability set';
  if (picked.length <= limit) return picked.join(', ');
  return `${picked.slice(0, limit).join(', ')} +${picked.length - limit} more`;
}
