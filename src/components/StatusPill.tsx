import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { STATUS_LABEL } from '@/lib/groupRules';
import { colors, fontSize, radius, spacing } from '@/theme';
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
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  text: { fontSize: fontSize.xs, fontWeight: '700' },
});

const toneStyles: Record<GroupStatus, { backgroundColor: string }> = {
  forming: { backgroundColor: colors.accentSoft },
  active: { backgroundColor: '#E3F1E8' },
  dormant: { backgroundColor: colors.surfaceAlt },
  archived: { backgroundColor: colors.surfaceAlt },
  disbanded: { backgroundColor: colors.surfaceAlt },
};

const toneText: Record<GroupStatus, { color: string }> = {
  forming: { color: colors.warning },
  active: { color: colors.success },
  dormant: { color: colors.textMuted },
  archived: { color: colors.textMuted },
  disbanded: { color: colors.textMuted },
};
