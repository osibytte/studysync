import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type TextInputProps,
} from 'react-native';
import { FONT, colors, fontSize, radius, shadowCard, spacing } from '@/theme';

interface Props {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  /** Shown below the field in red. Presence also flips the border colour. */
  error?: string | null;
  helper?: string;
  secureTextEntry?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  autoComplete?: TextInputProps['autoComplete'];
  editable?: boolean;
  onSubmitEditing?: () => void;
  returnKeyType?: TextInputProps['returnKeyType'];
}

export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  error,
  helper,
  secureTextEntry,
  keyboardType,
  autoCapitalize = 'none',
  autoComplete,
  editable = true,
  onSubmitEditing,
  returnKeyType,
}: Props) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.wrapper}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoComplete={autoComplete}
        autoCorrect={false}
        editable={editable}
        onSubmitEditing={onSubmitEditing}
        returnKeyType={returnKeyType}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          focused && !error && styles.inputFocused,
          !!error && styles.inputError,
          !editable && styles.inputDisabled,
        ]}
        accessibilityLabel={label}
        // Announce the error to screen readers, not just sighted users.
        accessibilityHint={error ?? helper}
      />
      {!!error && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
      {!error && !!helper && <Text style={styles.helper}>{helper}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { marginBottom: spacing.lg },
  label: {
    fontSize: fontSize.sm,
    fontFamily: FONT.semi,
    color: colors.text,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  // White soft-shadowed fields on the canvas; the outline appears on focus.
  input: {
    minHeight: 56,
    borderWidth: 1.5,
    borderColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg + 2,
    paddingVertical: spacing.md,
    fontSize: fontSize.md,
    fontFamily: FONT.regular,
    color: colors.text,
    backgroundColor: colors.surface,
    ...shadowCard,
  },
  inputFocused: { borderColor: colors.accent },
  inputError: { borderColor: colors.danger },
  inputDisabled: { backgroundColor: colors.surfaceAlt, borderColor: colors.surfaceAlt, color: colors.textMuted },
  error: { fontSize: fontSize.xs, fontFamily: FONT.medium, color: colors.danger, marginTop: spacing.sm, marginLeft: spacing.xs },
  helper: { fontSize: fontSize.xs, fontFamily: FONT.regular, color: colors.textMuted, marginTop: spacing.sm, marginLeft: spacing.xs },
});
