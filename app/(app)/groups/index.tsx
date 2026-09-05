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
import { useUnread } from '@/hooks/useUnread';
import { lastMessageLine, unreadBadge } from '@/lib/chatRules';
import { capacityLabel, isCreator } from '@/lib/groupRules';
import { colors, fontSize, radius, spacing, typography } from '@/theme';
import type { MyGroupRow, UnreadCountRow } from '@/types/database';

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
  const { byGroup, reload: reloadUnread } = useUnread(userId);

  const onRefresh = useCallback(async () => {
    // Drain first: a queued group.create should land before we refetch, or the
    // refresh would replace the optimistic card with server state that predates it.
    await syncNow();
    await Promise.all([reload(), reloadInvites(), reloadUnread()]);
  }, [syncNow, reload, reloadInvites, reloadUnread]);

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
              unread={byGroup[group.group_id]}
              currentUserId={userId}
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

/**
 * One card in the list. Name, course, state, capacity, your role — and, since
 * Stage 3, what the group last said and how much of it you have not read.
 *
 * `unread` is undefined for a group `my_unread_counts()` did not describe, which
 * offline is every group (see `useUnread`). The card then renders exactly as it
 * did before Stage 3 rather than claiming a silent zero.
 *
 * The preview names no sender. This screen has no roster, and `my_unread_counts`
 * returns `last_sender_id` without a name because RLS on `public.users` is
 * own-row only — so `nameFor` can only ever answer null here, and
 * `lastMessageLine` degrades to the bare body. The one name it can resolve
 * locally is the student's own, which is why `currentUserId` is passed: "You:
 * see you at 4" is worth the prop.
 */
function GroupRow({
  group,
  unread,
  currentUserId,
  onPress,
}: {
  group: MyGroupRow;
  unread: UnreadCountRow | undefined;
  currentUserId: string | null;
  onPress: () => void;
}) {
  const badge = unread ? unreadBadge(unread.unread_count) : null;
  const preview = unread ? lastMessageLine(unread, () => null, currentUserId) : '';

  return (
    <Pressable
      onPress={onPress}
      style={styles.card}
      accessibilityRole="button"
      accessibilityLabel={[
        group.group_name,
        group.course?.course_code ?? 'course unknown',
        capacityLabel(group.member_count, group.max_members),
        // Spelled out rather than the chip's "99+", which does not read aloud.
        badge && `${unread?.unread_count} unread message${unread?.unread_count === 1 ? '' : 's'}`,
        preview && `last message, ${preview}`,
      ]
        .filter(Boolean)
        .join(', ')}
    >
      <View style={styles.cardTop}>
        <Text style={styles.cardName} numberOfLines={1}>
          {group.group_name}
        </Text>
        {badge !== null && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        )}
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
      {preview !== '' && (
        <Text
          style={[styles.cardPreview, badge !== null && styles.cardPreviewUnread]}
          numberOfLines={1}
        >
          {preview}
        </Text>
      )}
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
  cardPreview: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
  /** Unread reads as darker and heavier, so the badge is not the only signal. */
  cardPreviewUnread: { color: colors.text, fontWeight: '600' },
  /**
   * Shaped like `StatusPill` on purpose — same padding, radius and text size —
   * but the only filled chip on the card, which is what makes it the thing your
   * eye lands on. `minWidth` keeps a single digit from squashing into a stripe.
   */
  badge: {
    minWidth: 24,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    marginRight: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  badgeText: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.textInverse,
    textAlign: 'center',
  },
  sectionHeader: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
    marginTop: spacing.xxl,
    marginBottom: spacing.md,
  },
  spaced: { marginTop: spacing.sm },
});
