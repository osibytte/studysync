import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from './Button';
import { deletedMessageText, formatClock } from '@/lib/chatRules';
import type { TimelineMessageItem } from '@/lib/chatRules';
import { FONT, colors, fontSize, radius, spacing } from '@/theme';

/**
 * One text message, and the fallback every other kind lands on.
 *
 * `buildTimeline` has already decided everything this renders — whether the name
 * belongs above it, whether the time belongs below it, whether it is still in the
 * outbox — so this component holds no logic beyond turning those booleans into a
 * layout. Its own `renderKind` fallback is why it also renders a `session` or
 * `file` message whose referent has not arrived: `body` carries a readable
 * sentence for every kind precisely so that case says something true.
 *
 * Deleting is a two-step confirm inside the bubble rather than a native alert,
 * for the same reason the group screen confirms inline: this codebase uses no
 * alert dialogs, so a destructive tap is always followed by a visible choice.
 */

interface Props {
  item: TimelineMessageItem;
  /**
   * Resolved from the roster, never from the message row. RLS on `public.users`
   * is own-row only, so `sender_id` is genuinely all a message carries.
   */
  senderName: string;
  /** Supplied only when `canDeleteMessage` says so — its absence disables the press. */
  onLongPress?: () => void;
  /** True while this bubble is the one showing the confirm. */
  confirming?: boolean;
  onDelete?: () => void;
  onKeep?: () => void;
  deleting?: boolean;
}

export function MessageBubble({
  item,
  senderName,
  onLongPress,
  confirming = false,
  onDelete,
  onKeep,
  deleting = false,
}: Props) {
  const { message, isMine, showSender, showTime, pending } = item;
  const gone = deletedMessageText(message);
  const text = gone ?? message.body;

  return (
    <View style={[styles.row, isMine ? styles.rowMine : styles.rowTheirs]}>
      <View style={[styles.column, isMine && styles.columnMine]}>
        {showSender && !isMine && (
          <Text style={styles.sender} numberOfLines={1}>
            {senderName}
          </Text>
        )}

        <Pressable
          onLongPress={onLongPress}
          disabled={!onLongPress}
          accessibilityRole={onLongPress ? 'button' : 'text'}
          accessibilityLabel={`${isMine ? 'You' : senderName}: ${text}`}
          accessibilityHint={onLongPress ? 'Hold to delete this message' : undefined}
          style={({ pressed }) => [
            styles.bubble,
            isMine ? styles.bubbleMine : styles.bubbleTheirs,
            !!gone && styles.bubbleGone,
            pressed && !!onLongPress && styles.bubblePressed,
          ]}
        >
          <Text
            style={[
              styles.body,
              isMine && !gone && styles.bodyMine,
              !!gone && styles.bodyGone,
            ]}
          >
            {text}
          </Text>
        </Pressable>

        {confirming && (
          <View style={styles.confirm}>
            <Text style={styles.confirmText}>
              Delete this message? The row stays, so the conversation keeps its
              shape — the text does not, and it goes for everybody.
            </Text>
            <View style={styles.confirmRow}>
              <Button
                label="Delete"
                variant="danger"
                fullWidth={false}
                onPress={() => onDelete?.()}
                loading={deleting}
                disabled={deleting}
                style={styles.confirmButton}
              />
              <Button
                label="Keep"
                variant="ghost"
                fullWidth={false}
                onPress={() => onKeep?.()}
                disabled={deleting}
                style={styles.confirmButton}
              />
            </View>
          </View>
        )}

        {(showTime || pending) && (
          <Text style={[styles.meta, isMine ? styles.metaMine : styles.metaTheirs]}>
            {pending ? 'Sending…' : formatClock(message.created_at)}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', marginTop: spacing.xs },
  rowMine: { justifyContent: 'flex-end' },
  rowTheirs: { justifyContent: 'flex-start' },
  column: { maxWidth: '84%' },
  columnMine: { alignItems: 'flex-end' },
  sender: {
    fontSize: fontSize.xs,
    fontFamily: FONT.semi,
    color: colors.primaryDark,
    marginBottom: 2,
    marginLeft: spacing.xs,
  },
  bubble: {
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  // primaryStrong is the deep end of periwinkle: white body text stays readable
  // in daylight, which the lighter hero tint does not guarantee.
  bubbleMine: { backgroundColor: colors.primaryStrong, borderBottomRightRadius: radius.sm },
  bubbleTheirs: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderBottomLeftRadius: radius.sm,
  },
  bubbleGone: { backgroundColor: colors.surfaceAlt },
  bubblePressed: { opacity: 0.75 },
  body: { fontSize: fontSize.md, fontFamily: FONT.regular, color: colors.text, lineHeight: 22 },
  bodyMine: { color: colors.textInverse },
  bodyGone: { color: colors.textMuted, fontStyle: 'italic' },
  confirm: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  confirmText: { fontSize: fontSize.xs, color: colors.text, lineHeight: 18 },
  confirmRow: { flexDirection: 'row', marginTop: spacing.sm },
  confirmButton: { paddingHorizontal: spacing.md, marginRight: spacing.xs },
  meta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  metaMine: { marginRight: spacing.xs },
  metaTheirs: { marginLeft: spacing.xs },
});
