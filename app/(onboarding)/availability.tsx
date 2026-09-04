import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AvailabilityGrid } from '@/components/AvailabilityGrid';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { StepHeader } from '@/components/StepHeader';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useUserCourses } from '@/hooks/useUserCourses';
import {
  type AvailabilityGrid as Grid,
  countSelected,
  decodeAvailability,
  emptyGrid,
  encodeAvailability,
} from '@/lib/availability';
import { enqueue } from '@/lib/outbox';
import { friendlyError, supabase } from '@/lib/supabase';
import { colors, fontSize, radius, spacing } from '@/theme';

/**
 * Onboarding step 3 of 3 — weekly availability.
 *
 * One grid applied to every enrolled course, not a grid per course.
 *
 * The schema stores availability per user_course, which is more flexible, but
 * asking a student to fill in four separate grids during onboarding would blow
 * the 5-minute target on its own. So onboarding writes one grid to all rows,
 * and the profile screen can offer per-course editing later for anyone who
 * wants it. The schema supports that without a migration.
 */
export default function OnboardingAvailabilityScreen() {
  const { profile, applyLocalProfilePatch, refreshProfile } = useAuth();
  const { isOnline, refreshPending } = useNetwork();
  const router = useRouter();

  const userId = profile?.user_id ?? null;
  const { userCourses, setLocal } = useUserCourses(userId);

  const [grid, setGrid] = useState<Grid>(emptyGrid());
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /**
   * Seed from whichever course already has availability, so re-entering the
   * flow does not wipe a previous selection. Only once — after that the
   * student's edits own the state.
   */
  useEffect(() => {
    if (seeded || userCourses.length === 0) return;
    const existing = userCourses.find((uc) => countSelected(decodeAvailability(uc.availability)) > 0);
    if (existing) setGrid(decodeAvailability(existing.availability));
    setSeeded(true);
  }, [userCourses, seeded]);

  const selected = countSelected(grid);

  async function handleFinish() {
    if (!userId || !profile) return;
    setFormError(null);

    if (selected === 0) {
      setFormError('Pick at least one time slot so we can match your schedule.');
      return;
    }

    const mask = encodeAvailability(grid);
    setSaving(true);

    try {
      // Optimistic local update for both availability and the completion flag,
      // so home renders correctly even if the writes queue.
      setLocal(userCourses.map((uc) => ({ ...uc, availability: mask })));
      applyLocalProfilePatch({ onboarding_complete: true });

      if (isOnline) {
        // One statement for every enrolment rather than a loop of updates:
        // fewer requests, and it either all lands or none of it does.
        const { error: availError } = await supabase
          .from('user_courses')
          .update({ availability: mask })
          .eq('user_id', userId);
        if (availError) throw availError;

        const { error: profileError } = await supabase
          .from('users')
          .update({ onboarding_complete: true })
          .eq('user_id', userId);
        if (profileError) throw profileError;

        await refreshProfile();
      } else {
        // Queued per row, because the outbox action targets a user_course_id.
        // Rows still holding a temp- id are skipped: their course.add action is
        // ahead of them in the queue and carries the availability itself.
        for (const uc of userCourses) {
          if (uc.user_course_id.startsWith('temp-')) continue;
          await enqueue(
            'availability.set',
            { user_course_id: uc.user_course_id, availability: mask },
            userId
          );
        }
        await enqueue('profile.update', { onboarding_complete: true }, userId);
        await refreshPending();
      }

      router.replace('/(app)/home');
    } catch (error) {
      try {
        for (const uc of userCourses) {
          if (uc.user_course_id.startsWith('temp-')) continue;
          await enqueue(
            'availability.set',
            { user_course_id: uc.user_course_id, availability: mask },
            userId
          );
        }
        await enqueue('profile.update', { onboarding_complete: true }, userId);
        await refreshPending();
        router.replace('/(app)/home');
      } catch {
        setFormError(friendlyError(error));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen
      title="When are you free?"
      subtitle="Tap the blocks you're usually available. Tap a day name to select the whole day."
      footer={
        <Button
          label="Finish setup"
          onPress={() => void handleFinish()}
          loading={saving}
          disabled={saving}
        />
      }
    >
      <StepHeader step={3} total={3} />

      <AvailabilityGrid grid={grid} onChange={setGrid} />

      <View style={styles.noteBox}>
        <Text style={styles.noteText}>
          This applies to all {userCourses.length} of your courses. You can set different
          times per course later from your profile.
        </Text>
      </View>

      {!!formError && (
        <Text style={styles.formError} accessibilityLiveRegion="polite">
          {formError}
        </Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  noteBox: {
    marginTop: spacing.xl,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
  },
  noteText: { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 18 },
  formError: { color: colors.danger, fontSize: fontSize.sm, marginTop: spacing.md },
});
