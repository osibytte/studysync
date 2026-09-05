import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useMyGroups } from '@/hooks/useMyGroups';
import { useUserCourses } from '@/hooks/useUserCourses';
import {
  MATCHING_PREF_HINT,
  MATCHING_PREF_LABEL,
  inMatchingPool,
} from '@/lib/groupRules';
import { setMatchingPref } from '@/lib/groups';
import { enqueue } from '@/lib/outbox';
import { friendlyError } from '@/lib/supabase';
import { MIN_TOUCH, colors, fontSize, radius, spacing } from '@/theme';
import type { MatchingPref, UserCourseWithDetail } from '@/types/database';

/** Rendered in this order: the default first, so the list reads as opt-out. */
const PREFS: readonly MatchingPref[] = ['system', 'self_organized'];

/**
 * "How you get matched" — the per-course switch between being placed by a
 * coordinator's matching run and finding your own group.
 *
 * Per course rather than per student because `matching_pref` is a column on
 * `user_courses` (0007): a student may want placing on the course they are
 * struggling with and left alone on the one where they already have friends.
 *
 * The setting changes what a MATCHING RUN does and nothing else. Suggestions,
 * browsing, requests and invitations work identically either way, and the hints
 * say so — "opt out" otherwise reads as "opt out of study groups".
 *
 * Offline-capable, unlike the rest of the group screens: it hands out no seat
 * and nobody else has to answer it, so a change that lands minutes later is
 * honoured in full (see the `matching.pref` note in outbox.ts).
 */
export default function MatchingPrefScreen() {
  const { profile } = useAuth();
  const { isOnline, refreshPending } = useNetwork();
  const router = useRouter();

  const userId = profile?.user_id ?? null;
  const { userCourses, loading, error, setLocal } = useUserCourses(userId);
  const { groups } = useMyGroups(userId);

  const [busyCourseId, setBusyCourseId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  /**
   * Courses the student is already in a group on — the matching pool's own
   * exclusion, mirrored so the screen can explain an opted-in course that will
   * still be skipped. Membership in ANY group counts, archived included, which
   * is exactly what run-batch-matching's pool query does.
   */
  const groupedCourseIds = useMemo(
    () => new Set(groups.map((g) => g.course_id)),
    [groups]
  );

  /**
   * Write the new preference, optimistically.
   *
   * Same three-branch shape as the course picker: write it online, queue it when
   * offline, and queue it as the fallback when an online write throws — a
   * dropped connection mid-tap is the common case, not the exotic one. Only a
   * failure to do either rolls the row back.
   */
  async function choose(row: UserCourseWithDetail, pref: MatchingPref) {
    if (!userId || row.matching_pref === pref) return;
    setFormError(null);
    setBusyCourseId(row.course_id);

    const previous = userCourses;
    setLocal(
      userCourses.map((uc) =>
        uc.course_id === row.course_id ? { ...uc, matching_pref: pref } : uc
      )
    );

    try {
      if (isOnline) {
        await setMatchingPref(row.course_id, pref);
      } else {
        await enqueue('matching.pref', { course_id: row.course_id, pref }, userId);
        await refreshPending();
        setQueued(true);
      }
    } catch (err) {
      try {
        await enqueue('matching.pref', { course_id: row.course_id, pref }, userId);
        await refreshPending();
        setQueued(true);
      } catch {
        setLocal(previous);
        setFormError(friendlyError(err));
      }
    } finally {
      setBusyCourseId(null);
    }
  }

  return (
    <Screen
      title="How you get matched"
      subtitle="One choice per course. Either way you can still browse groups, ask to join, and invite people."
      footer={<Button label="Back" variant="secondary" onPress={() => router.back()} />}
    >
      {loading && userCourses.length === 0 ? (
        <ActivityIndicator color={colors.primary} style={styles.loader} />
      ) : error && userCourses.length === 0 ? (
        <Text style={styles.formError}>{error}</Text>
      ) : userCourses.length === 0 ? (
        <View>
          <Text style={styles.emptyText}>
            This is a per-course setting, and you are not enrolled in any course yet.
          </Text>
          <Pressable
            onPress={() => router.push('/(app)/courses')}
            accessibilityRole="button"
            accessibilityLabel="Add courses"
          >
            <Text style={styles.link}>Add courses</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {!!formError && (
            <Text style={styles.formError} accessibilityLiveRegion="polite">
              {formError}
            </Text>
          )}
          {queued && (
            <Text style={styles.note} accessibilityLiveRegion="polite">
              Saved on this device. It reaches the server the next time you are
              online, and matching runs read it there — so it applies from then on.
            </Text>
          )}

          {userCourses.map((row) => (
            <CourseCard
              key={row.course_id}
              row={row}
              grouped={groupedCourseIds.has(row.course_id)}
              busy={busyCourseId === row.course_id}
              onChoose={(pref) => void choose(row, pref)}
            />
          ))}
        </>
      )}
    </Screen>
  );
}
/** One enrolment: the course, the two choices, and what the current one means. */
function CourseCard({
  row,
  grouped,
  busy,
  onChoose,
}: {
  row: UserCourseWithDetail;
  grouped: boolean;
  busy: boolean;
  onChoose: (pref: MatchingPref) => void;
}) {
  const code = row.course?.course_code ?? 'This course';
  const pooled = inMatchingPool(row.matching_pref, grouped);

  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <Text style={styles.code}>{code}</Text>
        {busy && <ActivityIndicator size="small" color={colors.primary} />}
      </View>
      {!!row.course?.course_title && (
        <Text style={styles.title} numberOfLines={2}>
          {row.course.course_title}
        </Text>
      )}

      {PREFS.map((pref) => {
        const on = row.matching_pref === pref;
        return (
          <Pressable
            key={pref}
            onPress={() => onChoose(pref)}
            disabled={busy}
            style={[styles.option, on && styles.optionOn]}
            accessibilityRole="radio"
            accessibilityState={{ selected: on, busy }}
            accessibilityLabel={`${MATCHING_PREF_LABEL[pref]}, for ${code}`}
            accessibilityHint={MATCHING_PREF_HINT[pref]}
          >
            <View style={[styles.radio, on && styles.radioOn]}>
              {on && <View style={styles.radioDot} />}
            </View>
            <Text style={[styles.optionLabel, on && styles.optionLabelOn]}>
              {MATCHING_PREF_LABEL[pref]}
            </Text>
          </Pressable>
        );
      })}

      <Text style={styles.hint}>{MATCHING_PREF_HINT[row.matching_pref]}</Text>

      {row.matching_pref === 'system' && !pooled && (
        <Text style={styles.hint}>
          You are already in a group on {code}, so a run would pass over you. This
          takes effect again if you leave that group.
        </Text>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  loader: { marginVertical: spacing.xl },
  card: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  code: { fontSize: fontSize.sm, fontWeight: '700', color: colors.primary },
  title: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginTop: spacing.sm,
  },
  optionOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  optionLabel: { flex: 1, fontSize: fontSize.sm, color: colors.text },
  optionLabelOn: { fontWeight: '700' },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  radioOn: { borderColor: colors.primary },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.primary,
  },
  hint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
    marginTop: spacing.sm,
  },
  note: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
    marginTop: spacing.md,
  },
  emptyText: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    lineHeight: 20,
    marginTop: spacing.md,
  },
  link: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.primary,
    marginTop: spacing.sm,
  },
  formError: {
    color: colors.danger,
    fontSize: fontSize.sm,
    marginTop: spacing.md,
    lineHeight: 20,
  },
});
