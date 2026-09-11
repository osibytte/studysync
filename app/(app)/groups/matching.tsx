import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { useAuth } from '@/context/AuthContext';
import { useMatchingWindow } from '@/hooks/useMatchingWindow';
import { useMyGroups } from '@/hooks/useMyGroups';
import { useUserCourses } from '@/hooks/useUserCourses';
import { countSelected, decodeAvailability } from '@/lib/availability';
import {
  MATCHING_STEP_TITLE,
  canApplyForMatching,
  matchingStep,
  matchingStepBody,
  serverNow,
  windowBanner,
  windowPhase,
  windowWhenLabel,
  type WindowPhase,
} from '@/lib/groupRules';
import { requestMatching } from '@/lib/groups';
import { friendlyError } from '@/lib/supabase';
import { FONT, MIN_TOUCH, colors, fontSize, radius, spacing } from '@/theme';
import type { UserCourseWithDetail } from '@/types/database';

/**
 * "Apply to be matched" — the one screen the registration period gates.
 *
 * Replaces the per-course `matching_pref` switch this route used to hold (0007).
 * That screen asked students to opt OUT of a pool they were in by default; the
 * owner's rule on 2026-09-05 inverted it — "I want all possible students to
 * signify their courses and apply for the system to group them" — so nothing puts
 * a student in a pool on their behalf any more, and this is where they ask.
 *
 * ONE COURSE AT A TIME, because the pool is per course (`user_courses.applied_at`)
 * and a student may want placing on the course they are struggling with and left
 * alone on the one where they already have friends.
 *
 * WHAT THE WINDOW DOES AND DOES NOT DO. It gates this button and nothing else, in
 * the owner's words: "when the window is closed system can either group you, or
 * show a list of available groups or be invited to a group. The registration
 * window only matters to students that want the system to match them." So a shut
 * window never leaves this screen saying only "no". Every state that cannot apply
 * says what still works, and the two things a student can fix — the rating and the
 * free time — are links to the screens that fix them.
 *
 * ONLINE ONLY, alone among the write screens. There is no optimistic row and no
 * outbox action: `request_matching`'s answer depends on a window being open at the
 * moment it runs and there is no withdrawal, so a queued yes could be refused
 * hours later with nothing left on screen to refuse it to. See `requestMatching`
 * in groups.ts, and the `matching.request` paragraph in outbox.ts.
 */
export default function ApplyForMatchingScreen() {
  const { profile } = useAuth();
  const router = useRouter();

  const userId = profile?.user_id ?? null;
  const { userCourses, loading, error, setLocal } = useUserCourses(userId);
  const { groups } = useMyGroups(userId);
  const {
    window: matchingWindow,
    loading: windowLoading,
    unavailable,
    reload: reloadWindow,
  } = useMatchingWindow(userId);

  const [busyCourseId, setBusyCourseId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  /**
   * Courses the student is already in a group on — the pool's own exclusion,
   * mirrored so a card can say "you already have a group here" instead of offering
   * to put them in a queue the run would pass over. Membership in ANY group counts,
   * archived included, which is exactly what run-batch-matching's pool query does.
   */
  const groupedCourseIds = useMemo(
    () => new Set(groups.map((g) => g.course_id)),
    [groups]
  );

  const phase = windowPhase(matchingWindow);
  const now = serverNow(matchingWindow);

  /**
   * Apply on one course.
   *
   * No optimistic write, deliberately, and this is the one screen in the app where
   * that is the right call: the value stored is the `applied_at` the SERVER
   * returned, because a device clock must not be what decides who applied before
   * the window shut. It is idempotent server-side, so a second tap after a lost
   * response returns the first timestamp rather than failing.
   *
   * A refusal re-reads the window. The likeliest one is the period having closed
   * between this screen loading and the tap, and leaving a stale "open until…"
   * banner above the error would make the app look like it was lying.
   */
  async function apply(row: UserCourseWithDetail) {
    if (!userId || row.applied_at) return;
    setFormError(null);
    setBusyCourseId(row.course_id);

    try {
      const appliedAt = await requestMatching(row.course_id);
      setLocal(
        userCourses.map((uc) =>
          uc.course_id === row.course_id ? { ...uc, applied_at: appliedAt } : uc
        )
      );
    } catch (err) {
      setFormError(friendlyError(err));
      void reloadWindow();
    } finally {
      setBusyCourseId(null);
    }
  }

  return (
    <Screen
      title="Apply to be matched"
      subtitle="Ask the system to place you in a group, one course at a time."
      footer={<Button label="Back" variant="secondary" onPress={() => router.back()} />}
    >
      {windowLoading && !matchingWindow && !unavailable ? (
        <ActivityIndicator color={colors.primaryDark} style={styles.loader} />
      ) : (
        <View style={[styles.banner, phase === 'open' && styles.bannerOpen]}>
          <Text style={styles.bannerText}>
            {unavailable
              ? "Can't check the matching period right now. Applying needs a connection — everything else here still works."
              : windowBanner(matchingWindow)}
          </Text>
        </View>
      )}

      {!!formError && (
        <Text style={styles.formError} accessibilityLiveRegion="polite">
          {formError}
        </Text>
      )}

      {loading && userCourses.length === 0 ? (
        <ActivityIndicator color={colors.primaryDark} style={styles.loader} />
      ) : error && userCourses.length === 0 ? (
        <Text style={styles.formError}>{error}</Text>
      ) : userCourses.length === 0 ? (
        <View>
          <Text style={styles.emptyText}>
            Matching works per course, and you have not picked any yet. Pick the ones
            you want a study group for and say how each is going — that pair is what a
            matching run reads.
          </Text>
          <Pressable
            onPress={() => router.push('/(app)/courses')}
            style={styles.linkRow}
            accessibilityRole="button"
            accessibilityLabel="Add courses"
          >
            <Text style={styles.link}>Add courses</Text>
          </Pressable>
        </View>
      ) : (
        userCourses.map((row) => (
          <CourseCard
            key={row.course_id}
            row={row}
            phase={phase}
            now={now}
            grouped={groupedCourseIds.has(row.course_id)}
            busy={busyCourseId === row.course_id}
            onApply={() => void apply(row)}
            onFixRating={() => router.push('/(app)/courses')}
            onFixAvailability={() => router.push('/(app)/profile')}
          />
        ))
      )}
    </Screen>
  );
}

/**
 * One enrolment: where it stands, what that means, and the single thing to do
 * about it.
 *
 * The step comes from `matchingStep`, which resolves 'grouped' before 'applied'
 * because `applied_at` is never cleared — see its note. Exactly one action is ever
 * offered, so there is never a choice to make about which of two buttons is the
 * one that helps.
 */
function CourseCard({
  row,
  phase,
  now,
  grouped,
  busy,
  onApply,
  onFixRating,
  onFixAvailability,
}: {
  row: UserCourseWithDetail;
  phase: WindowPhase;
  now: Date;
  grouped: boolean;
  busy: boolean;
  onApply: () => void;
  onFixRating: () => void;
  onFixAvailability: () => void;
}) {
  const code = row.course?.course_code ?? 'This course';
  const slots = countSelected(decodeAvailability(row.availability));
  const step = matchingStep(row, slots, grouped);

  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <Text style={styles.code}>{code}</Text>
        {busy && <ActivityIndicator size="small" color={colors.primaryDark} />}
      </View>
      {!!row.course?.course_title && (
        <Text style={styles.title} numberOfLines={2}>
          {row.course.course_title}
        </Text>
      )}

      <Text style={styles.stepTitle}>{MATCHING_STEP_TITLE[step]}</Text>
      <Text style={styles.hint}>{matchingStepBody(step, phase)}</Text>

      {step === 'applied' && !!row.applied_at && (
        <Text style={styles.hint}>Applied {windowWhenLabel(row.applied_at, now)}.</Text>
      )}

      {step === 'needs_rating' && (
        <Pressable
          onPress={onFixRating}
          style={styles.linkRow}
          accessibilityRole="button"
          accessibilityLabel={`Rate ${code}`}
        >
          <Text style={styles.link}>Say how {code} is going</Text>
        </Pressable>
      )}

      {step === 'needs_availability' && (
        <Pressable
          onPress={onFixAvailability}
          style={styles.linkRow}
          accessibilityRole="button"
          accessibilityLabel="Edit your availability"
        >
          <Text style={styles.link}>Pick your free time</Text>
        </Pressable>
      )}

      {step === 'ready' && (
        <Button
          label={`Apply for ${code}`}
          onPress={onApply}
          loading={busy}
          disabled={!canApplyForMatching(step, phase)}
          style={styles.apply}
          accessibilityHint="Puts you in the pool for the next matching run. This cannot be undone."
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  loader: { marginVertical: spacing.xl },
  banner: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  bannerOpen: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  bannerText: { fontSize: fontSize.sm, color: colors.text, lineHeight: 20 },
  card: {
    marginTop: spacing.md,
    padding: spacing.lg,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.lg,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  code: { fontSize: fontSize.sm, fontFamily: FONT.bold, color: colors.primaryDark },
  title: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2 },
  stepTitle: {
    fontSize: fontSize.md,
    fontFamily: FONT.bold,
    color: colors.text,
    marginTop: spacing.md,
  },
  hint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
    marginTop: spacing.sm,
  },
  apply: { marginTop: spacing.md },
  linkRow: { minHeight: MIN_TOUCH, justifyContent: 'center' },
  link: { fontSize: fontSize.sm, fontFamily: FONT.bold, color: colors.primaryDark },
  emptyText: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    lineHeight: 20,
    marginTop: spacing.md,
  },
  formError: {
    color: colors.danger,
    fontSize: fontSize.sm,
    marginTop: spacing.md,
    lineHeight: 20,
  },
});
