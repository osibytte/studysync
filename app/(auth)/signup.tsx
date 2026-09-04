import { Link, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { TextField } from '@/components/TextField';
import { useAuth } from '@/context/AuthContext';
import { friendlyError } from '@/lib/supabase';
import {
  validateEmail,
  validateFullName,
  validatePassword,
  validatePasswordConfirm,
} from '@/lib/validation';
import { colors, fontSize, radius, spacing } from '@/theme';

export default function SignupScreen() {
  const { signUp } = useAuth();
  const router = useRouter();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);

  async function handleSubmit() {
    setFormError(null);

    const nextErrors = {
      fullName: validateFullName(fullName) ?? undefined,
      email: validateEmail(email) ?? undefined,
      password: validatePassword(password) ?? undefined,
      confirm: validatePasswordConfirm(password, confirm) ?? undefined,
    };

    if (Object.values(nextErrors).some(Boolean)) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});

    setSubmitting(true);
    try {
      const { needsEmailConfirmation } = await signUp(email, password, fullName);
      if (needsEmailConfirmation) {
        // Email confirmation is on in the Supabase dashboard, so there is no
        // session yet and the route guard will not move. Say so explicitly
        // rather than leaving the student on a screen that looks stuck.
        setAwaitingConfirmation(true);
      }
      // Otherwise the guard sees the new session and routes to onboarding.
    } catch (error) {
      setFormError(friendlyError(error));
    } finally {
      setSubmitting(false);
    }
  }

  if (awaitingConfirmation) {
    return (
      <Screen title="Check your email">
        <View style={styles.noticeBox}>
          <Text style={styles.noticeText}>
            We sent a confirmation link to {email.trim().toLowerCase()}. Tap the link,
            then come back and sign in.
          </Text>
        </View>
        <Button label="Go to sign in" onPress={() => router.replace('/(auth)/login')} />
      </Screen>
    );
  }

  return (
    <Screen
      title="Create your account"
      subtitle="Takes about a minute. You'll pick your courses next."
    >
      <View style={styles.form}>
        <TextField
          label="Full name"
          value={fullName}
          onChangeText={setFullName}
          placeholder="Adebayo Okonkwo"
          autoCapitalize="words"
          autoComplete="name"
          error={errors.fullName}
          editable={!submitting}
        />
        <TextField
          label="Email"
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          keyboardType="email-address"
          autoComplete="email"
          error={errors.email}
          editable={!submitting}
        />
        <TextField
          label="Password"
          value={password}
          onChangeText={setPassword}
          placeholder="At least 6 characters"
          secureTextEntry
          autoComplete="new-password"
          error={errors.password}
          helper="At least 6 characters"
          editable={!submitting}
        />
        <TextField
          label="Confirm password"
          value={confirm}
          onChangeText={setConfirm}
          placeholder="Type it again"
          secureTextEntry
          autoComplete="new-password"
          error={errors.confirm}
          editable={!submitting}
          returnKeyType="go"
          onSubmitEditing={() => void handleSubmit()}
        />

        {!!formError && (
          <Text style={styles.formError} accessibilityLiveRegion="polite">
            {formError}
          </Text>
        )}

        <Button
          label="Create account"
          onPress={() => void handleSubmit()}
          loading={submitting}
          disabled={submitting}
        />

        <View style={styles.footerRow}>
          <Text style={styles.footerText}>Already have an account? </Text>
          <Link href="/(auth)/login" style={styles.link}>
            Sign in
          </Link>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { marginTop: spacing.md },
  formError: { color: colors.danger, fontSize: fontSize.sm, marginBottom: spacing.md },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: spacing.xl,
  },
  footerText: { fontSize: fontSize.sm, color: colors.textMuted },
  link: { fontSize: fontSize.sm, fontWeight: '600', color: colors.primary },
  noticeBox: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.xl,
  },
  noticeText: { fontSize: fontSize.md, color: colors.text, lineHeight: 22 },
});
