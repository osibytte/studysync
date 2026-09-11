import { Tabs } from 'expo-router';
import React from 'react';
import { Feather } from '@expo/vector-icons';
import { StyleSheet } from 'react-native';
import { useReminderSync } from '@/hooks/useReminders';
import { useNotificationBadge } from '@/hooks/useNotifications';
import { useAuth } from '@/context/AuthContext';
import { FONT, colors } from '@/theme';

/**
 * The signed-in shell: a bottom tab bar for the four places a student lives
 * (home, groups, inbox, profile), with the group sub-pages still a stack inside
 * the Groups tab so back-stepping between them is unchanged.
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
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primaryDark,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: styles.tabBar,
        tabBarLabelStyle: styles.tabLabel,
        // No native headers: every screen draws its own, so the offline
        // banner stays at the very top of the viewport.
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <Feather name="home" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="groups"
        options={{
          title: 'Groups',
          tabBarIcon: ({ color, size }) => <Feather name="users" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: 'Inbox',
          tabBarIcon: ({ color, size }) => <Feather name="bell" size={size} color={color} />,
          tabBarBadge: unread > 0 ? (unread > 99 ? '99+' : unread) : undefined,
          tabBarBadgeStyle: styles.tabBadge,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => <Feather name="user" size={size} color={color} />,
        }}
      />
      {/* Routed but pushed, not tabs: they keep the tab bar hidden off their own screens. */}
      <Tabs.Screen name="notification-settings" options={{ href: null }} />
      <Tabs.Screen name="courses" options={{ href: null }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    minHeight: 64,
    paddingTop: 6,
  },
  tabLabel: {
    fontSize: 11,
    fontFamily: FONT.semi,
  },
  // Orange-red with white text: the one place white-on-flame appears, and only
  // ever over a count that the label also states.
  tabBadge: {
    backgroundColor: colors.flame,
    color: colors.textInverse,
    fontFamily: FONT.semi,
  },
});
