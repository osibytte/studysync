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
import { RoundButton } from './RoundButton';
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
  /**
   * A pushed screen: a round back button at the top left, the title centred
   * beside it instead of large above the content, and the subtitle as the first
   * line of the content (they are sentences, too long for a bar).
   */
  onBack?: () => void;
  /** Close (X) rather than back (‹), for a screen that is a task to finish or abandon. */
  backIcon?: 'back' | 'close';
  /** A round button or two at the top right of a pushed screen's header. */
  headerRight?: React.ReactNode;
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
  onBack,
  backIcon = 'back',
  headerRight,
}: Props) {
  const pushed = !!onBack;
  const body = (
    <>
      {/* Pushed: the title is up in the bar, the subtitle opens the content. */}
      {pushed && !!subtitle && <Text style={styles.lead}>{subtitle}</Text>}
      {!pushed && (!!title || !!subtitle) && (
        <View style={styles.header}>
          {!!title && (
            <Text style={typography.display} accessibilityRole="header">
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
      {pushed && (
        <View style={styles.pushHead}>
          <RoundButton
            icon={backIcon === 'close' ? 'x' : 'chevron-left'}
            label={backIcon === 'close' ? 'Close' : 'Back'}
            onPress={onBack}
          />
          <View style={styles.pushTitleCol}>
            {!!title && (
              <Text style={styles.pushTitle} accessibilityRole="header" numberOfLines={1}>
                {title}
              </Text>
            )}
          </View>
          <View style={styles.pushRight}>{headerRight}</View>
        </View>
      )}
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
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  // Auth screens: the form floats in the middle of the leftover space, with
  // flexGrow so the keyboard can still collapse the space and push it up.
  contentCentered: { flexGrow: 1, justifyContent: 'center' },
  bodyCentered: { justifyContent: 'center' },
  header: { marginBottom: spacing.xl },
  pushHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  pushTitleCol: { flex: 1, alignItems: 'center', minWidth: 0 },
  pushTitle: {
    fontSize: fontSize.lg - 1,
    fontFamily: FONT.bold,
    color: colors.text,
    letterSpacing: -0.2,
  },
  lead: {
    fontSize: fontSize.sm,
    fontFamily: FONT.regular,
    color: colors.textSecondary,
    lineHeight: 21,
    marginBottom: spacing.lg + 2,
    paddingHorizontal: 2,
  },
  // Same width as the back button so the title stays centred.
  pushRight: { minWidth: 44, flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  subtitle: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    lineHeight: 22,
    fontFamily: FONT.regular,
  },
  // Pinned actions sit on the canvas with no rule above them, like the
  // floating "Book" bar in the reference.
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
    backgroundColor: colors.background,
  },
});
