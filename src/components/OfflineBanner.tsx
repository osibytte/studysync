import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useNetwork } from '@/context/NetworkContext';
import { colors, fontSize, spacing } from '@/theme';

/**
 * Persistent connectivity strip.
 *
 * Three states, all of which the student needs to be able to distinguish:
 *   offline with nothing queued  — "you're offline, reads are from cache"
 *   offline with queued writes   — "your changes are safe and will sync"
 *   online with queued writes    — "syncing now" / tap to retry
 *
 * The middle state is the important one. Without it, a student who saved
 * something offline has no way to tell whether their work was kept, and the
 * rational response is to retype it — which is how you get duplicates.
 *
 * Renders nothing when online and empty, so it costs no vertical space in the
 * normal case.
 */
export function OfflineBanner() {
  const { isOnline, pending, syncing, syncNow } = useNetwork();

  if (isOnline && pending === 0) return null;

  const message = !isOnline
    ? pending > 0
      ? `Offline — ${pending} change${pending === 1 ? '' : 's'} saved, will sync automatically`
      : 'Offline — showing saved data'
    : syncing
      ? `Syncing ${pending} change${pending === 1 ? '' : 's'}...`
      : `${pending} change${pending === 1 ? '' : 's'} waiting to sync — tap to retry`;

  const tappable = isOnline && !syncing && pending > 0;

  const body = (
    <View style={[styles.banner, !isOnline ? styles.offline : styles.pendingSync]}>
      <Text style={styles.text} numberOfLines={2}>
        {message}
      </Text>
    </View>
  );

  if (!tappable) {
    return (
      <View accessibilityLiveRegion="polite" accessibilityRole="alert">
        {body}
      </View>
    );
  }

  return (
    <Pressable
      onPress={() => void syncNow()}
      accessibilityRole="button"
      accessibilityLabel={message}
      accessibilityHint="Retries syncing your saved changes"
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  offline: { backgroundColor: colors.offline },
  pendingSync: { backgroundColor: colors.warning },
  text: {
    color: colors.textInverse,
    fontSize: fontSize.xs,
    fontWeight: '600',
    textAlign: 'center',
  },
});
