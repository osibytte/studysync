import { useRouter } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/Button';
import { OfflineBanner } from '@/components/OfflineBanner';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useUserCourses } from '@/hooks/useUserCourses';
import { countSelected, decodeAvailability, describeSelection } from '@/lib/availability';
import { colors, fontSize, radius, spacing, typography } from '@/theme';

/**
 * Home — Stage 1 endpoint.
 *
 * Shows the profile the student just built and gives them somewhere to edit it.
 * The "Find a group" affordance is intentionally a disabled placeholder: that
 * is Stage 2, and shipping a live-looking button that does nothing is worse
 * than showing an honest "coming next".
 */
export default function HomeScreen() {
  const { profile, signOut } = useAuth();
  const { syncNow, syncing } = useNetwork();
  const router = useRouter();

  const userId = profile?.user_id ?? null;
  const { userCourses, loading, reload } = useUserCourses(userId);

  const onRefresh = useCallback(async () => {
    // Drain the outbox before refetching, or a pull-to-refresh would overwrite
    // pending local changes with older server state.
    await syncNow();
    await reload();
  }, [syncNow, reload]);

  const totalTopics = useMemo(
    () => userCourses.reduce((n, uc) => n + uc.topic_ids.length, 0),
    [userCourses]
  );

  const availabilityGrid = useMemo(() => {
    const withSlots = userCourses.find(
      (uc) => countSelected(decodeAvailability(uc.availability)) > 0
    );
    return withSlots ? decodeAvailability(withSlots.availability) : null;
  }, [userCourses]);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <OfflineBanner />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={syncing} onRefresh={() => void onRefresh()} tintColor={colors.primary} />
        }
      >
        <Text style={styles.greeting}>
          Hi{profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}
        </Text>
        <Text style={styles.subtitle}>
          {profile?.department ?? 'Department not set'}
        </Text>

        {/* Stage 2 placeholder — honest about not being built yet. */}
        <View style={styles.nextCard}>
          <Text style={styles.nextTitle}>Find a study group</Text>
          <Text style={styles.nextBody}>
            Matching arrives in the next build stage. Your courses, topics and availability
            are what it will use, so keeping them accurate now pays off later.
          </Text>
          <Button label="Coming in Stage 2" onPress={() => {}} disabled variant="secondary" />
        </View>

        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionHeaderInline}>Your courses</Text>
          <Pressable
            onPress={() => router.push('/(app)/profile')}
            accessibilityRole="button"
            accessibilityLabel="Edit your profile and courses"
          >
            <Text style={styles.editLink}>Edit</Text>
          </Pressable>
        </View>

        {loading && userCourses.length === 0 ? (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        ) : userCourses.length === 0 ? (
          <Text style={styles.emptyText}>
            No courses yet. Tap Edit to add the courses you want partners for.
          </Text>
        ) : (
          userCourses.map((uc) => (
            <Pressable
              key={uc.user_course_id}
              style={styles.courseCard}
              onPress={() =>
                router.push({
                  pathname: '/(app)/topics',
                  params: { userCourseId: uc.user_course_id, courseId: uc.course_id },
                })
              }
              accessibilityRole="button"
              accessibilityLabel={`${uc.course?.course_code}, ${uc.topic_ids.length} topics selected. Tap to change topics.`}
            >
              <View style={styles.courseTextCol}>
                <Text style={styles.courseCode}>{uc.course?.course_code}</Text>
                <Text style={styles.courseTitle} numberOfLines={1}>
                  {uc.course?.course_title}
                </Text>
                <Text style={styles.courseMeta}>
                  {uc.topic_ids.length === 0
                    ? 'No topics picked — tap to add'
                    : `${uc.topic_ids.length} topic${uc.topic_ids.length === 1 ? '' : 's'}`}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))
        )}

        <Text style={styles.sectionHeader}>Your availability</Text>
        <View style={styles.availCard}>
          <Text style={styles.availText}>
            {availabilityGrid ? describeSelection(availabilityGrid, 4) : 'Not set yet'}
          </Text>
          {!!availabilityGrid && (
            <Text style={styles.availCount}>
              {countSelected(availabilityGrid)} slots per week
            </Text>
          )}
        </View>

        <View style={styles.statsRow}>
          <Stat label="Courses" value={String(userCourses.length)} />
          <Stat label="Topics" value={String(totalTopics)} />
          <Stat
            label="Free slots"
            value={availabilityGrid ? String(countSelected(availabilityGrid)) : '0'}
          />
        </View>

        <Button
          label="Sign out"
          variant="ghost"
          onPress={() => void signOut()}
          style={styles.signOut}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  greeting: { ...typography.title },
  subtitle: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: spacing.xs },
  nextCard: {
    marginTop: spacing.xl,
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
  },
  nextTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  nextBody: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    lineHeight: 20,
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xxl,
    marginBottom: spacing.md,
  },
  sectionHeader: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
    marginTop: spacing.xxl,
    marginBottom: spacing.md,
  },
  // Same look, but the wrapping row already supplies the vertical spacing.
  sectionHeaderInline: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
  },
  editLink: { fontSize: fontSize.sm, fontWeight: '600', color: colors.primary },
  loader: { marginVertical: spacing.lg },
  emptyText: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 20 },
  courseCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
  },
  courseTextCol: { flex: 1 },
  courseCode: { fontSize: fontSize.sm, fontWeight: '700', color: colors.primary },
  courseTitle: { fontSize: fontSize.sm, color: colors.text, marginTop: 2 },
  courseMeta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.xs },
  chevron: { fontSize: fontSize.xl, color: colors.borderStrong, paddingHorizontal: spacing.sm },
  availCard: { padding: spacing.md, backgroundColor: colors.surface, borderRadius: radius.md },
  availText: { fontSize: fontSize.sm, color: colors.text, lineHeight: 20 },
  availCount: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.xs },
  statsRow: { flexDirection: 'row', marginTop: spacing.xl },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { fontSize: fontSize.xl, fontWeight: '700', color: colors.primary },
  statLabel: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  signOut: { marginTop: spacing.xxl },
});
