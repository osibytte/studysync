import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/Button';
import { ChoiceChips, type Choice } from '@/components/ChoiceChips';
import { Screen } from '@/components/Screen';
import { SwitchRow } from '@/components/SwitchRow';
import { useNetwork } from '@/context/NetworkContext';
import { useNotificationPrefs } from '@/hooks/useNotificationPrefs';
import {
  DAILY_CAP_CHOICES,
  QUIET_HOUR_CHOICES,
  dailyCapLabel,
  quietHoursEnabled,
  quietHoursLabel,
} from '@/lib/notificationRules';
import { FONT, colors, fontSize, radius, spacing } from '@/theme';

/**
 * Notification preferences.
 *
 * THE SCREEN IS ORDERED BY HOW MUCH EACH CONTROL SILENCES, widest first: the
 * master switch, then quiet hours and the daily cap which cut across every kind,
 * then the eight per-category switches. A student who wants less noise reaches for
 * the first thing that works, and putting the blunt instrument last means they turn
 * eight switches off one at a time and never find it.
 *
 * THE 30-MINUTE STUDY ALARM HAS NO SWITCH HERE, and the screen says so rather than
 * leaving a gap somebody later fills. It is scheduled by the phone, fires from the
 * OS with the app closed and no signal, and this app cannot cancel one the OS has
 * already accepted — so a switch would be a control that does not control anything.
 * The student turns it off in the system settings, which is where the link goes.
 *
 * THE OS PERMISSION IS SHOWN SEPARATELY from every switch below it, because the two
 * are not the same claim: these switches decide what the sender is willing to send,
 * and the permission decides whether the phone will show it. When the OS has
 * refused, the per-kind switches are dimmed with the reason attached — a screen
 * where nine working-looking controls change nothing is worse than one that admits
 * it is blocked.
 *
 * Every change saves immediately. No Save button, because there is nothing here a
 * student would want to try and then abandon, and a switch that springs back
 * because a screen was left without saving is the worst outcome available.
 */
export default function NotificationSettingsScreen() {
  const router = useRouter();
  const { isOnline } = useNetwork();
  const {
    prefs,
    rows,
    osStatus,
    blockedReason,
    saving,
    error,
    status,
    refreshOsStatus,
    requestPermission,
    save,
    setSwitch,
  } = useNotificationPrefs();

  const [permissionNote, setPermissionNote] = useState<string | null>(null);

  // On every focus, not just the first: the student may have gone to the system
  // settings from the link below and come straight back, and the whole point of
  // that link is that this screen reflects what they did there.
  useFocusEffect(
    useCallback(() => {
      void refreshOsStatus();
    }, [refreshOsStatus])
  );

  const pushOff = prefs.push_enabled === false;
  const osDenied = osStatus === 'denied';
  const osUnavailable = osStatus === 'unavailable';

  /**
   * Why the switches below decide nothing right now, or null.
   *
   * Ordered by which one a student can actually do something about first: an
   * unsupported build cannot be fixed from the app at all, a refused permission
   * needs the system settings, and the master switch is one tap away up the screen.
   */
  const overriddenBy = osUnavailable
    ? (blockedReason ?? 'Notifications are not available on this build.')
    : osDenied
      ? 'Your phone is blocking notifications for StudySync. Turn them on in Settings first.'
      : pushOff
        ? 'All notifications are off. Turn the master switch on to use this.'
        : null;

  const quietOn = quietHoursEnabled(prefs);

  const capChoices: Choice<number>[] = DAILY_CAP_CHOICES.map((cap) => ({
    value: cap,
    label: dailyCapLabel(cap),
  }));
  const hourChoices: Choice<string>[] = QUIET_HOUR_CHOICES.map((hour) => ({
    value: hour,
    label: hour,
  }));

  async function handleAskPermission() {
    setPermissionNote(null);
    const next = await requestPermission();
    if (next === 'ready') {
      setPermissionNote('Your phone will show StudySync notifications now.');
    } else if (next === 'unavailable') {
      setPermissionNote(blockedReason ?? 'Notifications are not available on this build.');
    } else {
      // The system prompt is asked at most once per install; after that
      // `requestPermissionsAsync` resolves denied without showing anything, so
      // pointing at Settings is the only honest next step.
      setPermissionNote(
        'Your phone said no. Open Settings to turn notifications on for StudySync.'
      );
    }
  }

  /**
   * Turning quiet hours off is setting the end equal to the start, which is
   * `isWithinQuietHours`'s own definition of off — so there is no third setting
   * and no extra jsonb key. Turning it back on restores `0001`'s window rather
   * than a zero-length one the student would then have to widen by hand.
   */
  function handleToggleQuiet(next: boolean) {
    if (next) {
      void save({ quiet_hours_start: '22:00', quiet_hours_end: '07:00' });
    } else {
      void save({ quiet_hours_end: prefs.quiet_hours_start });
    }
  }

  const infoRows = rows.filter((row) => !row.nudge);
  const nudgeRows = rows.filter((row) => row.nudge);

  return (
    <Screen
      title="Notifications"
      subtitle="What StudySync tells you, and when it keeps quiet."
      footer={<Button label="Back" variant="secondary" onPress={() => router.back()} />}
    >
      {!isOnline && (
        <Text style={styles.note}>
          You are offline. Changes are saved on this phone and sync when you are back
          online.
        </Text>
      )}
      {!!error && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
      {!!status && (
        <Text style={styles.status} accessibilityLiveRegion="polite">
          {status}
        </Text>
      )}

      {/* --- The permission, before anything it would override --- */}
      {(osDenied || osUnavailable) && (
        <View style={styles.alertCard}>
          <Text style={styles.alertTitle}>
            {osUnavailable ? 'Not available on this build' : 'Your phone is blocking these'}
          </Text>
          <Text style={styles.alertBody}>
            {osUnavailable
              ? (blockedReason ??
                'Notifications need the phone app rather than the browser.')
              : 'StudySync does not have permission to show notifications, so nothing below can reach you — including the 30-minute study alarm.'}
          </Text>
          {!osUnavailable && (
            <>
              <Button label="Ask again" onPress={() => void handleAskPermission()} />
              <Button
                label="Open phone settings"
                variant="secondary"
                onPress={() => void Linking.openSettings()}
                style={styles.alertSecondButton}
              />
            </>
          )}
          {!!permissionNote && (
            <Text style={styles.alertNote} accessibilityLiveRegion="polite">
              {permissionNote}
            </Text>
          )}
        </View>
      )}

      {/* --- The master switch --- */}
      <Text style={styles.sectionHeader}>Everything</Text>
      <SwitchRow
        label="Notifications from StudySync"
        hint="Off means nothing is sent at all, urgent included."
        value={prefs.push_enabled !== false}
        onChange={(next) => void save({ push_enabled: next })}
        disabled={saving}
        overriddenBy={
          osUnavailable
            ? (blockedReason ?? 'Not available on this build.')
            : osDenied
              ? 'Your phone is blocking notifications for StudySync.'
              : null
        }
      />

      {/* --- The two settings that cut across every kind --- */}
      <Text style={styles.sectionHeader}>How much, and when</Text>

      <View style={styles.settingCard}>
        <ChoiceChips
          label="AT MOST, PER DAY"
          choices={capChoices}
          selected={prefs.daily_cap}
          onSelect={(cap) => void save({ daily_cap: cap })}
          disabled={saving || !!overriddenBy}
        />
        <Text style={styles.settingHint}>
          Counts the ordinary ones. A cancelled study time, being matched into a
          group, and the 30-minute alarm always come through — those are the ones
          that cost you a wasted trip if they do not.
        </Text>
      </View>

      <View style={styles.settingCard}>
        <SwitchRow
          label="Quiet hours"
          hint={quietHoursLabel(prefs)}
          value={quietOn}
          onChange={handleToggleQuiet}
          disabled={saving}
          overriddenBy={overriddenBy}
        />
        {quietOn && (
          <>
            <ChoiceChips
              label="FROM"
              choices={hourChoices}
              selected={prefs.quiet_hours_start}
              onSelect={(hour) => void save({ quiet_hours_start: hour })}
              disabled={saving || !!overriddenBy}
              scroll
            />
            <ChoiceChips
              label="UNTIL"
              choices={hourChoices}
              selected={prefs.quiet_hours_end}
              onSelect={(hour) => void save({ quiet_hours_end: hour })}
              disabled={saving || !!overriddenBy}
              scroll
            />
            <Text style={styles.settingHint}>
              A study time your group agreed on still wakes you 30 minutes before —
              you chose that meeting, so quiet hours do not cancel it. Everything
              else waits until the window ends.
            </Text>
          </>
        )}
      </View>

      {/* --- Per-kind: the four things that happened --- */}
      <Text style={styles.sectionHeader}>What to tell you about</Text>
      {infoRows.map((row) => (
        <SwitchRow
          key={row.key}
          label={row.label}
          hint={row.hint}
          value={row.enabled}
          onChange={(next) => void setSwitch(row.key, next)}
          disabled={saving}
          overriddenBy={overriddenBy}
        />
      ))}

      {/* --- Per-kind: the four nudges --- */}
      <Text style={styles.sectionHeader}>Nudges</Text>
      <Text style={styles.sectionBlurb}>
        Small prompts meant to get a group meeting rather than to report something.
        Keep the ones that help and turn the rest off — none of them can wake you at
        night or use up the daily allowance above.
      </Text>
      {nudgeRows.map((row) => (
        <SwitchRow
          key={row.key}
          label={row.label}
          hint={row.hint}
          value={row.enabled}
          onChange={(next) => void setSwitch(row.key, next)}
          disabled={saving}
          overriddenBy={overriddenBy}
        />
      ))}

      {/* --- The alarm, which none of the above governs --- */}
      <Text style={styles.sectionHeader}>The 30-minute study alarm</Text>
      <View style={styles.settingCard}>
        <Text style={styles.settingHint}>
          When your group agrees a study time, your phone rings 30 minutes before it
          — on {Platform.OS === 'android' ? 'alarm volume' : 'the lock screen'}, with
          no signal needed and the app closed. It is set by the phone rather than
          sent by us, so there is no switch for it here: nothing above turns it off,
          and nothing above can turn it back on.
        </Text>
        <Button
          label="Open phone settings"
          variant="ghost"
          onPress={() => void Linking.openSettings()}
          style={styles.alarmButton}
        />
      </View>

      <Text style={styles.footnote}>
        These settings apply to your account, not just this phone.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
    marginBottom: spacing.sm,
  },
  error: { fontSize: fontSize.sm, color: colors.danger, marginBottom: spacing.sm, lineHeight: 20 },
  status: { fontSize: fontSize.sm, color: colors.success, marginBottom: spacing.sm, lineHeight: 20 },
  alertCard: {
    padding: spacing.lg,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  alertTitle: { fontSize: fontSize.sm, fontFamily: FONT.bold, color: colors.text },
  alertBody: {
    fontSize: fontSize.sm,
    color: colors.text,
    lineHeight: 20,
    marginTop: spacing.xs,
    marginBottom: spacing.md,
  },
  alertSecondButton: { marginTop: spacing.sm },
  alertNote: { fontSize: fontSize.xs, color: colors.text, marginTop: spacing.sm, lineHeight: 18 },
  sectionHeader: {
    fontSize: fontSize.md,
    fontFamily: FONT.bold,
    color: colors.text,
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  sectionBlurb: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
    marginTop: -spacing.sm,
    marginBottom: spacing.md,
  },
  settingCard: {
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
  },
  settingHint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
    marginTop: spacing.sm,
  },
  alarmButton: { marginTop: spacing.sm },
  footnote: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
    marginTop: spacing.xl,
  },
});
