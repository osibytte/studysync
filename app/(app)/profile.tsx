import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Feather } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AvailabilityGrid } from '@/components/AvailabilityGrid';
import { Button } from '@/components/Button';
import { BandScreen } from '@/components/BandScreen';
import { Initials, initialsOf } from '@/components/Initials';
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
import { FONT, colors, fontSize, radius, shadowCard, spacing, typography } from '@/theme';

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
    <BandScreen title="Profile" bandExtra={44} sheetStyle={styles.sheet}>
      <View style={styles.who}>
        <Initials
          text={initialsOf(profile?.full_name)}
          colorKey={profile?.user_id}
          size={96}
          shape="circle"
          ring
        />
        <Text style={styles.name} accessibilityRole="header" numberOfLines={2}>
          {profile?.full_name || 'Your profile'}
        </Text>
        {!!profile?.department && (
          <View style={styles.deptBadge}>
            <Feather name="book-open" size={13} color={colors.textInverse} />
            <Text style={styles.deptText}>{profile.department}</Text>
          </View>
        )}
      </View>

      <Text style={styles.sectionHeader} accessibilityRole="header">
        Details
      </Text>
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

      <View style={styles.sectionRow}>
        <Text style={styles.sectionHeaderInline} accessibilityRole="header">
          Courses
        </Text>
        <Pressable
          onPress={() => router.push('/(app)/courses')}
          accessibilityRole="button"
          accessibilityLabel="Add or remove courses"
          hitSlop={12}
        >
          <Text style={styles.link}>Add or remove</Text>
        </Pressable>
      </View>
      {userCourses.length === 0 ? (
        <Text style={styles.emptyText}>No courses yet.</Text>
      ) : (
        <View style={styles.chips}>
          {userCourses.map((uc) => (
            <View
              key={uc.user_course_id}
              style={styles.chip}
              accessible
              accessibilityLabel={`${uc.course?.course_code}, ${uc.course?.course_title}`}
            >
              <Text style={styles.chipText}>{uc.course?.course_code}</Text>
            </View>
          ))}
        </View>
      )}

      <Text style={styles.sectionHeader} accessibilityRole="header">
        Weekly availability
      </Text>
      <View style={styles.card}>
        <AvailabilityGrid grid={grid} onChange={setGrid} />
      </View>

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
      {/*
        Inline rather than pinned: a pinned bar would sit under the floating tab
        bar. It follows the last thing you can edit.
      */}
      <Button
        label="Save changes"
        onPress={() => void handleSave()}
        loading={saving}
        disabled={saving}
        style={styles.save}
      />

      <Text style={styles.sectionHeader} accessibilityRole="header">
        Settings
      </Text>
      <View style={styles.rows}>
        <Pressable
          onPress={() => router.push('/(app)/notification-settings')}
          accessibilityRole="button"
          accessibilityLabel="Notification settings"
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        >
          <View style={[styles.rowIcon, { backgroundColor: colors.primarySoft }]}>
            <Feather name="bell" size={17} color={colors.primaryDark} />
          </View>
          <Text style={styles.rowText}>Notifications</Text>
          <Feather name="chevron-right" size={18} color={colors.textMuted} />
        </Pressable>
        <View style={styles.rowRule} />
        <Pressable
          onPress={() => void signOut()}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        >
          <View style={[styles.rowIcon, { backgroundColor: colors.dangerSoft }]}>
            <Feather name="log-out" size={17} color={colors.danger} />
          </View>
          <Text style={[styles.rowText, { color: colors.danger }]}>Sign out</Text>
        </Pressable>
      </View>
    </BandScreen>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingTop: 0 },
  // Pulled up over the band, like a profile photo on a cover.
  who: { alignItems: 'center', marginTop: -64, marginBottom: spacing.sm },
  name: {
    ...typography.title,
    fontFamily: FONT.extra,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  deptBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.sm + 2,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.success,
  },
  deptText: { fontSize: fontSize.sm - 1, fontFamily: FONT.semi, color: colors.textInverse },

  sectionHeader: { ...typography.section, marginTop: spacing.xl + 2, marginBottom: spacing.md, paddingHorizontal: 2 },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: 2,
  },
  sectionHeaderInline: { ...typography.section },
  link: { fontSize: fontSize.sm, fontFamily: FONT.semi, color: colors.text, textDecorationLine: 'underline' },
  emptyText: { fontSize: fontSize.sm, fontFamily: FONT.regular, color: colors.textMuted },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    ...shadowCard,
  },
  chipText: { fontSize: fontSize.sm, fontFamily: FONT.semi, color: colors.textSecondary },

  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, ...shadowCard },
  formError: { color: colors.danger, fontFamily: FONT.regular, fontSize: fontSize.sm, marginTop: spacing.md },
  status: { color: colors.success, fontFamily: FONT.semi, fontSize: fontSize.sm, marginTop: spacing.md },
  save: { marginTop: spacing.lg },

  rows: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    ...shadowCard,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 60 },
  rowPressed: { opacity: 0.7 },
  rowRule: { height: 1, backgroundColor: colors.border },
  rowIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, fontSize: fontSize.md, fontFamily: FONT.semi, color: colors.text },
});
