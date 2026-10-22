import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  DAY_ABBR,
  DAYS_PER_WEEK,
  SLOTS,
  SLOTS_PER_DAY,
  isSlotSelected,
  type AvailabilityGrid,
} from '@/lib/availability';
import { FONT, colors } from '@/theme';

interface Props {
  grid: AvailabilityGrid;
  /** band = light green bars on the green header; light = green bars on a white card. */
  tone?: 'band' | 'light';
}

/**
 * A read-only week at a glance: seven columns, one short bar per slot, filled
 * where the student is free. The editable version is `AvailabilityGrid`.
 *
 * Spoken as one sentence per day ("Monday: morning, afternoon") rather than 28
 * separate cells, which is what a screen reader user wants from a summary.
 */
export function WeekStrip({ grid, tone = 'light' }: Props) {
  const spoken = DAY_ABBR.map((day, d) => {
    const free = SLOTS.filter((_, s) => isSlotSelected(grid, d, s)).map((s) => s.label.toLowerCase());
    return `${day}: ${free.length ? free.join(', ') : 'busy'}`;
  }).join('. ');

  return (
    <View style={styles.row} accessible accessibilityLabel={`Free times. ${spoken}`}>
      {Array.from({ length: DAYS_PER_WEEK }).map((_, d) => (
        <View key={d} style={styles.day}>
          {Array.from({ length: SLOTS_PER_DAY }).map((__, s) => (
            <View
              key={s}
              style={[
                styles.bar,
                tone === 'band' ? styles.barBand : styles.barLight,
                isSlotSelected(grid, d, s) && (tone === 'band' ? styles.onBand : styles.onLight),
              ]}
            />
          ))}
          <Text style={[styles.label, tone === 'band' ? styles.labelBand : styles.labelLight]}>
            {DAY_ABBR[d]}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6 },
  day: { flex: 1, alignItems: 'center', gap: 4 },
  bar: { alignSelf: 'stretch', height: 10, borderRadius: 4 },
  barBand: { backgroundColor: 'rgba(255,255,255,0.14)' },
  barLight: { backgroundColor: colors.surfaceAlt },
  onBand: { backgroundColor: colors.bandHighlight },
  onLight: { backgroundColor: colors.primaryMuted },
  label: { fontSize: 11, fontFamily: FONT.semi, marginTop: 4 },
  labelBand: { color: colors.onBandMuted },
  labelLight: { color: colors.textMuted },
});
