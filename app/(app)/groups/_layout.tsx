import { Stack } from 'expo-router';
import React from 'react';

/**
 * Own stack for the group section, so `router.back()` inside it steps between
 * group screens and only leaves for home at the bottom of the stack.
 *
 * Headers stay hidden, matching the parent layout: every screen renders its own
 * title via `Screen` and its own Back button, which keeps the offline banner at
 * the very top of the viewport rather than below a native header.
 *
 * `initialRouteName` keeps the groups list at the bottom of this stack when a
 * deeper page is opened from another tab (Home's "Open chat") or a link.
 * Without it the chat is mounted alone, Back skips the list and leaves for
 * Home, and the Groups tab reopens on the chat with no way up to the list.
 */
export const unstable_settings = {
  initialRouteName: 'index',
};

export default function GroupsLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
