import { Feather } from '@expo/vector-icons';
import type { Tabs } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { showTabBarFor, type TabRouteLike } from '@/lib/tabBar';
import { FONT, colors, shadowFloat } from '@/theme';

type TabBarProps = Parameters<NonNullable<React.ComponentProps<typeof Tabs>['tabBar']>>[0];

/** The four places a student lives, in bar order. Anything else routed under (app) is pushed. */
const TABS: { name: string; label: string; icon: React.ComponentProps<typeof Feather>['name'] }[] = [
  { name: 'home', label: 'Home', icon: 'home' },
  { name: 'groups', label: 'Groups', icon: 'users' },
  { name: 'notifications', label: 'Inbox', icon: 'bell' },
  { name: 'profile', label: 'Profile', icon: 'user' },
];

/** Routes that are pushed over a tab and should get the whole screen. */
const FULL_SCREEN = new Set(['notification-settings', 'courses']);

/**
 * A black pill floating over the content, the active tab a white circle.
 *
 * Icons only: four familiar glyphs, each with its name as the accessibility
 * label so a screen reader still says "Inbox, 3 unread". Screens leave
 * `TAB_BAR_CLEARANCE` under their content so nothing ends up behind it.
 *
 * It steps aside on any page deeper than a tab's root (a group, its chat, its
 * files): those have their own pinned actions and the composer, and a bar
 * floating over a text field is a mis-tap waiting to happen. `showTabBarFor`
 * decides by the focused page's name, since a page opened across tabs sits
 * alone in its stack at index 0.
 */
export function FloatingTabBar({ state, descriptors, navigation, insets }: TabBarProps) {
  const focused = state.routes[state.index];
  if (FULL_SCREEN.has(focused.name)) return null;
  if (!showTabBarFor(focused as TabRouteLike)) return null;

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + 14 }]}>
      <View style={styles.bar}>
        {TABS.map((tab) => {
          const route = state.routes.find((r) => r.name === tab.name);
          if (!route) return null;
          const isFocused = focused.key === route.key;
          const badge = descriptors[route.key]?.options.tabBarBadge;

          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate(route.name, route.params);
            }
          };

          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              accessibilityRole="tab"
              accessibilityState={{ selected: isFocused }}
              accessibilityLabel={
                badge !== undefined ? `${tab.label}, ${badge} unread` : tab.label
              }
              style={({ pressed }) => [
                styles.item,
                isFocused && styles.itemActive,
                pressed && !isFocused && styles.itemPressed,
              ]}
            >
              <Feather
                name={tab.icon}
                size={22}
                color={isFocused ? colors.accent : 'rgba(255,255,255,0.72)'}
              />
              {badge !== undefined && !isFocused && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{badge}</Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  bar: {
    flexDirection: 'row',
    gap: 6,
    padding: 7,
    borderRadius: 999,
    backgroundColor: colors.accent,
    ...shadowFloat,
  },
  item: {
    width: 56,
    height: 52,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemActive: { backgroundColor: colors.surface, width: 52 },
  itemPressed: { backgroundColor: 'rgba(255,255,255,0.08)' },
  // Red with white text: the one place white-on-red appears, and only ever
  // over a count that the label also states.
  badge: {
    position: 'absolute',
    top: 6,
    right: 8,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.flame,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.textInverse, fontSize: 9, fontFamily: FONT.bold, lineHeight: 12 },
});
