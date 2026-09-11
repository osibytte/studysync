import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { FONT, MIN_TOUCH, colors, fontSize, radius, spacing } from '@/theme';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface Props {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  small?: boolean;
  style?: ViewStyle;
  /** Spoken by screen readers when the label alone isn't descriptive enough. */
  accessibilityHint?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  fullWidth = true,
  small = false,
  style,
  accessibilityHint,
}: Props) {
  // A loading button must not be pressable, or a double-tap fires the action
  // twice — which on a slow connection is the single easiest way to create
  // duplicate rows.
  const isInactive = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={isInactive}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isInactive, busy: loading }}
      style={({ pressed }) => [
        styles.base,
        small && styles.small,
        variantStyles[variant],
        fullWidth && styles.fullWidth,
        pressed && !isInactive && styles.pressed,
        isInactive && styles.inactive,
        style,
      ]}
    >
      <View style={styles.content}>
        {loading && (
          <ActivityIndicator
            size="small"
            color={spinnerColors[variant]}
            style={styles.spinner}
          />
        )}
        <Text style={[styles.label, labelStyles[variant]]} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md + 2,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  small: {
    minHeight: MIN_TOUCH - 4,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  fullWidth: { alignSelf: 'stretch' },
  content: { flexDirection: 'row', alignItems: 'center' },
  spinner: { marginRight: spacing.sm },
  label: {
    fontSize: fontSize.md,
    fontFamily: FONT.semi,
    lineHeight: 20,
  },
  // Press = sink slightly and dim, like a pill being pushed.
  pressed: { opacity: 0.8, transform: [{ translateY: 1 }] },
  inactive: { opacity: 0.45 },
});

const variantStyles: Record<Variant, ViewStyle> = {
  // Lime with ink text: the one primary action per screen. White on lime
  // would fail contrast in daylight, which is exactly where these phones live.
  primary: { backgroundColor: colors.accent },
  secondary: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
  },
  ghost: { backgroundColor: 'transparent' },
  danger: { backgroundColor: colors.flame },
};

const labelStyles = {
  primary: { color: colors.text },
  secondary: { color: colors.text },
  ghost: { color: colors.primaryDark },
  danger: { color: colors.textInverse },
} as const;

const spinnerColors = {
  primary: colors.text,
  secondary: colors.primaryDark,
  ghost: colors.primaryDark,
  danger: colors.textInverse,
} as const;
