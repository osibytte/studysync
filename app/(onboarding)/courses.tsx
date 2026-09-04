import { useRouter } from 'expo-router';
import React from 'react';
import { CoursePicker } from '@/screens/CoursePicker';

/** Onboarding step 2 of 3. At least one course is required to continue. */
export default function OnboardingCoursesScreen() {
  const router = useRouter();

  return (
    <CoursePicker
      showStepHeader
      requireAtLeastOne
      footerLabel={(count) =>
        count > 0
          ? `Continue with ${count} course${count === 1 ? '' : 's'}`
          : 'Pick at least one course'
      }
      onDone={() => router.push('/(onboarding)/availability')}
    />
  );
}
