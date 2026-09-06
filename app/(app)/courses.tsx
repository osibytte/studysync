import { useRouter } from 'expo-router';
import React from 'react';
import { CoursePicker } from '@/screens/CoursePicker';

/**
 * Course editing after onboarding.
 *
 * A separate route from the onboarding step because the route guard redirects
 * any onboarded student out of `(onboarding)` — sending them there from the
 * profile screen would bounce them straight back to home.
 *
 * No minimum here. A student mid-edit may remove their last course before
 * adding a replacement, and blocking that is more annoying than allowing a
 * temporarily empty list.
 */
export default function ManageCoursesScreen() {
  const router = useRouter();

  return (
    <CoursePicker
      subtitle="Add or remove courses, and change how you are finding one. Changes save as you tap."
      footerLabel={() => 'Done'}
      onDone={() => router.back()}
    />
  );
}
