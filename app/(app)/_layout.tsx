import { Stack } from 'expo-router';
import React from 'react';
import { useReminderSync } from '@/hooks/useReminders';

/**
 * The signed-in shell.
 *
 * `useReminderSync` hangs here, on the one component every signed-in screen is
 * mounted inside and no unauthenticated screen is, so the study alarms on this
 * phone are reconciled for exactly as long as there is a student to reconcile
 * them for. It renders nothing.
 */
export default function AppLayout() {
  useReminderSync();
  return <Stack screenOptions={{ headerShown: false }} />;
}
