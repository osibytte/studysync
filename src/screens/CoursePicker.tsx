import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
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
import {
  PROFICIENCY_CHOICES,
  PROFICIENCY_HINT,
  PROFICIENCY_LABEL,
} from '@/lib/groupRules';
import { enqueue } from '@/lib/outbox';
import { friendlyError, isNetworkError, supabase } from '@/lib/supabase';
import { FONT, MIN_TOUCH, colors, fontSize, radius, spacing } from '@/theme';
import type { Course, Proficiency, UserCourseWithDetail } from '@/types/database';

interface Props {
  /** Onboarding shows the step bar; editing later does not. */
  showStepHeader?: boolean;
  footerLabel: (count: number) => string;
  /** Disabled until at least one course is picked, during onboarding only. */
  requireAtLeastOne?: boolean;
  /**
   * Block the footer until every picked course carries a rating.
   *
   * Onboarding only, and the asymmetry is deliberate. Rating is part of picking a
   * course now (0020), so the onboarding step should not let a student past a
   * half-answered list. The later edit route only SAYS what is missing: an
   * enrolment made before 0020 has no rating, this screen's footer is the only way
   * off it, and trapping somebody there over a field they did not know existed is
   * worse than an unrated row. Applying is where the rating is actually required,
   * and `request_matching` refuses it with a sentence that explains itself.
   */
  requireRatings?: boolean;
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
  requireRatings = false,
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
  // Separate from busyCourseId: that one swaps the row's checkbox for a spinner,
  // and rating a course does not change whether it is picked.
  const [ratingCourseId, setRatingCourseId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const byCourseId = useMemo(
    () => new Map(userCourses.map((uc) => [uc.course_id, uc])),
    [userCourses]
  );

  /** Picked but not yet rated — what the footer waits on, and names. */
  const unrated = useMemo(
    () => userCourses.filter((uc) => uc.proficiency == null),
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
     * elsewhere (availability) to skip rows that are not persisted yet.
     */
    const base = userCourses;
    const optimistic: UserCourseWithDetail = {
      user_course_id: `temp-${course.course_id}`,
      user_id: userId,
      course_id: course.course_id,
      availability: EMPTY_MASK,
      // Both null, and both are the column defaults: nobody has rated this yet,
      // and nothing puts a student in the matching pool on their own behalf (0020).
      proficiency: null,
      applied_at: null,
      created_at: new Date().toISOString(),
      course,
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

  /**
   * Remove an enrolment.
   *
   * Unlike `addCourse`, a failure here is NOT queued blindly. 0020 §5 gives this
   * delete a server-side refusal it never had: an outstanding application cannot be
   * withdrawn by dropping the course and adding it back, so the trigger raises
   * P0001 with a sentence the student needs to read. Queueing that would
   * dead-letter it silently and leave the row missing from the list until a
   * reload — so only a network error falls through to the outbox, and everything
   * else rolls the row back and shows why.
   */
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
      if (!isNetworkError(error)) {
        setLocal(previous);
        setFormError(friendlyError(error));
      } else {
        try {
          await enqueue('course.remove', { course_id: courseId }, userId);
          await refreshPending();
        } catch {
          setLocal(previous);
          setFormError(friendlyError(error));
        }
      }
    } finally {
      setBusyCourseId(null);
    }
  }

  /**
   * Save the student's own rating of one course (0020).
   *
   * Last-write-wins on a private field, which is what makes it queueable — see
   * `course.proficiency` in outbox.ts. The write is keyed on `(user_id,
   * course_id)` rather than `user_course_id` for the same reason the queued action
   * is: a course added offline has only a `temp-` id, and there is a live window
   * where the enrolment is picked on screen but its row has not landed yet.
   *
   * That window is why the update asks for its row back. A PostgREST update that
   * matches nothing is not an error — it reports success having changed nothing —
   * so without this check a student who rated a course seconds after adding it
   * offline would watch the chip fill in and then find it blank after a reload.
   * Zero rows means "the enrolment is not there yet", and the outbox is exactly
   * the right place for a write that has to wait for one: FIFO puts it behind the
   * `course.add` it depends on.
   */
  async function setProficiency(courseId: string, level: Proficiency) {
    if (!userId) return;
    const current = byCourseId.get(courseId);
    if (!current || current.proficiency === level) return;

    setFormError(null);
    setRatingCourseId(courseId);

    const previous = userCourses;
    const patch = (uc: UserCourseWithDetail) =>
      uc.course_id === courseId ? { ...uc, proficiency: level } : uc;
    setLocal(userCourses.map(patch));

    const queue = async () => {
      await enqueue(
        'course.proficiency',
        { course_id: courseId, proficiency: level },
        userId
      );
      await refreshPending();
    };

    try {
      if (isOnline) {
        const { data, error } = await supabase
          .from('user_courses')
          .update({ proficiency: level })
          .eq('user_id', userId)
          .eq('course_id', courseId)
          .select('user_course_id');
        if (error) throw error;
        if (!data || data.length === 0) await queue();
      } else {
        await queue();
      }
    } catch (error) {
      try {
        await queue();
      } catch {
        setLocal(previous);
        setFormError(friendlyError(error));
      }
    } finally {
      setRatingCourseId(null);
    }
  }

  const canContinue =
    (!requireAtLeastOne || userCourses.length > 0) &&
    (!requireRatings || unrated.length === 0);

  /**
   * Named, not just counted, because the list is filtered by the search box: a
   * course still missing its rating can be scrolled past or typed out of view, and
   * a disabled button with nothing on screen to explain it is the one state a
   * student cannot act on.
   */
  const unratedNote =
    unrated.length === 0
      ? null
      : `Say how you are finding ${unrated
          .map((uc) => uc.course?.course_code ?? 'this course')
          .join(', ')}.`;

  return (
    <Screen
      title="Your courses"
      subtitle={
        subtitle ??
        'Pick only the courses you want a study group for, then say how you are finding each one. You can change both later.'
      }
      scroll={false}
      footer={
        <>
          {!!unratedNote && (
            <Text style={styles.footerNote} accessibilityLiveRegion="polite">
              {unratedNote}
            </Text>
          )}
          <Button
            label={footerLabel(userCourses.length)}
            onPress={onDone}
            disabled={!canContinue}
          />
        </>
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
          <ActivityIndicator color={colors.primaryDark} />
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
        <ScrollView
          style={styles.list}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {filtered.map((course) => {
            const enrolment = byCourseId.get(course.course_id);
            const selected = !!enrolment;
            const busy = busyCourseId === course.course_id;
            const rating = ratingCourseId === course.course_id;
            return (
              <View key={course.course_id}>
                <Pressable
                  onPress={() =>
                    selected ? void removeCourse(course.course_id) : void addCourse(course)
                  }
                  disabled={busy || rating}
                  style={[
                    styles.row,
                    selected && styles.rowSelected,
                    selected && styles.rowAttached,
                  ]}
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
                    <ActivityIndicator size="small" color={colors.primaryDark} />
                  ) : (
                    <View style={[styles.checkbox, selected && styles.checkboxOn]}>
                      {selected && <Text style={styles.checkMark}>✓</Text>}
                    </View>
                  )}
                </Pressable>

                {selected && (
                  <View style={styles.rating}>
                    <Text style={styles.ratingLabel}>
                      How are you finding this course?
                    </Text>
                    {PROFICIENCY_CHOICES.map((level) => {
                      const on = enrolment.proficiency === level;
                      return (
                        <Pressable
                          key={level}
                          onPress={() => void setProficiency(course.course_id, level)}
                          disabled={busy || rating}
                          style={[styles.option, on && styles.optionOn]}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: on, busy: rating }}
                          accessibilityLabel={`${PROFICIENCY_LABEL[level]}. ${PROFICIENCY_HINT[level]}`}
                        >
                          <View style={[styles.radio, on && styles.radioOn]}>
                            {on && <View style={styles.radioDot} />}
                          </View>
                          <View style={styles.optionText}>
                            <Text
                              style={[styles.optionLabel, on && styles.optionLabelOn]}
                            >
                              {PROFICIENCY_LABEL[level]}
                            </Text>
                            <Text style={styles.hint}>{PROFICIENCY_HINT[level]}</Text>
                          </View>
                        </Pressable>
                      );
                    })}
                    <Text style={styles.ratingWhy}>
                      Only used to mix the group, so somebody in it can explain the
                      parts you are stuck on. Nobody sees your answer.
                    </Text>
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
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
  // A ScrollView rather than a FlatList: the seeded list is short enough that
  // virtualisation costs more than it saves on an entry-level device. It does have
  // to scroll, though — a picked course grows a rating block three options tall,
  // so even a short list stops fitting once a couple are selected.
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
  // Square off the bottom of a picked row so it reads as one card with the rating
  // block underneath it, rather than two unrelated things that happen to be close.
  rowAttached: {
    marginBottom: 0,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderBottomWidth: 0,
  },
  rating: {
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: colors.accent,
    borderBottomLeftRadius: radius.md,
    borderBottomRightRadius: radius.md,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    marginBottom: spacing.sm,
  },
  ratingLabel: {
    fontSize: fontSize.sm,
    fontFamily: FONT.bold,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  ratingWhy: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 16,
    marginTop: spacing.xs,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    minHeight: MIN_TOUCH,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    marginBottom: spacing.sm,
  },
  optionOn: { borderColor: colors.primaryDark, borderWidth: 2 },
  optionText: { flex: 1, paddingLeft: spacing.sm },
  optionLabel: { fontSize: fontSize.sm, fontFamily: FONT.semi, color: colors.text },
  optionLabelOn: { color: colors.primaryDark },
  hint: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, lineHeight: 16 },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  radioOn: { borderColor: colors.primary },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.primaryDark,
  },
  rowText: { flex: 1, paddingRight: spacing.md },
  code: { fontSize: fontSize.sm, fontFamily: FONT.bold, color: colors.primaryDark },
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
  checkMark: { color: colors.primaryDark, fontFamily: FONT.bold, fontSize: fontSize.sm },
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
  footerNote: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginBottom: spacing.sm,
    lineHeight: 20,
  },
});
