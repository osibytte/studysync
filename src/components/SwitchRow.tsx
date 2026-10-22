import React from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { FONT, MIN_TOUCH, colors, fontSize, radius, shadowCard, spacing } from '@/theme';

interface Props {
  label: string;
  /** The one line under the label — where a cooldown gets told to the student. */
  hint?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Dimmed and un-flippable, with the reason spoken — for an OS-level block. */
  overriddenBy?: string | null;
}

/**
 * One labelled switch.
 *
 * The whole row is the target, not just the switch: a 51pt-wide control at the
 * right edge of a phone held in the left hand is a mis-tap, and this screen has
 * nine of them. `Switch` keeps its own hit area for the students who aim at it.
 *
 * `overriddenBy` is the honest case rather than a decoration. When push is off, or
 * the OS has refused permission, these switches decide nothing — so they are
 * disabled and the reason is put in the accessibility hint, where a screen reader
 * reads it out instead of announcing a control that appears to work.
 */
export function SwitchRow({
  label,
  hint,
  value,
  onChange,
  disabled = false,
  overriddenBy = null,
}: Props) {
  const inactive = disabled || !!overriddenBy;
  const shown = overriddenBy ? false : value;

  return (
    <Pressable
      onPress={() => onChange(!value)}
      disabled={inactive}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={overriddenBy ?? hint}
      accessibilityState={{ checked: shown, disabled: inactive }}
      style={({ pressed }) => [
        styles.row,
        pressed && !inactive && styles.pressed,
        inactive && styles.inactive,
      ]}
    >
      <View style={styles.textCol}>
        <Text style={styles.label}>{label}</Text>
        {!!hint && <Text style={styles.hint}>{hint}</Text>}
      </View>
      <Switch
        value={shown}
        onValueChange={onChange}
        disabled={inactive}
        trackColor={{ false: colors.borderStrong, true: colors.primary }}
        thumbColor={colors.surface}
        // iOS renders the "off" track as near-white by default, which on this
        // surface is invisible; both platforms get the same explicit colours.
        ios_backgroundColor={colors.borderStrong}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: MIN_TOUCH + 20,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
    ...shadowCard,
  },
  pressed: { backgroundColor: colors.surfaceAlt },
  inactive: { opacity: 0.55 },
  textCol: { flex: 1, paddingRight: spacing.md },
  label: { fontSize: fontSize.md, fontFamily: FONT.semi, color: colors.text },
  hint: { fontSize: fontSize.xs, fontFamily: FONT.regular, color: colors.textMuted, marginTop: 3, lineHeight: 17 },
});
