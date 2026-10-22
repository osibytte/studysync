import { Tabs } from 'expo-router';
import React from 'react';
import { useReminderSync } from '@/hooks/useReminders';
import { useNotificationBadge } from '@/hooks/useNotifications';
import { useAuth } from '@/context/AuthContext';
import { FloatingTabBar } from '@/components/FloatingTabBar';
import { colors } from '@/theme';

/**
 * The signed-in shell: a floating tab bar for the four places a student lives
 * (home, groups, inbox, profile), with the group sub-pages still a stack inside
 * the Groups tab so back-stepping between them is unchanged. The bar itself is
 * `FloatingTabBar`; it hides on pages deeper than a tab's root.
 *
 * `useReminderSync` hangs here, on the one component every signed-in screen is
 * mounted inside and no unauthenticated screen is, so the study alarms on this
 * phone are reconciled for exactly as long as there is a student to reconcile
 * them for. It renders nothing.
 */
export default function AppLayout() {
  useReminderSync();
  const { profile } = useAuth();
  const { unread } = useNotificationBadge(profile?.user_id ?? null);

  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        // No native headers: every screen draws its own, so the offline
        // banner stays at the very top of the viewport.
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      <Tabs.Screen name="home" options={{ title: 'Home' }} />
      <Tabs.Screen name="groups" options={{ title: 'Groups' }} />
      <Tabs.Screen
        name="notifications"
        options={{
          title: 'Inbox',
          tabBarBadge: unread > 0 ? (unread > 99 ? '99+' : unread) : undefined,
        }}
      />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
      {/* Routed but pushed, not tabs: the floating bar steps aside on them. */}
      <Tabs.Screen name="notification-settings" options={{ href: null }} />
      <Tabs.Screen name="courses" options={{ href: null }} />
    </Tabs>
  );
}
