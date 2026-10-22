import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { STATUS_LABEL } from '@/lib/groupRules';
import { FONT, fontSize, radius, spacing, colors } from '@/theme';
import type { GroupStatus } from '@/types/database';

/**
 * Small lifecycle badge — "Forming", "Quiet lately", "Archived".
 *
 * Colour is never the only signal: the label always spells the state out, so it
 * still reads correctly in greyscale or to a screen reader. That matters here
 * because `dormant` and `archived` are close in tone but very different in
 * meaning.
 */
export function StatusPill({ status }: { status: GroupStatus }) {
  return (
    <View style={[styles.pill, toneStyles[status]]}>
      <Text style={[styles.text, toneText[status]]}>{STATUS_LABEL[status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 4,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  text: { fontSize: fontSize.xs, fontFamily: FONT.semi },
});

// Solid fills with white text for the live states, so they read at a glance;
// the quiet states stay grey.
const toneStyles: Record<GroupStatus, { backgroundColor: string }> = {
  forming: { backgroundColor: colors.info },
  active: { backgroundColor: colors.success },
  dormant: { backgroundColor: colors.surfaceAlt },
  archived: { backgroundColor: colors.surfaceAlt },
  disbanded: { backgroundColor: colors.surfaceAlt },
};

const toneText: Record<GroupStatus, { color: string }> = {
  forming: { color: colors.textInverse },
  active: { color: colors.textInverse },
  dormant: { color: colors.textSecondary },
  archived: { color: colors.textSecondary },
  disbanded: { color: colors.textSecondary },
};
