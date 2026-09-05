import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useRef } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/Button';
import { OfflineBanner } from '@/components/OfflineBanner';
import { StatusPill } from '@/components/StatusPill';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useInvitations } from '@/hooks/useInvitations';
import { useMyGroups } from '@/hooks/useMyGroups';
import { capacityLabel, isCreator } from '@/lib/groupRules';
import { colors, fontSize, radius, spacing, typography } from '@/theme';
import type { MyGroupRow } from '@/types/database';

/**
 * "Your groups" — the hub for Stage 2.
 *
 * Leads with the groups the student is already in, because that is what they
 * open the app for once they have any. The three ways to get more (matching,
 * browsing, creating) sit below, and pending invitations are pulled up top as a
 * banner: an unanswered invite is time-sensitive in a way a browse list is not.
 */
export default function GroupsScreen() {
  const { profile } = useAuth();
  const { syncNow, syncing } = useNetwork();
  const router = useRouter();

  const userId = profile?.user_id ?? null;
  const { groups, loading, error, reload } = useMyGroups(userId);
  const { invitations, reload: reloadInvites } = useInvitations(userId);

  const onRefresh = useCallback(async () => {
    // Drain first: a queued group.create should land before we refetch, or the
    // refresh would replace the optimistic card with server state that predates it.
    await syncNow();
    await Promise.all([reload(), reloadInvites()]);
  }, [syncNow, reload, reloadInvites]);

  /**
   * Refetch when this screen comes back into focus.
   *
   * A Stack keeps it mounted while the student creates a group, answers an
   * invite or leaves one, so without this it would still be showing the list
   * from before. The first focus is skipped because each hook already fetches on
   * mount.
   */
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void reload();
      void reloadInvites();
    }, [reload, reloadInvites])
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <OfflineBanner />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={syncing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.primary}
          />
        }
      >
        <Text style={typography.title} accessibilityRole="header">
          Your groups
        </Text>

        {invitations.length > 0 && (
          <Pressable
            onPress={() => router.push('/(app)/groups/invitations')}
            style={styles.inviteBanner}
            accessibilityRole="button"
            accessibilityLabel={`${invitations.length} pending invitation${
              invitations.length === 1 ? '' : 's'
            }. Open your invitations.`}
          >
            <Text style={styles.inviteBannerText}>
              {invitations.length} pending invitation
              {invitations.length === 1 ? '' : 's'}
            </Text>
            <Text style={styles.inviteBannerLink}>View</Text>
          </Pressable>
        )}

        {loading && groups.length === 0 ? (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        ) : error && groups.length === 0 ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : groups.length === 0 ? (
          <Text style={styles.emptyText}>
            You are not in a group yet. Let matching suggest one, browse what is
            open on your courses, or start your own.
          </Text>
        ) : (
          groups.map((group) => (
            <GroupRow
              key={group.group_id}
              group={group}
              onPress={() => router.push(`/(app)/groups/${group.group_id}`)}
            />
          ))
        )}

        <Text style={styles.sectionHeader}>Find more</Text>
        <Button
          label="Suggest groups for me"
          onPress={() => router.push('/(app)/groups/match')}
          accessibilityHint="Ranks groups and study partners by how well your schedules line up"
        />
        <Button
          label="Browse open groups"
          variant="secondary"
          onPress={() => router.push('/(app)/groups/discover')}
          style={styles.spaced}
        />
        <Button
          label="Create a group"
          variant="secondary"
          onPress={() => router.push('/(app)/groups/create')}
          style={styles.spaced}
        />
        <Button
          label="Invitations"
          variant="ghost"
          onPress={() => router.push('/(app)/groups/invitations')}
          style={styles.spaced}
        />
        <Button
          label="How you get matched"
          variant="ghost"
          onPress={() => router.push('/(app)/groups/matching')}
          style={styles.spaced}
          accessibilityHint="Choose per course whether a coordinator can place you in a group"
        />
        <Button
          label="Back to home"
          variant="ghost"
          onPress={() => router.push('/(app)/home')}
          style={styles.spaced}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

/** One card in the list. Name, course, state, capacity, and your role. */
function GroupRow({ group, onPress }: { group: MyGroupRow; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.card}
      accessibilityRole="button"
      accessibilityLabel={`${group.group_name}, ${
        group.course?.course_code ?? 'course unknown'
      }, ${capacityLabel(group.member_count, group.max_members)}`}
    >
      <View style={styles.cardTop}>
        <Text style={styles.cardName} numberOfLines={1}>
          {group.group_name}
        </Text>
        <StatusPill status={group.status} />
      </View>
      <Text style={styles.cardCourse}>
        {group.course?.course_code ?? '—'}
        {group.course?.course_title ? ` · ${group.course.course_title}` : ''}
      </Text>
      <Text style={styles.cardMeta}>
        {capacityLabel(group.member_count, group.max_members)}
        {isCreator(group.role) ? ' · you created this' : ''}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  loader: { marginVertical: spacing.xl },
  errorText: { fontSize: fontSize.sm, color: colors.danger, marginTop: spacing.lg },
  emptyText: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    lineHeight: 20,
    marginTop: spacing.lg,
  },
  inviteBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
  },
  inviteBannerText: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text },
  inviteBannerLink: { fontSize: fontSize.sm, fontWeight: '700', color: colors.primary },
  card: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardName: {
    flex: 1,
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
    paddingRight: spacing.sm,
  },
  cardCourse: { fontSize: fontSize.sm, color: colors.primary, marginTop: spacing.xs },
  cardMeta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  sectionHeader: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
    marginTop: spacing.xxl,
    marginBottom: spacing.md,
  },
  spaced: { marginTop: spacing.sm },
});
