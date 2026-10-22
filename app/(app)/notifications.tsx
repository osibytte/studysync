import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/Button';
import { NotificationCard } from '@/components/NotificationCard';
import {
  BandHeader,
  SheetCap,
  bandListStyles,
  useBandStatusBar,
} from '@/components/BandScreen';
import { RoundButton } from '@/components/RoundButton';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useNotifications } from '@/hooks/useNotifications';
import { notificationRoute, type InboxItem } from '@/lib/notificationRules';
import { FONT, colors, fontSize, shadowCard, spacing, typography } from '@/theme';

/**
 * The in-app inbox — what StudySync has told this student, newest first.
 *
 * WHY AN INBOX AT ALL, when the notifications already appeared on the lock screen.
 * Because on the phones this app is for they very often did not: the daily cap
 * withheld some, quiet hours delayed others, a notification swiped away on the way
 * to something else is gone, and the OS permission may never have been granted. The
 * ledger `0019` writes exists regardless of any of that, so this screen is the one
 * place a student can be sure of seeing everything — which is also why a withheld
 * notification is not a lost one.
 *
 * CACHED AND READABLE OFFLINE. A notification is a record of something that already
 * happened and stays true, so `useNotifications` caches the newest page: "BIO 201
 * confirmed Thursday 4pm" is exactly what a student wants to re-read on a bus with
 * no signal. Dismissing, by contrast, needs the network and the screen says so —
 * queueing a dismissal would clear whatever arrived while the phone was offline.
 *
 * A `FlatList` rather than the `Screen`'s ScrollView, because this list pages: the
 * inbox is the one list in the app with no natural ceiling — it accumulates for as
 * long as the student uses StudySync — so it is keyset-paged from
 * `notifications_inbox_idx` and rendered lazily.
 */
export default function NotificationsScreen() {
  const { profile } = useAuth();
  const { isOnline } = useNetwork();
  const router = useRouter();
  useBandStatusBar();

  const userId = profile?.user_id ?? null;
  const {
    items,
    unread,
    loading,
    loadingMore,
    hasMore,
    error,
    reload,
    loadOlder,
    markRead,
    markAllRead,
  } = useNotifications(userId);

  const [actionError, setActionError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  /**
   * Tapping through marks read as it navigates.
   *
   * Not awaited, deliberately: the navigation should happen at the speed of the
   * tap, and the RPC is idempotent (`coalesce(read_at, now())`) so nothing depends
   * on the order. If it fails the hook reverts the row and the student finds it
   * still unread when they come back, which is the honest outcome.
   */
  const handlePress = useCallback(
    (route: string, notificationId: string) => {
      void markRead(notificationId);
      router.push(route as never);
    },
    [markRead, router]
  );

  const handleDismiss = useCallback(
    async (notificationId: string) => {
      setActionError(null);
      const ok = await markRead(notificationId);
      if (!ok) {
        setActionError(
          isOnline
            ? "Couldn't dismiss that just now. Try again."
            : 'Dismissing needs a connection — it is not something we can queue.'
        );
      }
    },
    [markRead, isOnline]
  );

  const handleClearAll = useCallback(async () => {
    setActionError(null);
    setClearing(true);
    const ok = await markAllRead();
    setClearing(false);
    if (!ok) {
      setActionError(
        isOnline
          ? "Couldn't clear these just now. Try again."
          : 'Clearing needs a connection — it is not something we can queue.'
      );
    }
  }, [markAllRead, isOnline]);

  const renderItem = useCallback(
    ({ item }: { item: InboxItem }) => {
      if (item.type === 'day') {
        return (
          <View style={bandListStyles.row}>
            <Text style={styles.dayHeader} accessibilityRole="header">
              {item.label}
            </Text>
          </View>
        );
      }
      const route = notificationRoute(item.row);
      return (
        <View style={bandListStyles.row}>
        <NotificationCard
          row={item.row}
          onPress={route ? () => handlePress(route, item.row.notification_id) : null}
          onDismiss={
            item.row.read_at === null
              ? () => void handleDismiss(item.row.notification_id)
              : null
          }
          disabledReason={
            isOnline ? null : 'Dismissing needs a connection.'
          }
        />
        </View>
      );
    },
    [handlePress, handleDismiss, isOnline]
  );

  const empty = items.length === 0;

  const header = (
    <>
      <BandHeader
        title="Inbox"
        subtitle={unread > 0 ? `${unread} unread` : 'All caught up'}
        right={
          <View style={styles.headActions}>
            {unread > 0 && (
              <Pressable
                onPress={() => void handleClearAll()}
                disabled={clearing || !isOnline}
                accessibilityRole="button"
                accessibilityLabel={`Mark all ${unread} as read`}
                accessibilityHint={isOnline ? undefined : 'Needs a connection'}
                accessibilityState={{ disabled: clearing || !isOnline, busy: clearing }}
                style={({ pressed }) => [
                  styles.markAll,
                  (clearing || !isOnline) && styles.markAllDisabled,
                  pressed && styles.pressed,
                ]}
              >
                {clearing ? (
                  <ActivityIndicator size="small" color={colors.text} />
                ) : (
                  <Text style={styles.markAllText}>Mark all read</Text>
                )}
              </Pressable>
            )}
            <RoundButton
              icon="sliders"
              label="Notification settings"
              tone="glass"
              onPress={() => router.push('/(app)/notification-settings')}
            />
          </View>
        }
      />
      <SheetCap />
      <View style={bandListStyles.row}>
        {!isOnline && (
          <Text style={styles.note}>
            You are offline, so this is the last list fetched. You can read these, but
            dismissing one needs a connection.
          </Text>
        )}
        {!!actionError && (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {actionError}
          </Text>
        )}
      </View>
    </>
  );

  return (
    <View style={bandListStyles.root}>
      <FlatList
        data={empty ? [] : items}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <View style={bandListStyles.row}>
            {loading ? (
              <ActivityIndicator color={colors.primaryDark} style={styles.loader} />
            ) : error ? (
              <View>
                <Text style={styles.error}>{error}</Text>
                <Button label="Try again" variant="secondary" onPress={() => void reload()} />
              </View>
            ) : (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyTitle}>Nothing yet</Text>
                <Text style={styles.emptyText}>
                  This is where a confirmed study time, a shared file, a group invitation
                  or a message summary lands — and it stays here even if your phone was
                  off or a notification was withheld to keep to your daily limit.
                </Text>
              </View>
            )}
          </View>
        }
        // The keyset page, fetched as the student reaches the end. 0.4 rather
        // than the default 2: this list holds day headers as well as rows, so a
        // "two screens from the end" threshold fires almost immediately.
        onEndReached={() => void loadOlder()}
        onEndReachedThreshold={0.4}
        refreshing={loading && !empty}
        onRefresh={() => void reload()}
        progressViewOffset={0}
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator color={colors.primaryDark} style={styles.loader} />
          ) : !hasMore && items.length > 0 ? (
            <Text style={styles.endNote}>You're all caught up.</Text>
          ) : null
        }
        style={styles.flex}
        contentContainerStyle={bandListStyles.content}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  markAll: {
    minHeight: 36,
    paddingHorizontal: spacing.md + 2,
    borderRadius: 999,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markAllDisabled: { opacity: 0.5 },
  markAllText: { fontSize: fontSize.sm - 1, fontFamily: FONT.semi, color: colors.text },
  pressed: { opacity: 0.8 },
  note: {
    fontSize: fontSize.xs,
    fontFamily: FONT.regular,
    color: colors.textMuted,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  error: {
    fontSize: fontSize.sm,
    fontFamily: FONT.regular,
    color: colors.danger,
    lineHeight: 20,
    marginBottom: spacing.md,
  },
  loader: { marginVertical: spacing.lg },
  emptyCard: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    padding: spacing.lg + 2,
    gap: spacing.sm,
    ...shadowCard,
  },
  emptyTitle: { ...typography.section },
  emptyText: {
    fontSize: fontSize.sm,
    fontFamily: FONT.regular,
    color: colors.textSecondary,
    lineHeight: 21,
  },
  dayHeader: {
    fontSize: fontSize.md,
    fontFamily: FONT.semi,
    color: colors.textSecondary,
    marginTop: spacing.lg,
    marginBottom: spacing.sm + 2,
    marginLeft: spacing.xs,
  },
  endNote: {
    fontSize: fontSize.sm - 1,
    fontFamily: FONT.regular,
    color: colors.textMuted,
    textAlign: 'center',
    marginVertical: spacing.xl,
  },
});
