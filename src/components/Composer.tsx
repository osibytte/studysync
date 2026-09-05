import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  MESSAGE_MAX_LENGTH,
  normaliseMessageBody,
  validateMessageBody,
} from '@/lib/chatRules';
import { MIN_TOUCH, colors, fontSize, radius, spacing } from '@/theme';

/**
 * The bar at the bottom of the chat: type a message, or propose a study time.
 *
 * A raw `TextInput` rather than `TextField`, which has no multiline prop and
 * carries a label and 16pt of bottom margin that a composer does not want. The
 * styling below is deliberately TextField's, minus those.
 *
 * IT STAYS ENABLED OFFLINE, and that is the whole point of the offline queue:
 * `chat.send` is queueable precisely because a message means the same thing
 * whenever it lands, so the only thing that changes without a connection is the
 * hint under the field. Send is disabled ONLY for an empty or over-long body —
 * `validateMessageBody` mirrors the `messages_body_shape` CHECK, so a body this
 * accepts is one Postgres accepts, which matters far more when the write is
 * going to sit in a queue for an hour than when it fails in a second.
 *
 * The height is capped at 5-ish lines so a long paragraph scrolls inside the
 * field instead of pushing the transcript off the screen.
 */

interface Props {
  value: string;
  onChangeText: (value: string) => void;
  onSend: () => void;
  onProposeTime: () => void;
  /** True while a send is in flight. Offline sends are never in flight. */
  sending?: boolean;
  isOnline: boolean;
  /** Hides the propose button while the sheet is already open. */
  proposeDisabled?: boolean;
}

export function Composer({
  value,
  onChangeText,
  onSend,
  onProposeTime,
  sending = false,
  isOnline,
  proposeDisabled = false,
}: Props) {
  const problem = validateMessageBody(value);
  const sendable = problem === null && !sending;
  /** Only worth showing while it is actionable — not on every empty field. */
  const tooLong = normaliseMessageBody(value).length > MESSAGE_MAX_LENGTH;

  return (
    <View style={styles.wrapper}>
      {tooLong && (
        <Text style={styles.problem} accessibilityLiveRegion="polite">
          {problem}
        </Text>
      )}

      <View style={styles.row}>
        <Pressable
          onPress={onProposeTime}
          disabled={proposeDisabled}
          accessibilityRole="button"
          accessibilityLabel="Propose a study time"
          accessibilityHint="Opens the day and time picker"
          style={({ pressed }) => [
            styles.propose,
            proposeDisabled && styles.inactive,
            pressed && !proposeDisabled && styles.pressed,
          ]}
        >
          <Text style={styles.proposeText}>＋</Text>
        </Pressable>

        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder="Message the group"
          placeholderTextColor={colors.textMuted}
          multiline
          // Send is a button, not the return key: on multiline the return key has
          // to insert a newline or a two-line message becomes impossible to type.
          blurOnSubmit={false}
          autoCapitalize="sentences"
          autoCorrect
          accessibilityLabel="Message"
          style={styles.input}
        />

        <Pressable
          onPress={onSend}
          disabled={!sendable}
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !sendable, busy: sending }}
          style={({ pressed }) => [
            styles.send,
            !sendable && styles.inactive,
            pressed && sendable && styles.pressed,
          ]}
        >
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>

      {!isOnline && (
        <Text style={styles.hint}>
          You are offline. Messages you send wait on the phone and go out when you
          are back.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  input: {
    flex: 1,
    minHeight: MIN_TOUCH,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.md,
    color: colors.text,
    backgroundColor: colors.background,
    // Android centres single-line text oddly once maxHeight is set.
    textAlignVertical: 'top',
  },
  propose: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  proposeText: { fontSize: fontSize.lg, fontWeight: '600', color: colors.primary },
  send: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: { fontSize: fontSize.md, fontWeight: '600', color: colors.textInverse },
  inactive: { opacity: 0.45 },
  pressed: { opacity: 0.85 },
  problem: { fontSize: fontSize.xs, color: colors.danger, marginBottom: spacing.xs },
  hint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: spacing.xs,
    lineHeight: 16,
  },
});
