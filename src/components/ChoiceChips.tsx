import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { FONT, MIN_TOUCH, colors, fontSize, radius, shadowCard, spacing } from '@/theme';

export interface Choice<T> {
  value: T;
  label: string;
}

interface Props<T> {
  /** Spoken above the row, and shown when given. */
  label?: string;
  choices: readonly Choice<T>[];
  selected: T;
  onSelect: (value: T) => void;
  disabled?: boolean;
  /**
   * Scroll horizontally instead of wrapping. For the 24 hour chips, where a wrap
   * would be four rows of near-identical text.
   */
  scroll?: boolean;
}

/**
 * A single-choice chip row — the same control `CourseChips` is, generalised for
 * the prefs screen's two numeric settings.
 *
 * Chips rather than a stepper or a text field, for the reason
 * `DAILY_CAP_CHOICES` gives: a cap is a choice between a few sensible answers, and
 * a keyboard invites `0` typed as `100`. A picker would be two taps and a modal
 * for six options.
 *
 * `accessibilityRole="tab"` matches `CourseChips` and is the closest role RN
 * offers: these are a mutually exclusive set where exactly one is always
 * selected, which is what a screen reader needs to announce.
 */
export function ChoiceChips<T extends string | number>({
  label,
  choices,
  selected,
  onSelect,
  disabled = false,
  scroll = false,
}: Props<T>) {
  const chips = choices.map((choice) => {
    const active = choice.value === selected;
    return (
      <Pressable
        key={String(choice.value)}
        onPress={() => onSelect(choice.value)}
        disabled={disabled}
        style={[styles.chip, active && styles.chipActive, disabled && styles.chipDisabled]}
        accessibilityRole="tab"
        accessibilityState={{ selected: active, disabled }}
        accessibilityLabel={choice.label}
      >
        <Text style={[styles.chipText, active && styles.chipTextActive]}>{choice.label}</Text>
      </Pressable>
    );
  });

  return (
    <View>
      {!!label && <Text style={styles.label}>{label}</Text>}
      {scroll ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.row}
        >
          {chips}
        </ScrollView>
      ) : (
        <View style={[styles.row, styles.wrap]}>{chips}</View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: fontSize.xs,
    fontFamily: FONT.semi,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  row: { paddingVertical: spacing.xs, paddingHorizontal: 2, gap: spacing.sm },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: {
    minHeight: MIN_TOUCH,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg + 2,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.surface,
    backgroundColor: colors.surface,
    ...shadowCard,
  },
  // Selected = ink with white text, matching the primary button.
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipDisabled: { opacity: 0.55 },
  chipText: { fontSize: fontSize.sm, fontFamily: FONT.semi, color: colors.textSecondary },
  chipTextActive: { color: colors.textInverse },
});
