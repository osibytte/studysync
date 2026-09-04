import { Redirect } from 'expo-router';
import React from 'react';

/**
 * Entry route. The guard in _layout.tsx owns the real routing decision, so
 * this just points somewhere valid; if the student is not signed in the guard
 * immediately redirects to login.
 */
export default function Index() {
  return <Redirect href="/(app)/home" />;
}
