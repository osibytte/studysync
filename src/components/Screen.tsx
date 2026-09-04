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
import { colors, fontSize, spacing, typography } from '@/theme';

interface Props {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  /** False for full-height layouts that manage their own scrolling (e.g. FlatList). */
  scroll?: boolean;
  /** Pinned to the bottom, outside the scroll area — for primary actions. */
  footer?: React.ReactNode;
  contentStyle?: ViewStyle;
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
  footer,
  contentStyle,
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
            contentContainerStyle={[styles.content, contentStyle]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {body}
          </ScrollView>
        ) : (
          <View style={[styles.flex, styles.content, contentStyle]}>{body}</View>
        )}
        {!!footer && <View style={styles.footer}>{footer}</View>}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xl },
  header: { marginBottom: spacing.xl },
  subtitle: {
    fontSize: fontSize.md,
    color: colors.textMuted,
    marginTop: spacing.sm,
    lineHeight: 22,
  },
  footer: {
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
});
