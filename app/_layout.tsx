import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
// One import per weight rather than the package index: the index pulls in all
// eighteen files of each family (about 6 MB apiece) and the app uses five.
import { Montserrat_400Regular } from '@expo-google-fonts/montserrat/400Regular';
import { Montserrat_500Medium } from '@expo-google-fonts/montserrat/500Medium';
import { Montserrat_600SemiBold } from '@expo-google-fonts/montserrat/600SemiBold';
import { LeagueSpartan_700Bold } from '@expo-google-fonts/league-spartan/700Bold';
import { LeagueSpartan_800ExtraBold } from '@expo-google-fonts/league-spartan/800ExtraBold';
import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { NetworkProvider } from '@/context/NetworkContext';
import { colors } from '@/theme';

/**
 * Root layout: fonts (Montserrat for text, League Spartan for headings),
 * providers, then the auth-aware router gate.
 */

function RouteGuard({
  children,
  fontsLoaded,
}: {
  children: React.ReactNode;
  fontsLoaded: boolean;
}) {
  const { session, profile, initialising } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    // Never redirect before the stored session has been read, or a signed-in
    // student is briefly thrown to the login screen on every cold start.
    if (initialising) return;

    const group = segments[0];
    const inAuthFlow = group === '(auth)';
    const inOnboarding = group === '(onboarding)';

    if (!session) {
      if (!inAuthFlow) router.replace('/(auth)/login');
      return;
    }

    /**
     * Signed in but profile not yet loaded. This happens offline on a cold
     * start before the cache read resolves. Redirecting now would bounce the
     * student into onboarding they already completed, so hold position and let
     * the next render decide.
     */
    if (!profile) return;

    if (!profile.onboarding_complete) {
      if (!inOnboarding) router.replace('/(onboarding)/profile');
      return;
    }

    // Fully set up — keep them out of auth and onboarding routes.
    if (inAuthFlow || inOnboarding) router.replace('/(app)/home');
  }, [initialising, session, profile, segments, router]);

  // Fonts must be ready before any screen renders, or the first paint is in
  // the wrong typeface and reflows once the fonts land.
  if (initialising || !fontsLoaded) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color={colors.primaryDark} />
      </View>
    );
  }

  return <>{children}</>;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Montserrat_400Regular,
    Montserrat_500Medium,
    Montserrat_600SemiBold,
    // The heading face (FONT.bold and FONT.extra in src/theme.ts).
    LeagueSpartan_700Bold,
    LeagueSpartan_800ExtraBold,
  });

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <AuthProvider>
        <NetworkProvider>
          <RouteGuard fontsLoaded={fontsLoaded}>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(auth)" />
              <Stack.Screen name="(onboarding)" />
              <Stack.Screen name="(app)" />
            </Stack>
          </RouteGuard>
        </NetworkProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
});
