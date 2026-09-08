import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { notificationWhenLabel } from '@/lib/notificationRules';
import { colors, fontSize, radius, spacing } from '@/theme';
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
          {unread && (
            <View style={styles.newPill}>
              <Text style={styles.newPillText}>New</Text>
            </View>
          )}
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
  card: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
    overflow: 'hidden',
  },
  cardUnread: { borderColor: colors.borderStrong, backgroundColor: colors.surface },
  unreadBar: { width: 4, backgroundColor: colors.accent },
  body: { flex: 1, padding: spacing.md },
  pressed: { backgroundColor: colors.surfaceAlt },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start' },
  title: { flex: 1, fontSize: fontSize.sm, fontWeight: '700', color: colors.text },
  titleRead: { color: colors.textMuted },
  newPill: {
    marginLeft: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
  },
  newPillText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.warning },
  text: { fontSize: fontSize.sm, color: colors.text, lineHeight: 20, marginTop: spacing.xs },
  textRead: { color: colors.textMuted },
  when: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.xs },
  dismiss: {
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
  },
  dismissDisabled: { opacity: 0.4 },
  dismissText: { fontSize: fontSize.xs, fontWeight: '600', color: colors.primary },
});
