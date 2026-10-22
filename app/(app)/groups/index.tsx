import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useRef } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { BandScreen } from '@/components/BandScreen';
import { Initials, courseTag } from '@/components/Initials';
import { RoundButton } from '@/components/RoundButton';
import { StatusPill } from '@/components/StatusPill';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useInvitations } from '@/hooks/useInvitations';
import { useMyGroups } from '@/hooks/useMyGroups';
import { useUnread } from '@/hooks/useUnread';
import { lastMessageLine, unreadBadge } from '@/lib/chatRules';
import { capacityLabel, isCreator } from '@/lib/groupRules';
import { FONT, colors, fontSize, radius, shadowCard, spacing, typography } from '@/theme';
import type { MyGroupRow, UnreadCountRow } from '@/types/database';

/**
 * "Your groups" — the hub for Stage 2.
 *
 * Leads with the groups the student is already in, because that is what they
 * open the app for once they have any. The four ways to get more (applying,
 * suggestions, browsing, creating) sit on the green band above, and pending
 * invitations come first in the list: an unanswered invite is time-sensitive in
 * a way a browse list is not.
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

  const ways: {
    icon: React.ComponentProps<typeof Feather>['name'];
    label: string;
    hint: string;
    href: '/(app)/groups/matching' | '/(app)/groups/match' | '/(app)/groups/discover' | '/(app)/groups/create';
  }[] = [
    {
      icon: 'zap',
      label: 'Apply to be matched',
      hint: 'Asks the system to place you in a group on a course, during the registration period',
      href: '/(app)/groups/matching',
    },
    {
      icon: 'star',
      label: 'Suggestions',
      hint: 'Ranks groups and study partners by how well your schedules line up',
      href: '/(app)/groups/match',
    },
    { icon: 'search', label: 'Browse open groups', hint: 'Open groups on your courses', href: '/(app)/groups/discover' },
    { icon: 'plus', label: 'Create a group', hint: 'Start your own', href: '/(app)/groups/create' },
  ];

  return (
    <BandScreen
      title="Groups"
      subtitle={
        groups.length > 0
          ? `${groups.length} group${groups.length === 1 ? '' : 's'}`
          : 'Find people to study with'
      }
      refreshControl={
        <RefreshControl
          refreshing={syncing}
          onRefresh={() => void onRefresh()}
          tintColor={colors.onBand}
          colors={[colors.primary]}
        />
      }
      right={
        <RoundButton
          icon="plus"
          label="Create a group"
          tone="glass"
          onPress={() => router.push('/(app)/groups/create')}
        />
      }
      bandContent={
        <View style={styles.ways}>
          {ways.map((w) => (
            <Pressable
              key={w.href}
              onPress={() => router.push(w.href)}
              accessibilityRole="button"
              accessibilityLabel={w.label}
              accessibilityHint={w.hint}
              style={({ pressed }) => [styles.way, pressed && styles.wayPressed]}
            >
              <Feather name={w.icon} size={20} color={colors.bandHighlight} />
              <Text style={styles.wayLabel} numberOfLines={2}>
                {w.label}
              </Text>
            </Pressable>
          ))}
        </View>
      }
    >
      {invitations.length > 0 && (
        <>
          <Text style={[styles.sectionHeader, styles.firstHeader]} accessibilityRole="header">
            Invitations
          </Text>
          <Pressable
            onPress={() => router.push('/(app)/groups/invitations')}
            style={({ pressed }) => [styles.card, styles.inviteCard, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`${invitations.length} pending invitation${
              invitations.length === 1 ? '' : 's'
            }. Open your invitations.`}
          >
            <View style={styles.inviteIcon}>
              <Feather name="mail" size={20} color={colors.warning} />
            </View>
            <View style={styles.cardMain}>
              <Text style={styles.cardName}>
                {invitations.length} pending invitation{invitations.length === 1 ? '' : 's'}
              </Text>
              <Text style={styles.cardMeta}>Accept or decline</Text>
            </View>
            <View style={styles.pendingBadge}>
              <Text style={styles.pendingText}>Pending</Text>
            </View>
          </Pressable>
        </>
      )}

      <Text
        style={[styles.sectionHeader, invitations.length === 0 && styles.firstHeader]}
        accessibilityRole="header"
      >
        Your groups
      </Text>

      {loading && groups.length === 0 ? (
        <ActivityIndicator color={colors.primaryDark} style={styles.loader} />
      ) : error && groups.length === 0 ? (
        <Text style={styles.errorText}>{error}</Text>
      ) : groups.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>
            You are not in a group yet. Let matching suggest one, browse what is
            open on your courses, or start your own. The four ways are just above.
          </Text>
        </View>
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
    </BandScreen>
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
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
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
      <Initials text={courseTag(group.course?.course_code)} colorKey={group.group_id} />
      <View style={styles.cardMain}>
        <Text style={styles.cardName} numberOfLines={1}>
          {group.group_name}
        </Text>
        <Text style={styles.cardMeta} numberOfLines={1}>
          {group.course?.course_code ?? '—'} · {capacityLabel(group.member_count, group.max_members)}
          {isCreator(group.role) ? ' · yours' : ''}
        </Text>
        {preview !== '' && (
          <Text
            style={[styles.cardPreview, badge !== null && styles.cardPreviewUnread]}
            numberOfLines={1}
          >
            {preview}
          </Text>
        )}
      </View>
      <View style={styles.cardRight}>
        <StatusPill status={group.status} />
        {badge !== null && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  ways: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xl - 4 },
  way: {
    width: '48.5%',
    flexGrow: 1,
    minHeight: 84,
    padding: spacing.md + 2,
    gap: spacing.sm + 2,
    borderRadius: radius.lg - 2,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  wayPressed: { backgroundColor: 'rgba(255,255,255,0.16)' },
  wayLabel: { fontSize: fontSize.sm - 1, fontFamily: FONT.semi, color: colors.onBand, lineHeight: 18 },

  pressed: { opacity: 0.9, transform: [{ scale: 0.99 }] },
  loader: { marginVertical: spacing.xl },
  errorText: { fontSize: fontSize.sm, fontFamily: FONT.regular, color: colors.danger },
  emptyCard: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg + 2, ...shadowCard },
  emptyText: { fontSize: fontSize.sm, fontFamily: FONT.regular, color: colors.textSecondary, lineHeight: 21 },

  sectionHeader: { ...typography.section, marginTop: spacing.xl + 2, marginBottom: spacing.md, paddingHorizontal: 2 },
  firstHeader: { marginTop: 0 },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 80,
    padding: spacing.md + 2,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm + 2,
    ...shadowCard,
  },
  inviteCard: { minHeight: 76 },
  inviteIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: '#FDE8D7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingBadge: {
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.info,
  },
  pendingText: { fontSize: fontSize.xs, fontFamily: FONT.semi, color: colors.textInverse },
  cardMain: { flex: 1, minWidth: 0 },
  cardRight: { alignItems: 'flex-end', gap: spacing.sm },
  cardName: { fontSize: fontSize.md, fontFamily: FONT.bold, color: colors.text },
  cardMeta: { fontSize: fontSize.sm - 1, fontFamily: FONT.regular, color: colors.textMuted, marginTop: 3 },
  cardPreview: {
    fontSize: fontSize.sm - 1,
    fontFamily: FONT.regular,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  /** Unread reads as darker and heavier, so the badge is not the only signal. */
  cardPreviewUnread: { color: colors.text, fontFamily: FONT.semi },
  /**
   * Ink, round, white digits: the same count chip everywhere a group shows
   * unread messages. `minWidth` keeps a single digit from squashing into a
   * stripe. (Red stays for the Inbox count only.)
   */
  badge: {
    minWidth: 24,
    height: 24,
    paddingHorizontal: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontSize: fontSize.xs,
    fontFamily: FONT.bold,
    color: colors.textInverse,
    textAlign: 'center',
  },
});
