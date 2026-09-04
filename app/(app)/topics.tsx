import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useTopics } from '@/hooks/useCourses';
import { useUserCourses } from '@/hooks/useUserCourses';
import { enqueue } from '@/lib/outbox';
import { friendlyError, supabase } from '@/lib/supabase';
import { MIN_TOUCH, colors, fontSize, radius, spacing } from '@/theme';

/**
 * Topic selection for one enrolled course.
 *
 * Topics carry the heaviest weight (0.5) in the compatibility score, so this is
 * the highest-leverage screen in onboarding for match quality. It is still
 * optional: a student with no topics matches on course plus schedule, which is
 * the spec's own relaxed-filter path.
 *
 * Reached from home rather than sitting in the onboarding flow, deliberately.
 * Adding a fourth required step for every course would cost more onboarding
 * time than the match-quality gain is worth.
 */
export default function TopicsScreen() {
  const params = useLocalSearchParams<{ userCourseId?: string; courseId?: string }>();
  const router = useRouter();
  const { profile } = useAuth();
  const { isOnline, refreshPending } = useNetwork();

  const userId = profile?.user_id ?? null;
  const courseId = params.courseId ?? null;
  const userCourseId = params.userCourseId ?? null;

  const { topics, loading, error } = useTopics(courseId);
  const { userCourses, setLocal } = useUserCourses(userId);

  const userCourse = useMemo(
    () => userCourses.find((uc) => uc.user_course_id === userCourseId),
    [userCourses, userCourseId]
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Seed once from the server state, then let local edits own it.
  useEffect(() => {
    if (seeded || !userCourse) return;
    setSelected(new Set(userCourse.topic_ids));
    setSeeded(true);
  }, [userCourse, seeded]);

  function toggle(topicId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(topicId)) next.delete(topicId);
      else next.add(topicId);
      return next;
    });
  }

  async function handleSave() {
    if (!userId || !userCourseId) return;
    setFormError(null);

    /**
     * A temp- id means the parent user_course has not been persisted yet, so
     * there is no row for these topics to attach to. The topics.set action
     * would fail its FK check. Ask the student to sync first rather than
     * silently dropping their selection.
     */
    if (userCourseId.startsWith('temp-')) {
      setFormError(
        'This course is still syncing. Pull to refresh on the home screen once you are back online, then set topics.'
      );
      return;
    }

    const topicIds = Array.from(selected);
    setSaving(true);

    try {
      setLocal(
        userCourses.map((uc) =>
          uc.user_course_id === userCourseId ? { ...uc, topic_ids: topicIds } : uc
        )
      );

      if (isOnline) {
        // Replace rather than diff — same reasoning as the outbox handler:
        // the selection is the full intended state, and delete-then-insert is
        // simpler to reason about than computing a delta.
        const { error: delError } = await supabase
          .from('user_course_topics')
          .delete()
          .eq('user_course_id', userCourseId);
        if (delError) throw delError;

        if (topicIds.length > 0) {
          const { error: insError } = await supabase
            .from('user_course_topics')
            .insert(topicIds.map((topic_id) => ({ user_course_id: userCourseId, topic_id })));
          if (insError) throw insError;
        }
      } else {
        await enqueue('topics.set', { user_course_id: userCourseId, topic_ids: topicIds }, userId);
        await refreshPending();
      }

      router.back();
    } catch (err) {
      try {
        await enqueue('topics.set', { user_course_id: userCourseId, topic_ids: topicIds }, userId);
        await refreshPending();
        router.back();
      } catch {
        setFormError(friendlyError(err));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen
      title={userCourse?.course?.course_code ?? 'Topics'}
      subtitle={
        userCourse?.course?.course_title
          ? `Which parts of ${userCourse.course.course_title} do you want to study with others?`
          : 'Pick the topics you want to study with others.'
      }
      footer={
        <View>
          <Button
            label={saving ? 'Saving...' : `Save ${selected.size} topic${selected.size === 1 ? '' : 's'}`}
            onPress={() => void handleSave()}
            loading={saving}
            disabled={saving}
          />
          <Button label="Cancel" variant="ghost" onPress={() => router.back()} style={styles.cancel} />
        </View>
      }
    >
      {loading && topics.length === 0 ? (
        <ActivityIndicator color={colors.primary} />
      ) : error && topics.length === 0 ? (
        <Text style={styles.emptyText}>{error}</Text>
      ) : topics.length === 0 ? (
        <Text style={styles.emptyText}>
          No topics have been set up for this course yet. Matching will still work on course
          and schedule.
        </Text>
      ) : (
        <View>
          {topics.map((topic) => {
            const on = selected.has(topic.topic_id);
            return (
              <Pressable
                key={topic.topic_id}
                onPress={() => toggle(topic.topic_id)}
                style={[styles.chipRow, on && styles.chipRowOn]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={topic.topic_name}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{topic.topic_name}</Text>
                <View style={[styles.checkbox, on && styles.checkboxOn]}>
                  {on && <Text style={styles.checkMark}>✓</Text>}
                </View>
              </Pressable>
            );
          })}
        </View>
      )}

      {!!formError && (
        <Text style={styles.formError} accessibilityLiveRegion="polite">
          {formError}
        </Text>
      )}

      <Text style={styles.hint}>
        Topics are weighted most heavily when finding partners, so pick the ones you actually
        want help with rather than everything.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
  },
  chipRowOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipText: { flex: 1, fontSize: fontSize.sm, color: colors.text, paddingRight: spacing.md },
  chipTextOn: { fontWeight: '600' },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkMark: { color: colors.primary, fontWeight: '700', fontSize: fontSize.xs },
  emptyText: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 20 },
  formError: { color: colors.danger, fontSize: fontSize.sm, marginTop: spacing.md },
  hint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
    marginTop: spacing.xl,
  },
  cancel: { marginTop: spacing.sm },
});
