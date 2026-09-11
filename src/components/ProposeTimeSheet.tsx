import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button } from './Button';
import { TextField } from './TextField';
import {
  MESSAGE_MAX_LENGTH,
  SESSION_DURATION_CHOICES,
  SESSION_LOCATION_MAX,
  combineLocalDateTime,
  firstOpenProposalSlot,
  formatDuration,
  isProposalSlotPast,
  proposalDayOptions,
  proposalTimeOptions,
  sessionWhenLabel,
  validateSessionProposal,
} from '@/lib/chatRules';
import { FONT, MIN_TOUCH, colors, fontSize, radius, spacing } from '@/theme';

/**
 * "Propose a study time", as chips rather than a native picker.
 *
 * Inline, in the chat screen's footer, because this codebase has no modals — the
 * same reason destructive actions confirm in place. It brings its own scroll and
 * a max height so it can never grow past the transcript.
 *
 * Everything it offers comes from `chatRules`: the days, the half-hourly slots,
 * the durations, whether a chip is already past, and — the important one — the
 * refusal. `validateSessionProposal` mirrors `propose_session`'s own checks, so a
 * proposal this form accepts is one Postgres accepts. That matters more than
 * usual here: offline the proposal goes into the outbox, and a body the server
 * would refuse is not discovered until the queue drains, long after the student
 * has put the phone away.
 *
 * The note becomes the timeline message's BODY server-side (or a default
 * sentence when it is blank), which is why it is bounded by a message's length
 * and described as what the group will read.
 */

export interface ProposalInput {
  startsAt: string;
  durationMin: number;
  location: string | null;
  note: string | null;
}

interface Props {
  onSubmit: (input: ProposalInput) => void;
  onCancel: () => void;
  submitting?: boolean;
  /** Proposing queues offline, so this is a note, not a lock. */
  isOnline: boolean;
  /** Whatever the last attempt failed with. */
  error?: string | null;
  now?: Date;
}

/** The RPC's own default, and the length most study sessions actually run. */
const DEFAULT_DURATION = 120;

export function ProposeTimeSheet({
  onSubmit,
  onCancel,
  submitting = false,
  isOnline,
  error = null,
  now,
}: Props) {
  /**
   * Captured once. The grid must not re-key itself under the student's thumb as
   * the clock ticks past a half hour — and the submit path below re-checks
   * against a fresh `Date` anyway, which is the check that actually matters.
   */
  const [openedAt] = useState(() => now ?? new Date());

  const days = useMemo(() => proposalDayOptions(openedAt), [openedAt]);
  const times = useMemo(() => proposalTimeOptions(), []);
  const opening = useMemo(() => firstOpenProposalSlot(openedAt), [openedAt]);

  const [dayKey, setDayKey] = useState(opening.dayKey);
  const [minutes, setMinutes] = useState(opening.minutes);
  const [durationMin, setDurationMin] = useState<number>(DEFAULT_DURATION);
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  /** Set when the slot expired while the sheet sat open. */
  const [expired, setExpired] = useState<string | null>(null);

  const startsAt = combineLocalDateTime(dayKey, minutes);
  const problem = validateSessionProposal({
    startsAt,
    durationMin,
    location,
    note,
    now: openedAt,
  });

  /** Switching day can strand a selection in the past — take the next one open. */
  const pickDay = (nextKey: string) => {
    setExpired(null);
    setDayKey(nextKey);
    if (isProposalSlotPast(nextKey, minutes, openedAt)) {
      const open = times.find((t) => !isProposalSlotPast(nextKey, t.minutes, openedAt));
      if (open) setMinutes(open.minutes);
    }
  };

  const submit = () => {
    // Against the real clock, not `openedAt`: a sheet left open past the slot it
    // had selected must not send a start time the server is about to refuse.
    const late = validateSessionProposal({
      startsAt,
      durationMin,
      location,
      note,
      now: new Date(),
    });
    if (late) {
      setExpired(late);
      return;
    }
    onSubmit({
      startsAt,
      durationMin,
      location: location.trim() || null,
      note: note.trim() || null,
    });
  };

  return (
    <View style={styles.sheet}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Propose a study time</Text>
        <Pressable
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={styles.close}
        >
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.label}>Which day</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          {days.map((day) => {
            const active = day.dayKey === dayKey;
            return (
              <Pressable
                key={day.dayKey}
                onPress={() => pickDay(day.dayKey)}
                accessibilityRole="button"
                accessibilityLabel={day.label}
                accessibilityState={{ selected: active }}
                style={({ pressed }) => [
                  styles.chip,
                  active && styles.chipActive,
                  pressed && styles.chipPressed,
                ]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {day.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <Text style={styles.label}>What time</Text>
        <View style={styles.grid}>
          {times.map((time) => {
            const active = time.minutes === minutes;
            /* Greyed rather than hidden: a student looking for 9am should see
               that it exists and has gone, not that the grid starts at noon. */
            const past = isProposalSlotPast(dayKey, time.minutes, openedAt);
            return (
              <Pressable
                key={time.minutes}
                onPress={() => {
                  setExpired(null);
                  setMinutes(time.minutes);
                }}
                disabled={past}
                accessibilityRole="button"
                accessibilityLabel={time.label}
                accessibilityState={{ selected: active, disabled: past }}
                style={({ pressed }) => [
                  styles.slot,
                  active && styles.chipActive,
                  past && styles.slotPast,
                  pressed && !past && styles.chipPressed,
                ]}
              >
                <Text
                  style={[
                    styles.chipText,
                    active && styles.chipTextActive,
                    past && styles.slotPastText,
                  ]}
                >
                  {time.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.label}>How long</Text>
        <View style={styles.chipRow}>
          {SESSION_DURATION_CHOICES.map((choice) => {
            const active = choice === durationMin;
            return (
              <Pressable
                key={choice}
                onPress={() => setDurationMin(choice)}
                accessibilityRole="button"
                accessibilityLabel={formatDuration(choice)}
                accessibilityState={{ selected: active }}
                style={({ pressed }) => [
                  styles.chip,
                  active && styles.chipActive,
                  pressed && styles.chipPressed,
                ]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {formatDuration(choice)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.fields}>
          <TextField
            label="Where (optional)"
            value={location}
            onChangeText={setLocation}
            placeholder="Library, ground floor"
            autoCapitalize="sentences"
            helper={`Up to ${SESSION_LOCATION_MAX} characters`}
            editable={!submitting}
          />
          <TextField
            label="Anything to add (optional)"
            value={note}
            onChangeText={setNote}
            placeholder="Bring last year's past questions"
            autoCapitalize="sentences"
            helper={`This is what the group reads on the timeline. Up to ${MESSAGE_MAX_LENGTH} characters.`}
            editable={!submitting}
          />
        </View>

        <Text style={styles.preview}>
          {startsAt
            ? sessionWhenLabel(startsAt, durationMin, openedAt)
            : 'Pick a date and time'}
        </Text>
        {!!(expired ?? problem) && (
          <Text style={styles.problem} accessibilityLiveRegion="polite">
            {expired ?? problem}
          </Text>
        )}
        {!isOnline && (
          <Text style={styles.hint}>
            You are offline, so this waits on the phone and reaches the group when
            you are back. If the time itself has passed by then, it cannot be sent.
          </Text>
        )}
        {!!error && (
          <Text style={styles.problem} accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}
      </ScrollView>

      <View style={styles.actions}>
        <Button
          label="Propose it"
          onPress={submit}
          loading={submitting}
          disabled={problem !== null || submitting}
          style={styles.action}
        />
        <Button
          label="Not now"
          variant="ghost"
          onPress={onCancel}
          disabled={submitting}
          style={styles.action}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    // Capped so the transcript is never fully covered — this is a sheet inside
    // the screen's footer, not a screen of its own.
    maxHeight: 460,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: fontSize.md, fontFamily: FONT.bold, color: colors.text },
  close: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  closeText: { fontSize: fontSize.md, color: colors.textMuted },
  scroll: { flexGrow: 0 },
  label: {
    fontSize: fontSize.sm,
    fontFamily: FONT.semi,
    color: colors.text,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  chipRow: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.xs },
  chip: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipPressed: { opacity: 0.8 },
  chipText: { fontSize: fontSize.sm, fontFamily: FONT.semi, color: colors.textMuted },
  chipTextActive: { color: colors.text },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  slot: {
    minHeight: MIN_TOUCH,
    minWidth: 72,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotPast: { backgroundColor: colors.surfaceAlt, borderColor: colors.surfaceAlt },
  slotPastText: { color: colors.borderStrong, textDecorationLine: 'line-through' },
  fields: { marginTop: spacing.lg },
  preview: { fontSize: fontSize.md, fontFamily: FONT.bold, color: colors.text },
  problem: { fontSize: fontSize.xs, color: colors.danger, marginTop: spacing.xs },
  hint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: spacing.xs,
    lineHeight: 16,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  action: { flex: 1 },
});
