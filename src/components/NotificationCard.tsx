import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { notificationWhenLabel } from '@/lib/notificationRules';
import { FONT, colors, fontSize, radius, spacing, shadowCard } from '@/theme';
import type { Notification } from '@/types/database';

interface Props {
  row: Notification;
  /** Null when this kind has nowhere to go — the card is then not pressable. */
  onPress: (() => void) | null;
  /** Dismiss without navigating. Absent for an already-read row. */
  onDismiss: (() => void) | null;
  /** Disables the dismiss control and says why. */
  disabledReason?: string | null;
}

/**
 * One row of the inbox.
 *
 * READ ROWS STAY, DIMMED. Dismissing does not remove anything — `read_at` is a
 * timestamp, not a delete — so a student who taps the wrong row can still find it,
 * and the history of what they were told stays legible. Colour is not the only
 * signal: an unread row also carries the accent bar and the word "New", so it reads
 * correctly in greyscale and to a screen reader.
 *
 * TITLE AND BODY ARE RENDERED EXACTLY AS STORED and never re-derived. `0019` keeps
 * them as sent for this reason: "4 new messages in BIO 201" stays true after a
 * fifth arrives, and a session whose time later moves must not silently rewrite the
 * notification that named the old one.
 *
 * The whole card navigates and a separate control dismisses, rather than a tap
 * doing both. Tapping through is the common intent, but "I have seen this and I do
 * not need to open it" is the second most common, and folding it into the same
 * gesture means the student cannot clear an inbox without visiting eight screens.
 */
export function NotificationCard({ row, onPress, onDismiss, disabledReason = null }: Props) {
  const unread = row.read_at === null;
  const when = notificationWhenLabel(row.created_at);

  return (
    <View style={[styles.card, unread && styles.cardUnread]}>
      {unread && <View style={styles.unreadBar} />}
      <Pressable
        onPress={onPress ?? undefined}
        disabled={!onPress}
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityLabel={`${unread ? 'New. ' : ''}${row.title}. ${row.body}. ${when}`}
        accessibilityHint={onPress ? 'Opens the group' : undefined}
        style={({ pressed }) => [styles.body, pressed && !!onPress && styles.pressed]}
      >
        <View style={styles.headerRow}>
          <Text style={[styles.title, !unread && styles.titleRead]} numberOfLines={2}>
            {row.title}
          </Text>
          {/* The label already opens with "New." for a screen reader. */}
          {unread && <View style={styles.newPill} />}
        </View>
        <Text style={[styles.text, !unread && styles.textRead]}>{row.body}</Text>
        <Text style={styles.when}>{when}</Text>
      </Pressable>

      {!!onDismiss && (
        <Pressable
          onPress={onDismiss}
          disabled={!!disabledReason}
          accessibilityRole="button"
          accessibilityLabel={`Dismiss: ${row.title}`}
          accessibilityHint={disabledReason ?? undefined}
          style={({ pressed }) => [
            styles.dismiss,
            pressed && !disabledReason && styles.pressed,
            !!disabledReason && styles.dismissDisabled,
          ]}
        >
          <Text style={styles.dismissText}>Dismiss</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Its own white card, like every list item; unread gets a green edge, a
  // green dot and heavier type, so the dot is never the only signal.
  card: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: radius.lg,
    marginBottom: spacing.sm + 2,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    ...shadowCard,
  },
  cardUnread: {},
  unreadBar: { width: 4, backgroundColor: colors.primaryMuted },
  body: { flex: 1, paddingVertical: spacing.md + 2, paddingHorizontal: spacing.lg },
  pressed: { backgroundColor: colors.surfaceAlt },
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  title: {
    flex: 1,
    fontSize: fontSize.md,
    fontFamily: FONT.bold,
    color: colors.text,
  },
  titleRead: { fontFamily: FONT.semi, color: colors.textSecondary },
  newPill: {
    marginLeft: spacing.sm,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.primaryMuted,
  },
  text: {
    fontSize: fontSize.sm,
    fontFamily: FONT.regular,
    color: colors.textSecondary,
    lineHeight: 20,
    marginTop: 3,
  },
  textRead: { color: colors.textMuted },
  when: { fontSize: fontSize.xs, fontFamily: FONT.medium, color: colors.textMuted, marginTop: spacing.sm },
  dismiss: {
    justifyContent: 'center',
    paddingHorizontal: spacing.md + 2,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
  },
  dismissDisabled: { opacity: 0.4 },
  dismissText: { fontSize: fontSize.xs, fontFamily: FONT.semi, color: colors.text },
});
