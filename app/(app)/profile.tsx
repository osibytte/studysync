import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AvailabilityGrid } from '@/components/AvailabilityGrid';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { TextField } from '@/components/TextField';
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
import { validateDepartment, validateFullName } from '@/lib/validation';
import { FONT, colors, fontSize, radius, spacing } from '@/theme';

/**
 * Profile editing — name, department, availability, and a route to course
 * management.
 *
 * Editing availability here applies the grid to every enrolled course, matching
 * the onboarding behaviour. Per-course availability is supported by the schema
 * and can be layered on later without a migration.
 */
export default function ProfileScreen() {
  const { profile, applyLocalProfilePatch, refreshProfile, signOut } = useAuth();
  const { isOnline, refreshPending } = useNetwork();
  const router = useRouter();

  const userId = profile?.user_id ?? null;
  const { userCourses, setLocal } = useUserCourses(userId);

  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [department, setDepartment] = useState(profile?.department ?? '');
  const [grid, setGrid] = useState<Grid>(emptyGrid());
  const [seeded, setSeeded] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (seeded || userCourses.length === 0) return;
    const withSlots = userCourses.find(
      (uc) => countSelected(decodeAvailability(uc.availability)) > 0
    );
    if (withSlots) setGrid(decodeAvailability(withSlots.availability));
    setSeeded(true);
  }, [userCourses, seeded]);

  async function handleSave() {
    if (!profile || !userId) return;
    setFormError(null);
    setStatus(null);

    const nextErrors = {
      fullName: validateFullName(fullName) ?? undefined,
      department: validateDepartment(department) ?? undefined,
    };
    if (Object.values(nextErrors).some(Boolean)) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});

    const patch = { full_name: fullName.trim(), department: department.trim() };
    const mask = encodeAvailability(grid);

    setSaving(true);
    try {
      applyLocalProfilePatch(patch);
      setLocal(userCourses.map((uc) => ({ ...uc, availability: mask })));

      if (isOnline) {
        const { error: profileError } = await supabase
          .from('users')
          .update(patch)
          .eq('user_id', userId);
        if (profileError) throw profileError;

        if (userCourses.length > 0) {
          const { error: availError } = await supabase
            .from('user_courses')
            .update({ availability: mask })
            .eq('user_id', userId);
          if (availError) throw availError;
        }

        await refreshProfile();
        setStatus('Saved.');
      } else {
        await enqueue('profile.update', patch, userId);
        for (const uc of userCourses) {
          if (uc.user_course_id.startsWith('temp-')) continue;
          await enqueue(
            'availability.set',
            { user_course_id: uc.user_course_id, availability: mask },
            userId
          );
        }
        await refreshPending();
        setStatus('Saved locally — will sync when you are back online.');
      }
    } catch (error) {
      try {
        await enqueue('profile.update', patch, userId);
        for (const uc of userCourses) {
          if (uc.user_course_id.startsWith('temp-')) continue;
          await enqueue(
            'availability.set',
            { user_course_id: uc.user_course_id, availability: mask },
            userId
          );
        }
        await refreshPending();
        setStatus('Saved locally — will sync when you are back online.');
      } catch {
        setFormError(friendlyError(error));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen
      title="Your profile"
      footer={
        <View>
          <Button
            label="Save changes"
            onPress={() => void handleSave()}
            loading={saving}
            disabled={saving}
          />
          {/* No back button: this is a tab, the bar below is the way out. */}
        </View>
      }
    >
      <TextField
        label="Full name"
        value={fullName}
        onChangeText={setFullName}
        autoCapitalize="words"
        error={errors.fullName}
        editable={!saving}
      />
      <TextField
        label="Department"
        value={department}
        onChangeText={setDepartment}
        autoCapitalize="words"
        error={errors.department}
        editable={!saving}
      />

      <Text style={styles.sectionHeader}>Courses</Text>
      {userCourses.length === 0 ? (
        <Text style={styles.emptyText}>No courses yet.</Text>
      ) : (
        userCourses.map((uc) => (
          <View
            key={uc.user_course_id}
            style={styles.courseRow}
            accessibilityLabel={`${uc.course?.course_code}, ${uc.course?.course_title}`}
          >
            <View style={styles.courseTextCol}>
              <Text style={styles.courseCode}>{uc.course?.course_code}</Text>
              <Text style={styles.courseTitle} numberOfLines={1}>
                {uc.course?.course_title}
              </Text>
            </View>
          </View>
        ))
      )}

      <Button
        label="Add or remove courses"
        variant="secondary"
        onPress={() => router.push('/(app)/courses')}
        style={styles.manageCourses}
      />

      <Text style={styles.sectionHeader}>Weekly availability</Text>
      <AvailabilityGrid grid={grid} onChange={setGrid} />

      {!!formError && (
        <Text style={styles.formError} accessibilityLiveRegion="polite">
          {formError}
        </Text>
      )}
      {!!status && (
        <Text style={styles.status} accessibilityLiveRegion="polite">
          {status}
        </Text>
      )}

      <Text style={styles.sectionHeader}>Notifications</Text>
      <Button
        label="Notification settings"
        variant="secondary"
        onPress={() => router.push('/(app)/notification-settings')}
      />

      <Button
        label="Sign out"
        variant="ghost"
        onPress={() => void signOut()}
        style={styles.signOut}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  sectionHeader: {
    fontSize: fontSize.md,
    fontFamily: FONT.bold,
    color: colors.text,
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  emptyText: { fontSize: fontSize.sm, color: colors.textMuted },
  courseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
  },
  courseTextCol: { flex: 1 },
  courseCode: { fontSize: fontSize.sm, fontFamily: FONT.bold, color: colors.primaryDark },
  courseTitle: { fontSize: fontSize.sm, color: colors.text, marginTop: 2 },
  manageCourses: { marginTop: spacing.sm },
  formError: { color: colors.danger, fontSize: fontSize.sm, marginTop: spacing.md },
  status: { color: colors.success, fontSize: fontSize.sm, marginTop: spacing.md },

  signOut: { marginTop: spacing.xxl },
});
