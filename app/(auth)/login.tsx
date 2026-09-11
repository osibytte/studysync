import { Link } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { TextField } from '@/components/TextField';
import { useAuth } from '@/context/AuthContext';
import { friendlyError } from '@/lib/supabase';
import { validateEmail } from '@/lib/validation';
import { FONT, colors, fontSize, spacing } from '@/theme';

export default function LoginScreen() {
  const { signIn } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setFormError(null);

    const emailError = validateEmail(email);
    // No length rule on sign-in: an existing account may predate the current
    // minimum, and "wrong password" is the honest error either way.
    const passwordError = password ? null : 'Password is required';

    if (emailError || passwordError) {
      setErrors({ email: emailError ?? undefined, password: passwordError ?? undefined });
      return;
    }
    setErrors({});

    setSubmitting(true);
    try {
      await signIn(email, password);
      // No navigation here — the route guard in app/_layout.tsx reacts to the
      // session change and routes to onboarding or home as appropriate.
    } catch (error) {
      setFormError(friendlyError(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen title="StudySync" subtitle="Find study partners on your courses at UI." centered>
      <View style={styles.form}>
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
          placeholder="Your password"
          secureTextEntry
          autoComplete="current-password"
          error={errors.password}
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
          label="Sign in"
          onPress={() => void handleSubmit()}
          loading={submitting}
          disabled={submitting}
        />

        <View style={styles.footerRow}>
          <Text style={styles.footerText}>New here? </Text>
          <Link href="/(auth)/signup" style={styles.link}>
            Create an account
          </Link>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { marginTop: spacing.md },
  formError: {
    color: colors.danger,
    fontSize: fontSize.sm,
    marginBottom: spacing.md,
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: spacing.xl,
  },
  footerText: { fontSize: fontSize.sm, fontFamily: FONT.regular, color: colors.textMuted },
  link: { fontSize: fontSize.sm, fontFamily: FONT.semi, color: colors.primaryDark },
});
