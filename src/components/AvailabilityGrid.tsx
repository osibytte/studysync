import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  DAYS,
  DAY_ABBR,
  DAYS_PER_WEEK,
  SLOTS,
  SLOTS_PER_DAY,
  type AvailabilityGrid as Grid,
  countSelected,
  isSlotSelected,
  setDay,
  toggleSlot,
} from '@/lib/availability';
import { FONT, colors, fontSize, radius, spacing } from '@/theme';

interface Props {
  grid: Grid;
  onChange: (next: Grid) => void;
}

/**
 * 7-day x 4-slot tap grid.
 *
 * Layout is slots-as-rows, days-as-columns: seven narrow columns fit an
 * entry-level phone in portrait without horizontal scrolling, whereas
 * days-as-rows would need 28 full-width rows and a lot of scrolling.
 *
 * Each cell is a plain Pressable with a background colour change. No
 * animation: 28 animated views on a low-end GPU drops frames, and the
 * feedback here needs to be instant rather than pretty.
 *
 * The day header doubles as a toggle-all-day control. Tapping "Mon" fills or
 * clears that column, which cuts a realistic selection from ~12 taps to ~4 and
 * is the main reason this screen fits inside the 5-minute onboarding budget.
 */
export function AvailabilityGrid({ grid, onChange }: Props) {
  const selected = countSelected(grid);

  const dayIsFull = (dayIndex: number) =>
    Array.from({ length: SLOTS_PER_DAY }).every((_, s) =>
      isSlotSelected(grid, dayIndex, s)
    );

  return (
    <View>
      <View style={styles.headerRow}>
        {/* Spacer aligning the day columns with the slot-label column below. */}
        <View style={styles.slotLabelCell} />
        {DAY_ABBR.map((abbr, dayIndex) => {
          const full = dayIsFull(dayIndex);
          return (
            <Pressable
              key={abbr}
              onPress={() => onChange(setDay(grid, dayIndex, !full))}
              style={styles.dayHeaderCell}
              accessibilityRole="button"
              accessibilityLabel={`${DAYS[dayIndex]}, ${full ? 'clear' : 'select'} whole day`}
            >
              <Text style={[styles.dayHeaderText, full && styles.dayHeaderTextActive]}>
                {abbr}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {SLOTS.map((slot, slotIndex) => (
        <View key={slot.label} style={styles.row}>
          <View style={styles.slotLabelCell}>
            <Text style={styles.slotLabel} numberOfLines={1}>
              {slot.label}
            </Text>
            <Text style={styles.slotHint} numberOfLines={1}>
              {slot.hint}
            </Text>
          </View>

          {Array.from({ length: DAYS_PER_WEEK }).map((_, dayIndex) => {
            const active = isSlotSelected(grid, dayIndex, slotIndex);
            return (
              <Pressable
                key={`${dayIndex}-${slotIndex}`}
                onPress={() => onChange(toggleSlot(grid, dayIndex, slotIndex))}
                style={[styles.cell, active && styles.cellActive]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: active }}
                accessibilityLabel={`${DAYS[dayIndex]} ${slot.label}, ${slot.hint}`}
              >
                {active && <Text style={styles.cellMark}>✓</Text>}
              </Pressable>
            );
          })}
        </View>
      ))}

      <View style={styles.summaryRow}>
        <Text style={styles.summary} accessibilityLiveRegion="polite">
          {selected === 0
            ? 'Tap the times you are usually free to study'
            : `${selected} slot${selected === 1 ? '' : 's'} selected`}
        </Text>
        {selected > 0 && (
          <Pressable
            onPress={() => onChange(new Array(DAYS_PER_WEEK * SLOTS_PER_DAY).fill(false))}
            accessibilityRole="button"
            accessibilityLabel="Clear all availability"
            hitSlop={8}
            style={styles.clearButton}
          >
            <Text style={styles.clearText}>Clear all</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/**
 * Cells are 40pt tall, below the 44pt guideline.
 *
 * Deliberate tradeoff: 44pt rows would push the grid past the fold on a
 * 5-inch screen, and scrolling while comparing days is worse for accuracy than
 * a slightly smaller target. The whole-day header toggles are full height and
 * give an easier path for anyone who struggles with the small cells.
 */
const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', marginBottom: spacing.xs },
  row: { flexDirection: 'row', marginBottom: spacing.xs },
  slotLabelCell: { width: 76, justifyContent: 'center', paddingRight: spacing.xs },
  slotLabel: { fontSize: fontSize.xs, fontFamily: FONT.semi, color: colors.text },
  slotHint: { fontSize: 10, fontFamily: FONT.regular, color: colors.textMuted },
  dayHeaderCell: {
    flex: 1,
    marginHorizontal: 2,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayHeaderText: { fontSize: fontSize.xs, fontFamily: FONT.semi, color: colors.textMuted },
  dayHeaderTextActive: { color: colors.primaryDark },
  cell: {
    flex: 1,
    height: 40,
    marginHorizontal: 2,
    borderRadius: radius.sm + 2,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Selected = lime with an ink check, same pair as the primary button.
  cellActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  cellMark: { color: colors.text, fontSize: fontSize.sm, fontFamily: FONT.bold },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
  },
  summary: { flex: 1, fontSize: fontSize.xs, fontFamily: FONT.regular, color: colors.textMuted },
  clearButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  clearText: { fontSize: fontSize.xs, fontFamily: FONT.semi, color: colors.primaryDark },
});
