import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { MIN_TOUCH, colors, fontSize, radius, spacing } from '@/theme';
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
    minHeight: MIN_TOUCH - 8,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  chipActive: { borderColor: colors.primary, backgroundColor: colors.primary },
  chipText: { fontSize: fontSize.sm, fontWeight: '600', color: colors.primary },
  chipTextActive: { color: colors.textInverse },
});
