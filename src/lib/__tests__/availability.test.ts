import {
  DAYS_PER_WEEK,
  EMPTY_MASK,
  SLOTS_PER_DAY,
  TOTAL_SLOTS,
  bitIndex,
  countSelected,
  decodeAvailability,
  describeSelection,
  emptyGrid,
  encodeAvailability,
  groupCommonAvailability,
  isSlotSelected,
  isValidMask,
  overlapCount,
  overlapCountFromMasks,
  scheduleOverlapScore,
  setDay,
  toggleSlot,
} from '../availability';

/**
 * The spec names two matching edge cases explicitly: zero schedule overlap and
 * zero candidates found. The first is a pure function and tested here; the
 * second belongs with the Stage 2 matching function.
 *
 * The encode/decode round trip matters more than it looks. If the bit order
 * here ever disagrees with the SQL `availability_overlap`, matching silently
 * compares the wrong slots — students get matched on Tuesday morning when they
 * both said Friday night. Nothing would throw. These tests pin the layout.
 */

describe('grid dimensions', () => {
  it('is 7 days x 4 slots = 28 bits', () => {
    expect(DAYS_PER_WEEK).toBe(7);
    expect(SLOTS_PER_DAY).toBe(4);
    expect(TOTAL_SLOTS).toBe(28);
    expect(EMPTY_MASK).toHaveLength(28);
  });

  it('maps day and slot to a unique bit index', () => {
    const seen = new Set<number>();
    for (let d = 0; d < DAYS_PER_WEEK; d++) {
      for (let s = 0; s < SLOTS_PER_DAY; s++) {
        const i = bitIndex(d, s);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(TOTAL_SLOTS);
        expect(seen.has(i)).toBe(false);
        seen.add(i);
      }
    }
    expect(seen.size).toBe(TOTAL_SLOTS);
  });

  it('puts Monday morning at bit 0 and Sunday night at bit 27', () => {
    // Pins the layout the SQL side assumes. Changing this breaks matching.
    expect(bitIndex(0, 0)).toBe(0);
    expect(bitIndex(6, 3)).toBe(27);
  });
});

describe('encode and decode', () => {
  it('round-trips an empty grid', () => {
    const grid = emptyGrid();
    expect(encodeAvailability(grid)).toBe(EMPTY_MASK);
    expect(decodeAvailability(EMPTY_MASK)).toEqual(grid);
  });

  it('round-trips a fully selected grid', () => {
    const grid = new Array(TOTAL_SLOTS).fill(true);
    const mask = encodeAvailability(grid);
    expect(mask).toBe('1'.repeat(TOTAL_SLOTS));
    expect(decodeAvailability(mask)).toEqual(grid);
  });

  it('round-trips a sparse grid without shifting bits', () => {
    let grid = emptyGrid();
    grid = toggleSlot(grid, 0, 0); // Mon morning
    grid = toggleSlot(grid, 3, 2); // Thu evening
    grid = toggleSlot(grid, 6, 3); // Sun night

    const mask = encodeAvailability(grid);
    const back = decodeAvailability(mask);

    expect(back).toEqual(grid);
    expect(isSlotSelected(back, 0, 0)).toBe(true);
    expect(isSlotSelected(back, 3, 2)).toBe(true);
    expect(isSlotSelected(back, 6, 3)).toBe(true);
    expect(isSlotSelected(back, 1, 0)).toBe(false);
  });

  it('rejects a grid of the wrong length', () => {
    expect(() => encodeAvailability([true, false])).toThrow(/exactly 28/);
  });

  it('degrades to an empty grid for malformed input rather than throwing', () => {
    // A corrupt value must not break the profile screen the student needs in
    // order to fix it.
    expect(decodeAvailability(null)).toEqual(emptyGrid());
    expect(decodeAvailability(undefined)).toEqual(emptyGrid());
    expect(decodeAvailability('')).toEqual(emptyGrid());
    expect(decodeAvailability('101')).toEqual(emptyGrid());
    expect(decodeAvailability('x'.repeat(28))).toEqual(emptyGrid());
  });

  it('validates mask shape', () => {
    expect(isValidMask(EMPTY_MASK)).toBe(true);
    expect(isValidMask('1'.repeat(28))).toBe(true);
    expect(isValidMask('1'.repeat(27))).toBe(false);
    expect(isValidMask('1'.repeat(29))).toBe(false);
    expect(isValidMask('2'.repeat(28))).toBe(false);
  });
});

describe('toggling', () => {
  it('does not mutate the input grid', () => {
    const original = emptyGrid();
    const next = toggleSlot(original, 2, 1);
    expect(original[bitIndex(2, 1)]).toBe(false);
    expect(next[bitIndex(2, 1)]).toBe(true);
  });

  it('toggles off on a second tap', () => {
    let grid = emptyGrid();
    grid = toggleSlot(grid, 4, 3);
    grid = toggleSlot(grid, 4, 3);
    expect(countSelected(grid)).toBe(0);
  });

  it('rejects out-of-range slots', () => {
    const grid = emptyGrid();
    expect(() => toggleSlot(grid, 7, 0)).toThrow(/out of range/);
    expect(() => toggleSlot(grid, 0, 4)).toThrow(/out of range/);
    expect(() => toggleSlot(grid, -1, 0)).toThrow(/out of range/);
  });

  it('sets and clears a whole day', () => {
    let grid = setDay(emptyGrid(), 2, true);
    expect(countSelected(grid)).toBe(SLOTS_PER_DAY);
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      expect(isSlotSelected(grid, 2, s)).toBe(true);
    }
    // Neighbouring days untouched.
    expect(isSlotSelected(grid, 1, 0)).toBe(false);
    expect(isSlotSelected(grid, 3, 0)).toBe(false);

    grid = setDay(grid, 2, false);
    expect(countSelected(grid)).toBe(0);
  });
});

describe('overlap', () => {
  it('returns zero when there is no shared time', () => {
    // The spec's named edge case: strong topic match, zero schedule overlap.
    // Must be exactly 0 so the schedule term contributes nothing rather than
    // a small positive number.
    const a = setDay(emptyGrid(), 0, true); // all Monday
    const b = setDay(emptyGrid(), 1, true); // all Tuesday
    expect(overlapCount(a, b)).toBe(0);
    expect(scheduleOverlapScore(a, b)).toBe(0);
  });

  it('counts only slots both students selected', () => {
    let a = emptyGrid();
    a = toggleSlot(a, 0, 0);
    a = toggleSlot(a, 0, 1);
    a = toggleSlot(a, 1, 0);

    let b = emptyGrid();
    b = toggleSlot(b, 0, 1); // shared
    b = toggleSlot(b, 1, 0); // shared
    b = toggleSlot(b, 5, 3); // not shared

    expect(overlapCount(a, b)).toBe(2);
  });

  it('is symmetric', () => {
    let a = setDay(emptyGrid(), 3, true);
    a = toggleSlot(a, 0, 0);
    const b = setDay(emptyGrid(), 3, true);
    expect(overlapCount(a, b)).toBe(overlapCount(b, a));
  });

  it('works straight off wire masks', () => {
    const a = encodeAvailability(setDay(emptyGrid(), 0, true));
    const b = encodeAvailability(setDay(emptyGrid(), 0, true));
    expect(overlapCountFromMasks(a, b)).toBe(SLOTS_PER_DAY);
    expect(overlapCountFromMasks(a, EMPTY_MASK)).toBe(0);
  });
});

describe('scheduleOverlapScore', () => {
  it('is 0 when either student has no availability', () => {
    // Avoids a divide-by-zero and encodes the honest answer: no free time
    // means no schedule compatibility.
    const busy = setDay(emptyGrid(), 0, true);
    expect(scheduleOverlapScore(busy, emptyGrid())).toBe(0);
    expect(scheduleOverlapScore(emptyGrid(), busy)).toBe(0);
    expect(scheduleOverlapScore(emptyGrid(), emptyGrid())).toBe(0);
  });

  it('is 1 for identical availability', () => {
    const grid = setDay(setDay(emptyGrid(), 0, true), 4, true);
    expect(scheduleOverlapScore(grid, grid)).toBe(1);
  });

  it('normalises against the more constrained student', () => {
    /**
     * The reason for dividing by the smaller free-slot count rather than by 28.
     *
     * A student free only Monday morning, matched with someone free all week:
     * their single slot is fully covered, so the score is 1 — they can always
     * meet. Dividing by 28 would give 0.036 and effectively exclude
     * time-poor students from ever matching well, which is the opposite of
     * what the app is for.
     */
    let constrained = emptyGrid();
    constrained = toggleSlot(constrained, 0, 0);
    const wideOpen = new Array(TOTAL_SLOTS).fill(true);

    expect(scheduleOverlapScore(constrained, wideOpen)).toBe(1);
    expect(scheduleOverlapScore(wideOpen, constrained)).toBe(1);
  });

  it('gives a partial score for partial overlap', () => {
    // a: Mon morning + Mon afternoon. b: Mon afternoon + Tue morning.
    // Smaller count is 2, shared is 1 -> 0.5
    let a = emptyGrid();
    a = toggleSlot(a, 0, 0);
    a = toggleSlot(a, 0, 1);

    let b = emptyGrid();
    b = toggleSlot(b, 0, 1);
    b = toggleSlot(b, 1, 0);

    expect(scheduleOverlapScore(a, b)).toBe(0.5);
  });

  it('always returns a value between 0 and 1', () => {
    const grids = [
      emptyGrid(),
      setDay(emptyGrid(), 0, true),
      setDay(setDay(emptyGrid(), 2, true), 5, true),
      new Array(TOTAL_SLOTS).fill(true),
    ];
    for (const a of grids) {
      for (const b of grids) {
        const score = scheduleOverlapScore(a, b);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('groupCommonAvailability', () => {
  it('returns an empty grid for no members', () => {
    // Keeps the scorer's divisor non-zero and means "a group with nobody in it
    // shares no time" rather than throwing.
    expect(groupCommonAvailability([])).toEqual(emptyGrid());
  });

  it('reduces a one-member group to that member exactly (ceil(1/2)=1)', () => {
    // A lone-student "form a new group" candidate should score as that student.
    let g = emptyGrid();
    g = toggleSlot(g, 0, 0);
    g = toggleSlot(g, 3, 2);
    expect(groupCommonAvailability([g])).toEqual(g);
  });

  it('includes a slot when a majority of members are free (odd size)', () => {
    // 3 members, need ceil(3/2)=2. Mon-morning: 2 of 3 free -> in.
    // Tue-morning: 1 of 3 free -> out.
    const a = toggleSlot(emptyGrid(), 0, 0); // Mon morning
    const b = toggleSlot(emptyGrid(), 0, 0); // Mon morning
    const c = toggleSlot(emptyGrid(), 1, 0); // Tue morning
    const common = groupCommonAvailability([a, b, c]);
    expect(isSlotSelected(common, 0, 0)).toBe(true);
    expect(isSlotSelected(common, 1, 0)).toBe(false);
    expect(countSelected(common)).toBe(1);
  });

  it('requires a true majority at the half boundary (even size)', () => {
    // 4 members, need ceil(4/2)=2. A slot exactly 2-of-4 free counts as common;
    // a slot only 1-of-4 free does not.
    const half = toggleSlot(emptyGrid(), 2, 1); // Wed afternoon
    const also = toggleSlot(emptyGrid(), 2, 1);
    const other1 = toggleSlot(emptyGrid(), 5, 3);
    const other2 = emptyGrid();
    const common = groupCommonAvailability([half, also, other1, other2]);
    expect(isSlotSelected(common, 2, 1)).toBe(true); // 2 of 4
    expect(isSlotSelected(common, 5, 3)).toBe(false); // 1 of 4
  });

  it('excludes a slot no majority shares, even if someone is free then', () => {
    // The point of majority-rather-than-intersection cuts both ways: a slot one
    // lone member likes is not the group's common time.
    const a = setDay(emptyGrid(), 0, true); // all Monday
    const b = setDay(emptyGrid(), 0, true);
    const c = setDay(emptyGrid(), 6, true); // all Sunday — minority of 1
    const common = groupCommonAvailability([a, b, c]);
    // Monday survives (2 of 3), Sunday does not (1 of 3).
    expect(isSlotSelected(common, 0, 0)).toBe(true);
    expect(isSlotSelected(common, 6, 0)).toBe(false);
  });
});

describe('describeSelection', () => {
  it('reports when nothing is set', () => {
    expect(describeSelection(emptyGrid())).toBe('No availability set');
  });

  it('lists slots in day then slot order', () => {
    let grid = emptyGrid();
    grid = toggleSlot(grid, 2, 0); // Wed morning
    grid = toggleSlot(grid, 0, 2); // Mon evening
    expect(describeSelection(grid)).toBe('Mon evening, Wed morning');
  });

  it('truncates long selections with a count', () => {
    const grid = setDay(setDay(emptyGrid(), 0, true), 1, true); // 8 slots
    expect(describeSelection(grid, 3)).toMatch(/\+5 more$/);
  });
});
