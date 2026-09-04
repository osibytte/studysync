import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { StepHeader } from '@/components/StepHeader';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useCourses } from '@/hooks/useCourses';
import { useUserCourses } from '@/hooks/useUserCourses';
import { EMPTY_MASK } from '@/lib/availability';
import { enqueue } from '@/lib/outbox';
import { friendlyError, supabase } from '@/lib/supabase';
import { MIN_TOUCH, colors, fontSize, radius, spacing } from '@/theme';
import type { Course, UserCourseWithDetail } from '@/types/database';

interface Props {
  /** Onboarding shows the step bar; editing later does not. */
  showStepHeader?: boolean;
  footerLabel: (count: number) => string;
  /** Disabled until at least one course is picked, during onboarding only. */
  requireAtLeastOne?: boolean;
  onDone: () => void;
  subtitle?: string;
}

/**
 * Course selection, shared by the onboarding step and the later edit route.
 *
 * Lives here rather than in one of the route files because the route guard
 * redirects an onboarded student out of `(onboarding)`, so the edit path needs
 * its own route under `(app)` — and duplicating this logic in two places is how
 * the two copies drift.
 *
 * Search filters the cached list client-side. The seeded course table is small,
 * so local filtering works offline and costs nothing per keystroke.
 */
export function CoursePicker({
  showStepHeader = false,
  footerLabel,
  requireAtLeastOne = false,
  onDone,
  subtitle,
}: Props) {
  const { profile } = useAuth();
  const { isOnline, refreshPending } = useNetwork();

  const userId = profile?.user_id ?? null;
  const { courses, loading: coursesLoading, error: coursesError } = useCourses();
  const { userCourses, setLocal } = useUserCourses(userId);

  const [query, setQuery] = useState('');
  const [busyCourseId, setBusyCourseId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const selectedIds = useMemo(
    () => new Set(userCourses.map((uc) => uc.course_id)),
    [userCourses]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return courses;
    return courses.filter(
      (c) =>
        c.course_code.toLowerCase().includes(q) ||
        c.course_title.toLowerCase().includes(q) ||
        (c.department ?? '').toLowerCase().includes(q)
    );
  }, [courses, query]);

  async function addCourse(course: Course) {
    if (!userId) return;
    setFormError(null);
    setBusyCourseId(course.course_id);

    /**
     * Optimistic insert with a temporary user_course_id.
     *
     * The real id comes from Postgres. Offline there is none, so a temp id
     * keyed on the course id keeps the list stable and still identifies the
     * row. Replaced on the next successful load. The temp- prefix is checked
     * elsewhere (topics, availability) to skip rows that are not persisted yet.
     */
    const base = userCourses;
    const optimistic: UserCourseWithDetail = {
      user_course_id: `temp-${course.course_id}`,
      user_id: userId,
      course_id: course.course_id,
      availability: EMPTY_MASK,
      // New enrolments join the system-matching pool by default (the DB default).
      matching_pref: 'system',
      created_at: new Date().toISOString(),
      course,
      topic_ids: [],
    };
    setLocal([...base, optimistic]);

    try {
      if (isOnline) {
        const { data, error } = await supabase
          .from('user_courses')
          .insert({ user_id: userId, course_id: course.course_id })
          .select('user_course_id, availability, created_at')
          .single();
        if (error) throw error;

        setLocal([
          ...base,
          {
            ...optimistic,
            user_course_id: data.user_course_id,
            availability: data.availability,
            created_at: data.created_at,
          },
        ]);
      } else {
        await enqueue('course.add', { course_id: course.course_id }, userId);
        await refreshPending();
      }
    } catch (error) {
      try {
        await enqueue('course.add', { course_id: course.course_id }, userId);
        await refreshPending();
      } catch {
        setLocal(base); // roll back — could neither write nor queue
        setFormError(friendlyError(error));
      }
    } finally {
      setBusyCourseId(null);
    }
  }

  async function removeCourse(courseId: string) {
    if (!userId) return;
    setFormError(null);
    setBusyCourseId(courseId);

    const previous = userCourses;
    setLocal(userCourses.filter((uc) => uc.course_id !== courseId));

    try {
      if (isOnline) {
        const { error } = await supabase
          .from('user_courses')
          .delete()
          .eq('user_id', userId)
          .eq('course_id', courseId);
        if (error) throw error;
      } else {
        await enqueue('course.remove', { course_id: courseId }, userId);
        await refreshPending();
      }
    } catch (error) {
      try {
        await enqueue('course.remove', { course_id: courseId }, userId);
        await refreshPending();
      } catch {
        setLocal(previous);
        setFormError(friendlyError(error));
      }
    } finally {
      setBusyCourseId(null);
    }
  }

  const canContinue = !requireAtLeastOne || userCourses.length > 0;

  return (
    <Screen
      title="Your courses"
      subtitle={
        subtitle ??
        'Pick the courses you want study partners for. You can change these later.'
      }
      scroll={false}
      footer={
        <Button
          label={footerLabel(userCourses.length)}
          onPress={onDone}
          disabled={!canContinue}
        />
      }
    >
      {showStepHeader && <StepHeader step={2} total={3} />}

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search by code, title, or department"
        placeholderTextColor={colors.textMuted}
        style={styles.search}
        autoCapitalize="characters"
        autoCorrect={false}
        accessibilityLabel="Search courses"
      />

      {!!formError && (
        <Text style={styles.formError} accessibilityLiveRegion="polite">
          {formError}
        </Text>
      )}

      {coursesLoading && courses.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : coursesError && courses.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>{coursesError}</Text>
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>
            No courses match "{query.trim()}".{'\n'}
            If your course is missing, it needs seeding in Supabase.
          </Text>
        </View>
      ) : (
        <View style={styles.list}>
          {filtered.map((course) => {
            const selected = selectedIds.has(course.course_id);
            const busy = busyCourseId === course.course_id;
            return (
              <Pressable
                key={course.course_id}
                onPress={() =>
                  selected ? void removeCourse(course.course_id) : void addCourse(course)
                }
                disabled={busy}
                style={[styles.row, selected && styles.rowSelected]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected, busy }}
                accessibilityLabel={`${course.course_code}, ${course.course_title}`}
              >
                <View style={styles.rowText}>
                  <Text style={styles.code}>{course.course_code}</Text>
                  <Text style={styles.title} numberOfLines={2}>
                    {course.course_title}
                  </Text>
                </View>
                {busy ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <View style={[styles.checkbox, selected && styles.checkboxOn]}>
                    {selected && <Text style={styles.checkMark}>✓</Text>}
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: fontSize.md,
    color: colors.text,
    marginBottom: spacing.md,
  },
  // No FlatList: the seeded list is short enough that virtualisation costs more
  // than it saves on an entry-level device.
  list: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: MIN_TOUCH + 8,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    backgroundColor: colors.background,
  },
  rowSelected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  rowText: { flex: 1, paddingRight: spacing.md },
  code: { fontSize: fontSize.sm, fontWeight: '700', color: colors.primary },
  title: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2 },
  checkbox: {
    width: 26,
    height: 26,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkMark: { color: colors.primary, fontWeight: '700', fontSize: fontSize.sm },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  emptyText: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
  },
  formError: { color: colors.danger, fontSize: fontSize.sm, marginBottom: spacing.sm },
});
