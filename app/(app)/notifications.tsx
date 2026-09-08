import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/Button';
import { NotificationCard } from '@/components/NotificationCard';
import { Screen } from '@/components/Screen';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useNotifications } from '@/hooks/useNotifications';
import { notificationRoute, type InboxItem } from '@/lib/notificationRules';
import { colors, fontSize, spacing } from '@/theme';

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
          <Text style={styles.dayHeader} accessibilityRole="header">
            {item.label}
          </Text>
        );
      }
      const route = notificationRoute(item.row);
      return (
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
      );
    },
    [handlePress, handleDismiss, isOnline]
  );

  const empty = items.length === 0;

  return (
    <Screen
      title="Notifications"
      subtitle={
        unread > 0
          ? `${unread} you have not read yet.`
          : 'Everything StudySync has told you.'
      }
      scroll={false}
      footer={
        <View>
          {unread > 0 && (
            <Button
              label={`Mark all ${unread} as read`}
              variant="secondary"
              onPress={() => void handleClearAll()}
              loading={clearing}
              disabled={clearing || !isOnline}
            />
          )}
          <Button
            label="Notification settings"
            variant="ghost"
            onPress={() => router.push('/(app)/notification-settings')}
            style={unread > 0 ? styles.footerSecond : undefined}
          />
          <Button label="Back" variant="ghost" onPress={() => router.back()} />
        </View>
      }
    >
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

      {loading && empty ? (
        <ActivityIndicator color={colors.primary} style={styles.loader} />
      ) : error && empty ? (
        <View>
          <Text style={styles.error}>{error}</Text>
          <Button label="Try again" variant="secondary" onPress={() => void reload()} />
        </View>
      ) : empty ? (
        <Text style={styles.emptyText}>
          Nothing yet. This is where a confirmed study time, a shared file, a group
          invitation or a message summary lands — and it stays here even if your phone
          was off or a notification was withheld to keep to your daily limit.
        </Text>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          // The keyset page, fetched as the student reaches the end. 0.4 rather
          // than the default 2: this list holds day headers as well as rows, so a
          // "two screens from the end" threshold fires almost immediately.
          onEndReached={() => void loadOlder()}
          onEndReachedThreshold={0.4}
          refreshing={loading && !empty}
          onRefresh={() => void reload()}
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator color={colors.primary} style={styles.loader} />
            ) : !hasMore && items.length > 6 ? (
              <Text style={styles.endNote}>That is everything.</Text>
            ) : null
          }
          showsVerticalScrollIndicator={false}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
    marginBottom: spacing.sm,
  },
  error: {
    fontSize: fontSize.sm,
    color: colors.danger,
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
  loader: { marginVertical: spacing.lg },
  emptyText: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    lineHeight: 20,
    marginTop: spacing.md,
  },
  dayHeader: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  endNote: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    textAlign: 'center',
    marginVertical: spacing.lg,
  },
  footerSecond: { marginTop: spacing.sm },
});
