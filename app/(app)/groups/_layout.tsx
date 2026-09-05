import { Stack } from 'expo-router';
import React from 'react';

/**
 * Own stack for the group section, so `router.back()` inside it steps between
 * group screens and only leaves for home at the bottom of the stack.
 *
 * Headers stay hidden, matching the parent layout: every screen renders its own
 * title via `Screen` and its own Back button, which keeps the offline banner at
 * the very top of the viewport rather than below a native header.
 */
export default function GroupsLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
