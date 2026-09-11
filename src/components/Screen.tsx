import React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { OfflineBanner } from './OfflineBanner';
import { colors, fontSize, FONT, spacing, typography } from '@/theme';

interface Props {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  /** False for full-height layouts that manage their own scrolling (e.g. FlatList). */
  scroll?: boolean;
  /** Center the content vertically in the leftover space (auth screens). */
  centered?: boolean;
  /** Pinned to the bottom, outside the scroll area — for primary actions. */
  footer?: React.ReactNode;
  contentStyle?: ViewStyle;
  /**
   * Overrides the footer's own padding and top border. For a footer that is
   * edge-to-edge and draws its own frame — the chat composer and its propose
   * sheet — where the default 16pt inset and a second border read as a mistake.
   */
  footerStyle?: ViewStyle;
}

/**
 * Standard screen frame: safe area, offline banner, optional header, and
 * keyboard handling.
 *
 * Every screen goes through this so the offline banner cannot be forgotten on
 * one of them — the inconsistency would be worse than not having it.
 */
export function Screen({
  children,
  title,
  subtitle,
  scroll = true,
  centered = false,
  footer,
  contentStyle,
  footerStyle,
}: Props) {
  const body = (
    <>
      {(!!title || !!subtitle) && (
        <View style={styles.header}>
          {!!title && (
            <Text style={typography.title} accessibilityRole="header">
              {title}
            </Text>
          )}
          {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
        </View>
      )}
      {children}
    </>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <OfflineBanner />
      <KeyboardAvoidingView
        style={styles.flex}
        // Android handles this via windowSoftInputMode; forcing 'height' there
        // fights the system and causes jumpy layouts on entry-level devices.
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {scroll ? (
          <ScrollView
            style={styles.flex}
            contentContainerStyle={[
              styles.content,
              centered && styles.contentCentered,
              contentStyle,
            ]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {body}
          </ScrollView>
        ) : (
          <View
            style={[styles.flex, styles.content, centered && styles.bodyCentered, contentStyle]}
          >
            {body}
          </View>
        )}
        {!!footer && <View style={[styles.footer, footerStyle]}>{footer}</View>}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xl },
  // Auth screens: the form floats in the middle of the leftover space, with
  // flexGrow so the keyboard can still collapse the space and push it up.
  contentCentered: { flexGrow: 1, justifyContent: 'center' },
  bodyCentered: { justifyContent: 'center' },
  header: { marginBottom: spacing.xl },
  subtitle: {
    fontSize: fontSize.md,
    color: colors.textMuted,
    marginTop: spacing.sm,
    lineHeight: 22,
    fontFamily: FONT.regular,
  },
  footer: {
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
});
