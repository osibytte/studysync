import { Feather } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { FONT, MIN_TOUCH, colors, shadowCard } from '@/theme';

type Tone = 'light' | 'glass' | 'dark' | 'soft';

interface Props {
  icon: React.ComponentProps<typeof Feather>['name'];
  /** Spoken label; icon-only controls must always have one. */
  label: string;
  onPress: () => void;
  /** light = white on the canvas, glass = on the green band, dark = ink, soft = grey. */
  tone?: Tone;
  /** A count in a red dot at the top right (unread notifications). */
  count?: number;
  size?: number;
  disabled?: boolean;
  style?: ViewStyle;
}

/** A round icon button: back, close, files, notifications, send. */
export function RoundButton({
  icon,
  label,
  onPress,
  tone = 'light',
  count,
  size = MIN_TOUCH,
  disabled = false,
  style,
}: Props) {
  const shown = count && count > 0 ? (count > 99 ? '99+' : String(count)) : null;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={shown ? `${label}, ${shown} unread` : label}
      accessibilityState={{ disabled }}
      hitSlop={size < MIN_TOUCH ? (MIN_TOUCH - size) / 2 : undefined}
      style={({ pressed }) => [
        styles.base,
        { width: size, height: size, borderRadius: size / 2 },
        toneStyle[tone],
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
    >
      <Feather name={icon} size={size >= MIN_TOUCH ? 20 : 17} color={iconColor[tone]} />
      {!!shown && (
        <View style={[styles.count, tone === 'glass' && styles.countOnBand]}>
          <Text style={styles.countText}>{shown}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.4 },
  count: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.flame,
    borderWidth: 2,
    borderColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countOnBand: { borderColor: colors.bandTop },
  countText: { color: colors.textInverse, fontSize: 9, fontFamily: FONT.bold, lineHeight: 12 },
});

const toneStyle: Record<Tone, ViewStyle> = {
  light: { backgroundColor: colors.surface, ...shadowCard },
  glass: { backgroundColor: colors.bandGlass },
  dark: { backgroundColor: colors.accent },
  soft: { backgroundColor: colors.surfaceAlt },
};

const iconColor: Record<Tone, string> = {
  light: colors.text,
  glass: colors.onBand,
  dark: colors.textInverse,
  soft: colors.text,
};
