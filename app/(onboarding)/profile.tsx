import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { StepHeader } from '@/components/StepHeader';
import { TextField } from '@/components/TextField';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { enqueue } from '@/lib/outbox';
import { friendlyError, supabase } from '@/lib/supabase';
import { validateDepartment, validateFullName } from '@/lib/validation';
import { colors, fontSize, spacing } from '@/theme';

/**
 * Onboarding step 1 of 3 — name and department.
 *
 * The name is usually already populated from signup metadata via the
 * on_auth_user_created trigger, so in practice this screen is mostly about
 * department and confirming the name is right.
 */
export default function OnboardingProfileScreen() {
  const { profile, applyLocalProfilePatch, refreshProfile } = useAuth();
  const { isOnline, refreshPending } = useNetwork();
  const router = useRouter();

  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [department, setDepartment] = useState(profile?.department ?? '');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleContinue() {
    setFormError(null);

    const nextErrors = {
      fullName: validateFullName(fullName) ?? undefined,
      department: validateDepartment(department) ?? undefined,
    };
    if (Object.values(nextErrors).some(Boolean)) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});

    if (!profile) {
      setFormError('Your profile is still loading. Try again in a moment.');
      return;
    }

    const patch = { full_name: fullName.trim(), department: department.trim() };

    setSaving(true);
    try {
      // Update local state first so the next screen reads the new values
      // whether or not the write reaches Supabase.
      applyLocalProfilePatch(patch);

      if (isOnline) {
        const { error } = await supabase
          .from('users')
          .update(patch)
          .eq('user_id', profile.user_id);
        if (error) throw error;
        await refreshProfile();
      } else {
        // Queue it. The student continues onboarding normally; the write lands
        // when connectivity returns.
        await enqueue('profile.update', patch, profile.user_id);
        await refreshPending();
      }

      router.push('/(onboarding)/courses');
    } catch (error) {
      // Fall back to the queue rather than losing the input. This is the
      // common case on hostel wifi: NetInfo says online, the request still fails.
      try {
        await enqueue('profile.update', patch, profile.user_id);
        await refreshPending();
        router.push('/(onboarding)/courses');
      } catch {
        setFormError(friendlyError(error));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen
      title="About you"
      subtitle="We use your department to help suggest relevant courses."
      footer={
        <Button
          label="Continue"
          onPress={() => void handleContinue()}
          loading={saving}
          disabled={saving}
        />
      }
    >
      <StepHeader step={1} total={3} />

      <View style={styles.form}>
        <TextField
          label="Full name"
          value={fullName}
          onChangeText={setFullName}
          placeholder="Adebayo Okonkwo"
          autoCapitalize="words"
          error={errors.fullName}
          editable={!saving}
        />
        <TextField
          label="Department"
          value={department}
          onChangeText={setDepartment}
          placeholder="Computer Science"
          autoCapitalize="words"
          error={errors.department}
          helper="The department you're enrolled in"
          editable={!saving}
        />

        {!!formError && (
          <Text style={styles.formError} accessibilityLiveRegion="polite">
            {formError}
          </Text>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { marginTop: spacing.sm },
  formError: { color: colors.danger, fontSize: fontSize.sm, marginTop: spacing.sm },
});
