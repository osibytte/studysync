import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  MESSAGE_MAX_LENGTH,
  normaliseMessageBody,
  validateMessageBody,
} from '@/lib/chatRules';
import { FONT, MIN_TOUCH, colors, fontSize, radius, spacing } from '@/theme';

/**
 * The bar at the bottom of the chat: type a message, propose a study time, or
 * share a file.
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
 *
 * THE ＋ OPENS A MENU RATHER THAN DOING ONE THING, which it did until Stage 4
 * gave it a second. Two 44pt buttons plus Send leave about 150pt for the field on
 * a 360pt phone — nine characters — so the choice is a list above the bar, not
 * another square beside it. It costs proposing a study time one extra tap, and
 * that is the right thing to spend: it is the rarer of the two and neither is
 * something a student does mid-sentence.
 */

interface Props {
  value: string;
  onChangeText: (value: string) => void;
  onSend: () => void;
  onProposeTime: () => void;
  onShareFile: () => void;
  /** True while a send is in flight. Offline sends are never in flight. */
  sending?: boolean;
  isOnline: boolean;
  /** Hides the propose button while the sheet is already open. */
  proposeDisabled?: boolean;
  /** Offline, or while an upload is already running. Files are online-only. */
  shareDisabled?: boolean;
}

export function Composer({
  value,
  onChangeText,
  onSend,
  onProposeTime,
  onShareFile,
  sending = false,
  isOnline,
  proposeDisabled = false,
  shareDisabled = false,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);

  const problem = validateMessageBody(value);
  const sendable = problem === null && !sending;
  /** Only worth showing while it is actionable — not on every empty field. */
  const tooLong = normaliseMessageBody(value).length > MESSAGE_MAX_LENGTH;

  /** Always close first: coming back from the OS picker should not find it open. */
  const choose = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  return (
    <View style={styles.wrapper}>
      {tooLong && (
        <Text style={styles.problem} accessibilityLiveRegion="polite">
          {problem}
        </Text>
      )}

      {menuOpen && (
        <View style={styles.menu}>
          <MenuItem
            label="Propose a study time"
            detail="Pick a day and time for the group to answer"
            disabled={proposeDisabled}
            onPress={() => choose(onProposeTime)}
          />
          <MenuItem
            label="Share a file"
            detail={
              !isOnline
                ? 'Needs a connection: bytes cannot wait in the outbox'
                : normaliseMessageBody(value) !== ''
                  ? 'What you have typed becomes the note on it'
                  : 'Notes, slides, a past paper — up to 25 MB'
            }
            disabled={shareDisabled}
            onPress={() => choose(onShareFile)}
          />
        </View>
      )}

      <View style={styles.row}>
        <Pressable
          onPress={() => setMenuOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityLabel={menuOpen ? 'Close' : 'Add to the conversation'}
          accessibilityHint={
            menuOpen ? undefined : 'Propose a study time, or share a file'
          }
          accessibilityState={{ expanded: menuOpen }}
          style={({ pressed }) => [
            styles.propose,
            menuOpen && styles.proposeOpen,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.proposeText}>{menuOpen ? '×' : '＋'}</Text>
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

/** One row of the ＋ menu. Disabled it still shows, with `detail` saying why. */
function MenuItem({
  label,
  detail,
  disabled,
  onPress,
}: {
  label: string;
  detail: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={detail}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.menuItem,
        disabled && styles.inactive,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={styles.menuLabel}>{label}</Text>
      <Text style={styles.menuDetail}>{detail}</Text>
    </Pressable>
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
  proposeText: { fontSize: fontSize.lg, fontFamily: FONT.semi, color: colors.primaryDark },
  /** Reads as held down while its menu is showing, so the × has a home. */
  proposeOpen: { backgroundColor: colors.surface, borderColor: colors.primaryDark },
  menu: {
    marginBottom: spacing.sm,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  menuItem: {
    minHeight: MIN_TOUCH,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  menuLabel: { fontSize: fontSize.md, fontFamily: FONT.semi, color: colors.text },
  menuDetail: { fontSize: fontSize.xs, fontFamily: FONT.regular, color: colors.textMuted, marginTop: 2 },
  send: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Ink on lime: white would fail daylight contrast on this fill.
  sendText: { fontSize: fontSize.md, fontFamily: FONT.semi, color: colors.text },
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
