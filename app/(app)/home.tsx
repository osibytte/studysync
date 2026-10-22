import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useRef } from 'react';
import { Feather } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BandScreen } from '@/components/BandScreen';
import { Button } from '@/components/Button';
import { Initials, courseTag, initialsOf } from '@/components/Initials';
import { RoundButton } from '@/components/RoundButton';
import { StatusPill } from '@/components/StatusPill';
import { WeekStrip } from '@/components/WeekStrip';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useInvitations } from '@/hooks/useInvitations';
import { useMyGroups } from '@/hooks/useMyGroups';
import { useNotificationBadge } from '@/hooks/useNotifications';
import { useUnread } from '@/hooks/useUnread';
import { useUserCourses } from '@/hooks/useUserCourses';
import { countSelected, decodeAvailability } from '@/lib/availability';
import {
  FONT,
  MIN_TOUCH,
  colors,
  fontSize,
  radius,
  shadowCard,
  shadowFloat,
  spacing,
  typography,
} from '@/theme';

/**
 * Home.
 *
 * The week sits in the green band, because availability is the input matching
 * leans on hardest and a thin week should be obvious without going looking.
 * Then courses, then groups: the most active one as a big card that opens its
 * chat, the next two as cards, and an invitation if one is waiting. Courses and
 * availability stay visible on purpose — they are the two inputs matching
 * actually uses.
 */
export default function HomeScreen() {
  const { profile } = useAuth();
  const { syncNow, syncing } = useNetwork();
  const router = useRouter();

  const userId = profile?.user_id ?? null;
  const { userCourses, loading, reload } = useUserCourses(userId);
  const { groups, reload: reloadGroups } = useMyGroups(userId);
  const { invitations, reload: reloadInvites } = useInvitations(userId);
  const {
    summary: unreadSummaryLine,
    byGroup: unreadByGroup,
    reload: reloadUnread,
  } = useUnread(userId);
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

  // The group the big card features: the one with the most unread, else the
  // one with the most recent activity. Online-only signal; offline it falls
  // back to recency, which the cached list still has.
  const featured = useMemo(() => {
    if (groups.length === 0) return null;
    return [...groups].sort((a, b) => {
      const ua = unreadByGroup[a.group_id]?.unread_count ?? 0;
      const ub = unreadByGroup[b.group_id]?.unread_count ?? 0;
      if (ua !== ub) return ub - ua;
      return b.last_activity_at.localeCompare(a.last_activity_at);
    })[0];
  }, [groups, unreadByGroup]);
  const others = groups.filter((g) => g.group_id !== featured?.group_id).slice(0, 2);
  const featuredUnread = featured ? unreadByGroup[featured.group_id] : undefined;
  const firstName = profile?.full_name?.split(' ')[0];

  return (
    <BandScreen
      title={firstName ? `Hello, ${firstName}` : 'Hello'}
      subtitle={profile?.department ?? 'Department not set'}
      refreshControl={
        <RefreshControl
          refreshing={syncing}
          onRefresh={() => void onRefresh()}
          tintColor={colors.onBand}
          colors={[colors.primary]}
        />
      }
      right={
        <View style={styles.headActions}>
          {/*
            The inbox is a place rather than a thing that happened, so it lives
            up here; the count is the only part worth interrupting for, and the
            label always spells "Notifications" out for a screen reader.
          */}
          <RoundButton
            icon="bell"
            label="Notifications"
            tone="glass"
            count={unreadNotifications}
            onPress={() => router.push('/(app)/notifications')}
          />
          <Pressable
            onPress={() => router.push('/(app)/profile')}
            accessibilityRole="button"
            accessibilityLabel="Your profile"
            hitSlop={4}
          >
            <Initials
              text={initialsOf(profile?.full_name)}
              colorKey={profile?.user_id}
              size={44}
              shape="circle"
              ring
              ringColor="rgba(255,255,255,0.5)"
            />
          </Pressable>
        </View>
      }
      bandContent={
        <View style={styles.availCard}>
          <View style={styles.availTop}>
            <Text style={styles.availTitle}>
              {availabilityGrid
                ? `${countSelected(availabilityGrid)} free slots a week`
                : 'Availability not set yet'}
            </Text>
            <Pressable
              onPress={() => router.push('/(app)/profile')}
              accessibilityRole="button"
              accessibilityLabel="Edit your availability"
              hitSlop={12}
            >
              <Text style={styles.availEdit}>Edit</Text>
            </Pressable>
          </View>
          {availabilityGrid ? (
            <WeekStrip grid={availabilityGrid} tone="band" />
          ) : (
            <Text style={styles.availEmpty}>
              Matching uses the hours you are free. Add them from your profile.
            </Text>
          )}
        </View>
      }
    >
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionHeader} accessibilityRole="header">
          Your courses
        </Text>
        <Pressable
          onPress={() => router.push('/(app)/courses')}
          accessibilityRole="button"
          accessibilityLabel="Add or remove courses"
          hitSlop={12}
        >
          <Text style={styles.link}>Edit</Text>
        </Pressable>
      </View>

      {loading && userCourses.length === 0 ? (
        <ActivityIndicator color={colors.primaryDark} style={styles.loader} />
      ) : userCourses.length === 0 ? (
        <Text style={styles.emptyText}>
          No courses yet. Tap Edit to add the courses you want partners for.
        </Text>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipScroller}
          contentContainerStyle={styles.chipRow}
        >
          {userCourses.map((uc) => (
            <View
              key={uc.user_course_id}
              style={styles.courseChip}
              accessible
              accessibilityLabel={`${uc.course?.course_code}, ${uc.course?.course_title}`}
            >
              <Text style={styles.courseChipText}>{uc.course?.course_code}</Text>
            </View>
          ))}
        </ScrollView>
      )}

      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionHeader} accessibilityRole="header">
          Your groups
        </Text>
        {groups.length > 0 && (
          <Pressable
            onPress={() => router.push('/(app)/groups')}
            accessibilityRole="button"
            accessibilityLabel="See all your groups"
            hitSlop={12}
          >
            <Text style={styles.link}>See all</Text>
          </Pressable>
        )}
      </View>

      {!featured ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>Find a study group</Text>
          <Text style={styles.emptyBody}>
            Matching ranks groups and study partners on your courses by how much of
            your week lines up with theirs. You can also browse what is open, or
            start your own group.
          </Text>
          <Button label="Find a study group" onPress={() => router.push('/(app)/groups')} />
        </View>
      ) : (
        <Pressable
          onPress={() => router.push(`/(app)/groups/${featured.group_id}/chat`)}
          accessibilityRole="button"
          accessibilityLabel={`${featured.group_name}. Open chat${
            featuredUnread?.unread_count ? `, ${featuredUnread.unread_count} unread` : ''
          }`}
          style={({ pressed }) => [styles.feature, pressed && styles.pressed]}
        >
          {/* The course letters as a big faint watermark: the card's only ornament. */}
          <Text style={styles.featureMark} numberOfLines={1}>
            {courseTag(featured.course?.course_code)}
          </Text>
          <View style={styles.featureKicker}>
            <Text style={styles.featureCourse}>{featured.course?.course_code ?? 'Group'}</Text>
            <StatusPill status={featured.status} />
          </View>
          <Text style={styles.featureName} numberOfLines={2}>
            {featured.group_name}
          </Text>
          <Text style={styles.featureLast} numberOfLines={1}>
            {featuredUnread?.last_body ??
              `${featured.member_count} member${featured.member_count === 1 ? '' : 's'}`}
          </Text>
          <Text style={styles.featureMeta}>
            {featured.member_count} member{featured.member_count === 1 ? '' : 's'}
            {featuredUnread?.unread_count ? ` · ${featuredUnread.unread_count} unread` : ''}
          </Text>
          <View style={styles.featureGo}>
            <Text style={styles.featureGoText}>Open chat</Text>
            <View style={styles.featureArrow}>
              <Feather name="arrow-right" size={20} color={colors.accent} />
            </View>
          </View>
        </Pressable>
      )}

      {others.map((g) => {
        const unread = unreadByGroup[g.group_id]?.unread_count ?? 0;
        return (
          <Pressable
            key={g.group_id}
            onPress={() => router.push(`/(app)/groups/${g.group_id}`)}
            accessibilityRole="button"
            accessibilityLabel={`${g.group_name}, ${g.member_count} members${
              unread ? `, ${unread} unread` : ''
            }`}
            style={({ pressed }) => [styles.item, pressed && styles.pressed]}
          >
            <Initials text={courseTag(g.course?.course_code)} colorKey={g.group_id} />
            <View style={styles.itemMain}>
              <Text style={styles.itemTitle} numberOfLines={1}>
                {g.group_name}
              </Text>
              <Text style={styles.itemSub} numberOfLines={1}>
                {g.member_count} member{g.member_count === 1 ? '' : 's'}
                {unread ? ` · ${unread} unread` : ''}
              </Text>
            </View>
            <StatusPill status={g.status} />
          </Pressable>
        );
      })}

      {invitations.length > 0 && (
        <Pressable
          onPress={() => router.push('/(app)/groups/invitations')}
          accessibilityRole="button"
          accessibilityLabel={`${invitations.length} pending invitation${
            invitations.length === 1 ? '' : 's'
          }`}
          style={({ pressed }) => [styles.item, pressed && styles.pressed]}
        >
          <View style={styles.inviteIcon}>
            <Feather name="mail" size={20} color={colors.warning} />
          </View>
          <View style={styles.itemMain}>
            <Text style={styles.itemTitle}>
              {invitations.length} invitation{invitations.length === 1 ? '' : 's'} waiting
            </Text>
            {/*
              An unanswered invite holds up somebody else's group, so it gets its
              own card; unread messages will still be there in an hour.
            */}
            <Text style={styles.itemSub}>Someone is waiting on your answer</Text>
          </View>
          <View style={styles.newBadge}>
            <Text style={styles.newBadgeText}>New</Text>
          </View>
        </Pressable>
      )}

      {/* Null offline — see `useUnread`. */}
      {unreadSummaryLine !== null && <Text style={styles.unreadLine}>{unreadSummaryLine}</Text>}

      <View style={styles.findWrap}>
        <Button label="Find study partners" onPress={() => router.push('/(app)/groups/match')} />
      </View>
    </BandScreen>
  );
}

const styles = StyleSheet.create({
  headActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  pressed: { opacity: 0.9, transform: [{ scale: 0.99 }] },

  availCard: {
    marginTop: spacing.xl - 2,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  availTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md + 2,
  },
  availTitle: { fontSize: fontSize.md, fontFamily: FONT.bold, color: colors.onBand },
  availEdit: {
    fontSize: fontSize.sm - 1,
    fontFamily: FONT.semi,
    color: colors.onBand,
    textDecorationLine: 'underline',
  },
  availEmpty: { fontSize: fontSize.sm - 1, fontFamily: FONT.regular, color: colors.onBandMuted, lineHeight: 19 },

  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.xl + 2,
    marginBottom: spacing.md,
    paddingHorizontal: 2,
  },
  sectionHeader: { ...typography.section },
  link: {
    fontSize: fontSize.sm,
    fontFamily: FONT.semi,
    color: colors.text,
    textDecorationLine: 'underline',
  },
  loader: { marginVertical: spacing.lg },
  emptyText: { fontSize: fontSize.sm, fontFamily: FONT.regular, color: colors.textMuted, lineHeight: 20 },

  // Bleed the chip row to the screen edges so chips scroll out under the gutter.
  chipScroller: { marginHorizontal: -spacing.lg, flexGrow: 0 },
  chipRow: { paddingHorizontal: spacing.lg, paddingVertical: 2, gap: spacing.sm },
  courseChip: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    ...shadowCard,
  },
  courseChipText: { fontSize: fontSize.sm, fontFamily: FONT.semi, color: colors.textSecondary },

  emptyCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg + 2,
    gap: spacing.md,
    ...shadowCard,
  },
  emptyTitle: { ...typography.section },
  emptyBody: { fontSize: fontSize.sm, fontFamily: FONT.regular, color: colors.textSecondary, lineHeight: 21 },

  feature: {
    overflow: 'hidden',
    borderRadius: radius.xl,
    padding: spacing.xl - 4,
    backgroundColor: colors.accent,
    marginBottom: spacing.sm + 2,
    ...shadowFloat,
  },
  featureMark: {
    position: 'absolute',
    right: -10,
    top: 4,
    fontSize: 92,
    fontFamily: FONT.extra,
    letterSpacing: -4,
    color: 'rgba(255,255,255,0.06)',
  },
  featureKicker: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  featureCourse: { fontSize: fontSize.sm - 1, fontFamily: FONT.medium, color: 'rgba(255,255,255,0.7)' },
  featureName: {
    fontSize: 24,
    fontFamily: FONT.bold,
    letterSpacing: -0.2,
    color: colors.textInverse,
    marginTop: spacing.sm,
  },
  featureLast: { fontSize: fontSize.sm, fontFamily: FONT.regular, color: 'rgba(255,255,255,0.78)', marginTop: spacing.xs + 2 },
  featureMeta: { fontSize: fontSize.sm - 1, fontFamily: FONT.medium, color: 'rgba(255,255,255,0.6)', marginTop: spacing.md },
  featureGo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.xl - 4,
    paddingLeft: spacing.xl - 4,
    padding: 6,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  featureGoText: { flex: 1, fontSize: fontSize.md, fontFamily: FONT.semi, color: colors.textInverse },
  featureArrow: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: MIN_TOUCH / 2,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },

  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 76,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.md + 2,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm + 2,
    ...shadowCard,
  },
  itemMain: { flex: 1, minWidth: 0 },
  itemTitle: { fontSize: fontSize.md, fontFamily: FONT.bold, color: colors.text },
  itemSub: { fontSize: fontSize.sm - 1, fontFamily: FONT.regular, color: colors.textMuted, marginTop: 3 },
  inviteIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: '#FDE8D7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  newBadge: {
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.info,
  },
  newBadgeText: { fontSize: fontSize.xs, fontFamily: FONT.semi, color: colors.textInverse },
  unreadLine: {
    fontSize: fontSize.sm - 1,
    fontFamily: FONT.medium,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  findWrap: { marginTop: spacing.lg },
});
