import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { FONT, colors, fontSize, radius, spacing } from '@/theme';

interface Props {
  step: number;
  total: number;
}

/**
 * Onboarding progress bar.
 *
 * Present because the 5-minute onboarding target is as much about perceived
 * length as actual length — a student who cannot see how much is left is more
 * likely to abandon partway. Segments rather than a percentage fill, so
 * "1 of 3" is legible at a glance.
 */
export function StepHeader({ step, total }: Props) {
  return (
    <View style={styles.wrapper}>
      <View style={styles.track}>
        {Array.from({ length: total }).map((_, i) => (
          <View
            key={i}
            style={[
              styles.segment,
              i < step ? styles.segmentDone : i === step ? styles.segmentCurrent : styles.segmentTodo,
            ]}
          />
        ))}
      </View>
      <Text style={styles.label}>
        Step {step} of {total}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { marginBottom: spacing.lg },
  track: { flexDirection: 'row', marginBottom: spacing.xs, gap: 4 },
  segment: { flex: 1, height: 6, borderRadius: radius.pill },
  // Done = lime, current = periwinkle, upcoming = sand.
  segmentDone: { backgroundColor: colors.accent },
  segmentCurrent: { backgroundColor: colors.primary },
  segmentTodo: { backgroundColor: colors.surfaceAlt },
  label: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    fontFamily: FONT.semi,
  },
});
