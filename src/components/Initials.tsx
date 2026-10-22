import React from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { FONT, colors, tintFor } from '@/theme';

interface Props {
  /** What to show: a course code prefix ("MTH") or a person's initials ("AD"). */
  text: string;
  /** Stable key for the colour — a group or user id — so it never changes between visits. */
  colorKey?: string | null;
  size?: number;
  /** square = a group's tile, circle = a person. */
  shape?: 'square' | 'circle';
  /** White ring, for avatars that overlap a band or each other. */
  ring?: boolean;
  /** Ring colour when it should match a dark surface instead of white. */
  ringColor?: string;
  style?: ViewStyle;
}

/** "Ada Dimoko" -> "AD", "MTH 111" -> "MTH". */
export function initialsOf(name: string | null | undefined, max = 2): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, max).toUpperCase();
  return parts
    .slice(0, max)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
}

/** The letters off the front of a course code: "MTH 111" -> "MTH". */
export function courseTag(code: string | null | undefined): string {
  const m = (code ?? '').match(/[A-Za-z]+/);
  return m ? m[0].slice(0, 4).toUpperCase() : '—';
}

/**
 * A soft-coloured tile (groups) or circle (people) carrying a few letters.
 * No photos: the app ships no decorative media, so colour does that job, and
 * the hue comes from a hash of the id so the same group is always the same
 * colour.
 */
export function Initials({
  text,
  colorKey,
  size = 48,
  shape = 'square',
  ring = false,
  ringColor = colors.surface,
  style,
}: Props) {
  const tint = tintFor(colorKey ?? text);
  return (
    <View
      style={[
        styles.base,
        {
          width: size,
          height: size,
          borderRadius: shape === 'circle' ? size / 2 : Math.round(size * 0.33),
          backgroundColor: tint.bg,
        },
        ring && { borderWidth: Math.max(2, Math.round(size / 24)), borderColor: ringColor },
        style,
      ]}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      <Text
        style={[
          styles.text,
          { color: tint.fg, fontSize: Math.max(10, Math.round(size * (text.length > 2 ? 0.26 : 0.32))) },
        ]}
        numberOfLines={1}
      >
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
  text: { fontFamily: FONT.extra, letterSpacing: 0.3 },
});
