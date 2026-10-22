import { useFocusEffect } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import React, { useCallback } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  type RefreshControlProps,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { OfflineBanner } from './OfflineBanner';
import { FONT, TAB_BAR_CLEARANCE, colors, fontSize, radius, spacing } from '@/theme';

interface Props {
  title: string;
  subtitle?: string | null;
  /** Round buttons or an avatar at the right of the title row. */
  right?: React.ReactNode;
  /** Anything that belongs on the green under the title (a week strip, quick links). */
  bandContent?: React.ReactNode;
  /** Put the title row's content on the band without the large title (profile). */
  hideTitle?: boolean;
  /** Extra green under the band content, for something that overlaps it from the sheet. */
  bandExtra?: number;
  refreshControl?: React.ReactElement<RefreshControlProps>;
  sheetStyle?: ViewStyle;
  children: React.ReactNode;
}

/**
 * The frame for the four tab screens: a deep green band holding the title, and
 * the content on a lighter sheet whose rounded top overlaps the band.
 *
 * The band scrolls away with the content rather than sticking, so a long list
 * gets the whole screen back. The status bar turns light while one of these is
 * focused and goes back to dark on blur, since every pushed screen sits on the
 * light canvas.
 */
type HeaderProps = Pick<
  Props,
  'title' | 'subtitle' | 'right' | 'bandContent' | 'hideTitle' | 'bandExtra'
>;

/** Light status bar while a band screen is focused, dark again on blur. */
export function useBandStatusBar() {
  useFocusEffect(
    useCallback(() => {
      setStatusBarStyle('light');
      return () => setStatusBarStyle('dark');
    }, []),
  );
}

/**
 * The green band on its own, for a screen whose content is a FlatList and so
 * cannot sit inside `BandScreen`'s ScrollView: pass it, followed by
 * `<SheetCap />`, as the list's header.
 */
export function BandHeader({
  title,
  subtitle,
  right,
  bandContent,
  hideTitle = false,
  bandExtra = 0,
}: HeaderProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.band, { paddingTop: insets.top + spacing.sm, paddingBottom: 40 + bandExtra }]}>
      {/* A soft lighter patch top-right, the band's only ornament. */}
      <View style={styles.glow} pointerEvents="none" />
      <OfflineBanner rounded />
      <View style={styles.titleRow}>
        <View style={styles.titleCol}>
          {!hideTitle && (
            <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
              {title}
            </Text>
          )}
          {!hideTitle && !!subtitle && (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          )}
        </View>
        {right}
      </View>
      {bandContent}
    </View>
  );
}

/** The rounded top edge of the sheet, overlapping the band. Pairs with `BandHeader`. */
export function SheetCap() {
  return <View style={styles.cap} />;
}

/** Styles a FlatList under a `BandHeader` needs: the root, and its content container. */
export const bandListStyles = {
  root: { flex: 1, backgroundColor: colors.bandBottom },
  content: { flexGrow: 1, backgroundColor: colors.background, paddingBottom: TAB_BAR_CLEARANCE },
  /** Side gutter for each row, since the header must run edge to edge. */
  row: { paddingHorizontal: spacing.lg },
} as const;

export function BandScreen({
  title,
  subtitle,
  right,
  bandContent,
  hideTitle = false,
  bandExtra = 0,
  refreshControl,
  sheetStyle,
  children,
}: Props) {
  useBandStatusBar();

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scroll}
        refreshControl={refreshControl}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <BandHeader
          title={title}
          subtitle={subtitle}
          right={right}
          bandContent={bandContent}
          hideTitle={hideTitle}
          bandExtra={bandExtra}
        />
        <View style={[styles.sheet, sheetStyle]}>{children}</View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  // The band colour behind the scroll so an iOS overscroll at the top shows
  // green, not a grey seam.
  root: { flex: 1, backgroundColor: colors.bandBottom },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, backgroundColor: colors.background },
  band: {
    backgroundColor: colors.bandTop,
    paddingHorizontal: spacing.xl - 4,
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    top: -140,
    right: -90,
    width: 320,
    height: 320,
    borderRadius: 160,
    backgroundColor: 'rgba(166,227,184,0.16)',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingTop: spacing.sm,
    minHeight: 52,
  },
  titleCol: { flex: 1, minWidth: 0 },
  title: {
    fontSize: fontSize.xl,
    fontFamily: FONT.bold,
    color: colors.onBand,
    letterSpacing: -0.2,
  },
  subtitle: {
    fontSize: fontSize.sm,
    fontFamily: FONT.regular,
    color: colors.onBandMuted,
    marginTop: 2,
  },
  cap: {
    height: 24,
    marginTop: -24,
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  sheet: {
    flexGrow: 1,
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    marginTop: -24,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: TAB_BAR_CLEARANCE,
  },
});
