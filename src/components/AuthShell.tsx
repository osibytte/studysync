import { Feather } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import React, { useCallback } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { OfflineBanner } from './OfflineBanner';
import { FONT, colors, fontSize, radius, spacing } from '@/theme';

interface Props {
  title: string;
  lead?: string;
  children: React.ReactNode;
}

/**
 * Sign-in and sign-up: the brand mark and a large title on the green band, the
 * form on the sheet that overlaps it. The same band the tab screens open with,
 * so the first screen a student sees already looks like the app.
 */
export function AuthShell({ title, lead, children }: Props) {
  const insets = useSafeAreaInsets();

  useFocusEffect(
    useCallback(() => {
      setStatusBarStyle('light');
      return () => setStatusBarStyle('dark');
    }, []),
  );

  return (
    <View style={styles.root}>
      <KeyboardAvoidingView
        style={styles.flex}
        // Android handles this via windowSoftInputMode; forcing 'height' there
        // fights the system and causes jumpy layouts on entry-level devices.
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.band, { paddingTop: insets.top + spacing.lg }]}>
            <View style={styles.glow} pointerEvents="none" />
            <OfflineBanner rounded />
            <View style={styles.mark} accessibilityLabel="StudySync" accessible>
              <Feather name="refresh-cw" size={24} color={colors.onBand} />
            </View>
            <Text style={styles.title} accessibilityRole="header">
              {title}
            </Text>
            {!!lead && <Text style={styles.lead}>{lead}</Text>}
          </View>
          <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.xl }]}>
            {children}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bandBottom },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, backgroundColor: colors.background },
  band: {
    backgroundColor: colors.bandTop,
    paddingHorizontal: spacing.xl,
    paddingBottom: 56,
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
  mark: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: colors.bandGlass,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xl,
  },
  title: {
    fontSize: fontSize.xxl + 2,
    fontFamily: FONT.extra,
    letterSpacing: -0.4,
    lineHeight: 38,
    color: colors.onBand,
    marginTop: spacing.xl - 2,
  },
  lead: {
    fontSize: fontSize.md,
    fontFamily: FONT.regular,
    color: colors.onBandMuted,
    lineHeight: 22,
    marginTop: spacing.sm,
  },
  sheet: {
    flexGrow: 1,
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    marginTop: -24,
    paddingHorizontal: spacing.xl - 4,
    paddingTop: spacing.xl,
  },
});
