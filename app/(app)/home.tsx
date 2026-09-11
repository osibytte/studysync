import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useRef } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/Button';
import { OfflineBanner } from '@/components/OfflineBanner';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useInvitations } from '@/hooks/useInvitations';
import { useMyGroups } from '@/hooks/useMyGroups';
import { useNotificationBadge } from '@/hooks/useNotifications';
import { useUnread } from '@/hooks/useUnread';
import { useUserCourses } from '@/hooks/useUserCourses';
import { countSelected, decodeAvailability, describeSelection } from '@/lib/availability';
import { FONT, MIN_TOUCH, colors, fontSize, radius, spacing, typography } from '@/theme';

/**
 * Home.
 *
 * Leads with groups, because from Stage 2 on that is what the student opens the
 * app for; the profile they built in onboarding sits below it, where it is still
 * easy to correct but no longer the point of the screen. Courses and availability
 * stay visible on purpose — they are the two inputs matching actually uses, so a
 * thin one of either should be obvious without going looking for it.
 */
export default function HomeScreen() {
  const { profile, signOut } = useAuth();
  const { syncNow, syncing } = useNetwork();
  const router = useRouter();

  const userId = profile?.user_id ?? null;
  const { userCourses, loading, reload } = useUserCourses(userId);
  const { groups, reload: reloadGroups } = useMyGroups(userId);
  const { invitations, reload: reloadInvites } = useInvitations(userId);
  const { summary: unreadSummaryLine, reload: reloadUnread } = useUnread(userId);
  const { unread: unreadNotifications, reload: reloadBadge } = useNotificationBadge(userId);

  const onRefresh = useCallback(async () => {
    // Drain the outbox before refetching, or a pull-to-refresh would overwrite
    // pending local changes with older server state.
    await syncNow();
    await Promise.all([
      reload(),
      reloadGroups(),
      reloadInvites(),
      reloadUnread(),
      reloadBadge(),
    ]);
  }, [syncNow, reload, reloadGroups, reloadInvites, reloadUnread, reloadBadge]);

  /**
   * Refetch the group counts when home comes back into focus.
   *
   * This screen stays mounted while the student joins, creates or leaves a group
   * in the groups section, so without this the card would keep reporting the
   * count from before. The first focus is skipped — each hook fetches on mount.
   *
   * `useUnread` is deliberately absent: it runs its own focus effect, so listing
   * it here would fetch the counts twice on every return. `useNotificationBadge`
   * is absent for the same reason.
   */
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void reloadGroups();
      void reloadInvites();
    }, [reloadGroups, reloadInvites])
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
          <RefreshControl refreshing={syncing} onRefresh={() => void onRefresh()} tintColor={colors.primaryDark} />
        }
      >
        <View style={styles.greetingRow}>
          <View style={styles.greetingCol}>
            <Text style={styles.greeting}>
              Hi{profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}
            </Text>
            <Text style={styles.subtitle}>
              {profile?.department ?? 'Department not set'}
            </Text>
          </View>
          {/*
            The inbox lives here rather than in a card, because it is a place
            rather than a thing that happened — and the count is the only part of
            it worth interrupting the screen for. The number is a bare digit and
            the label always spells "Notifications" out, so it reads the same in
            greyscale and to a screen reader.
          */}
          <Pressable
            onPress={() => router.push('/(app)/notifications')}
            accessibilityRole="button"
            accessibilityLabel={
              unreadNotifications > 0
                ? `Notifications, ${unreadNotifications} unread`
                : 'Notifications'
            }
            style={({ pressed }) => [styles.bell, pressed && styles.bellPressed]}
          >
            <Text style={styles.bellLabel}>Notifications</Text>
            {unreadNotifications > 0 && (
              <View style={styles.bellCount}>
                <Text style={styles.bellCountText}>
                  {unreadNotifications > 99 ? '99+' : unreadNotifications}
                </Text>
              </View>
            )}
          </Pressable>
        </View>

        {/* Groups lead. One card either way, so the screen does not reshuffle. */}
        <View style={styles.nextCard}>
          <Text style={styles.nextTitle}>
            {groups.length === 0 ? 'Find a study group' : 'Your groups'}
          </Text>
          <Text style={styles.nextBody}>
            {groups.length === 0
              ? 'Matching ranks groups and study partners on your courses by how much of your week lines up with theirs. You can also browse what is open, or start your own group.'
              : `${groups.length} group${groups.length === 1 ? '' : 's'} · ${groups
                  .slice(0, 2)
                  .map((g) => g.group_name)
                  .join(', ')}${groups.length > 2 ? '…' : ''}`}
          </Text>
          {invitations.length > 0 && (
            <Text style={styles.inviteLine}>
              {invitations.length} pending invitation
              {invitations.length === 1 ? '' : 's'} waiting for an answer
            </Text>
          )}
          {/*
            Below the invitation line on purpose. An unanswered invite holds up
            somebody else's group, so it keeps the accent colour; unread messages
            will still be there in an hour. Null offline — see `useUnread`.
          */}
          {unreadSummaryLine !== null && (
            <Text style={styles.unreadLine}>{unreadSummaryLine}</Text>
          )}
          <Button
            label={groups.length === 0 ? 'Find a study group' : 'Open your groups'}
            onPress={() => router.push('/(app)/groups')}
          />
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
          <ActivityIndicator color={colors.primaryDark} style={styles.loader} />
        ) : userCourses.length === 0 ? (
          <Text style={styles.emptyText}>
            No courses yet. Tap Edit to add the courses you want partners for.
          </Text>
        ) : (
          userCourses.map((uc) => (
            <View
              key={uc.user_course_id}
              style={styles.courseCard}
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
          <Stat label="Groups" value={String(groups.length)} />
          <Stat label="Courses" value={String(userCourses.length)} />
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
  greeting: { ...typography.display },
  greetingRow: { flexDirection: 'row', alignItems: 'flex-start' },
  greetingCol: { flex: 1, paddingRight: spacing.md },
  bell: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  bellPressed: { backgroundColor: colors.surfaceAlt },
  bellLabel: { fontSize: fontSize.xs, fontFamily: FONT.semi, color: colors.text },
  // Unread count = orange-red pill with white text, same as the tab badge.
  bellCount: {
    marginLeft: spacing.xs,
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: colors.flame,
    alignItems: 'center',
  },
  bellCountText: { fontSize: fontSize.xs, fontFamily: FONT.bold, color: colors.textInverse },
  subtitle: { fontSize: fontSize.sm, fontFamily: FONT.regular, color: colors.textMuted, marginTop: spacing.xs },
  nextCard: {
    marginTop: spacing.xl,
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  nextTitle: { fontSize: fontSize.lg, fontFamily: FONT.bold, color: colors.text },
  nextBody: {
    fontSize: fontSize.sm,
    fontFamily: FONT.regular,
    color: colors.textMuted,
    lineHeight: 20,
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  inviteLine: {
    fontSize: fontSize.sm,
    fontFamily: FONT.semi,
    color: colors.primaryDark,
    marginBottom: spacing.md,
  },
  // Same weight as the invitation line, plain text colour: informational, not a nudge.
  unreadLine: {
    fontSize: fontSize.sm,
    fontFamily: FONT.semi,
    color: colors.text,
    marginBottom: spacing.md,
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
    fontFamily: FONT.bold,
    color: colors.text,
    marginTop: spacing.xxl,
    marginBottom: spacing.md,
  },
  // Same look, but the wrapping row already supplies the vertical spacing.
  sectionHeaderInline: {
    fontSize: fontSize.md,
    fontFamily: FONT.bold,
    color: colors.text,
  },
  editLink: { fontSize: fontSize.sm, fontFamily: FONT.semi, color: colors.primaryDark },
  loader: { marginVertical: spacing.lg },
  emptyText: { fontSize: fontSize.sm, fontFamily: FONT.regular, color: colors.textMuted, lineHeight: 20 },
  courseCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.lg,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.lg,
    marginBottom: spacing.sm,
    backgroundColor: colors.surface,
  },
  courseTextCol: { flex: 1 },
  courseCode: { fontSize: fontSize.sm, fontFamily: FONT.bold, color: colors.primaryDark },
  courseTitle: { fontSize: fontSize.sm, fontFamily: FONT.regular, color: colors.text, marginTop: 2 },
  // The availability card is the one hero surface on home: periwinkle with
  // white text, matching the tab-active and chat-bubble family.
  availCard: {
    padding: spacing.lg,
    backgroundColor: colors.primary,
    borderRadius: radius.xl,
  },
  availText: {
    fontSize: fontSize.md,
    fontFamily: FONT.semi,
    color: colors.textInverse,
    lineHeight: 22,
  },
  availCount: {
    fontSize: fontSize.xs,
    fontFamily: FONT.regular,
    color: colors.textInverse,
    opacity: 0.85,
    marginTop: spacing.xs,
  },
  statsRow: { flexDirection: 'row', marginTop: spacing.xl, gap: spacing.sm },
  stat: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
  },
  statValue: { fontSize: fontSize.xl, fontFamily: FONT.bold, color: colors.primaryDark },
  statLabel: { fontSize: fontSize.xs, fontFamily: FONT.semi, color: colors.textMuted, marginTop: 2 },
  signOut: { marginTop: spacing.xxl },
});
