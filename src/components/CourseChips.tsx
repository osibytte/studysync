import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { FONT, MIN_TOUCH, colors, fontSize, radius, spacing } from '@/theme';
import type { UserCourseWithDetail } from '@/types/database';

interface Props {
  courses: UserCourseWithDetail[];
  selectedCourseId: string | null;
  onSelect: (courseId: string) => void;
}

/**
 * Horizontal course selector for the two screens that are scoped to one course
 * (discover and match).
 *
 * Chips rather than a picker/modal: a student has a handful of courses, and one
 * tap to switch beats two taps plus a sheet when the whole point of the screen
 * is comparing what is available across their courses.
 */
export function CourseChips({ courses, selectedCourseId, onSelect }: Props) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {courses.map((uc) => {
        const active = uc.course_id === selectedCourseId;
        return (
          <Pressable
            key={uc.course_id}
            onPress={() => onSelect(uc.course_id)}
            style={[styles.chip, active && styles.chipActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={uc.course?.course_code ?? 'Course'}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>
              {uc.course?.course_code ?? '—'}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: spacing.xs, gap: spacing.sm },
  chip: {
    minHeight: MIN_TOUCH,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  // Selected = lime with ink text, matching ChoiceChips and the primary button.
  chipActive: { borderColor: colors.accent, backgroundColor: colors.accent },
  chipText: { fontSize: fontSize.sm, fontFamily: FONT.semi, color: colors.text },
  chipTextActive: { color: colors.text },
});
