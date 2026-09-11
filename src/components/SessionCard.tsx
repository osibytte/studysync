import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from './Button';
import {
  SESSION_RESPONSE_LABEL,
  SESSION_STATUS_LABEL,
  canRespondToSession,
  formatDuration,
  sessionRuleLabel,
  sessionTallyLabel,
  sessionWhenLabel,
  waitingOnLabel,
  yesStillNeeded,
} from '@/lib/chatRules';
import { FONT, MIN_TOUCH, colors, fontSize, radius, spacing } from '@/theme';
import type {
  GroupSessionRow,
  SessionAttendeeRow,
  SessionResponseValue,
} from '@/types/database';

/**
 * A proposed study time, on the timeline where it was proposed.
 *
 * There is deliberately no sessions screen: a study time is something a group
 * agrees to in conversation, so the card that carries it lives in the
 * conversation. Proposing, answering, seeing who is missing and calling it off
 * all happen here.
 *
 * EVERY NUMBER ON THIS CARD COMES FROM THE ROW. `confirm_threshold` and
 * `members_counted` are computed server-side against members enrolled in the
 * group's COURSE, which is smaller than the roster once somebody drops it — a
 * card that counted the members it can see would name a rule the confirmation
 * trigger is not applying. Same for the tally: the trigger flips `proposed` to
 * `confirmed` on its own, and this renders the result rather than predicting it.
 */

interface Props {
  session: GroupSessionRow;
  /** The RPC joins this in; the roster is the fallback when it came back null. */
  proposerName: string;
  /** From `canCancelSession` — the proposer or the group's creator. */
  canCancel: boolean;
  /** Offline. Answering queues, so this is false there; cancelling does not. */
  respondDisabled: boolean;
  /** Offline, always: `session.cancel` is deliberately not a queued action. */
  cancelDisabled: boolean;
  /** `yes` | `no` | `maybe` | `cancel`, so only the pressed control spins. */
  busy: string | null;
  /**
   * An answer sitting in the outbox. The tally cannot know about it — the row is
   * not replicated and nothing has refetched it — so it is shown separately
   * rather than folded into the counts, which would be this client inventing
   * server state.
   */
  queuedResponse?: SessionResponseValue | null;
  attendeesOpen: boolean;
  attendees: SessionAttendeeRow[];
  attendeesLoading: boolean;
  onToggleAttendees: () => void;
  onRespond: (response: SessionResponseValue) => void;
  onCancel: () => void;
  now?: Date;
}

const RESPONSES: SessionResponseValue[] = ['yes', 'no', 'maybe'];

export function SessionCard({
  session,
  proposerName,
  canCancel,
  respondDisabled,
  cancelDisabled,
  busy,
  queuedResponse = null,
  attendeesOpen,
  attendees,
  attendeesLoading,
  onToggleAttendees,
  onRespond,
  onCancel,
  now,
}: Props) {
  const [confirmCancel, setConfirmCancel] = useState(false);

  const openable = canRespondToSession(session, now);
  const stillNeeded = yesStillNeeded(session);
  const waiting = waitingOnLabel(attendees);
  /** The queued answer wins the highlight: it is what the student last chose. */
  const chosen = queuedResponse ?? session.my_response;

  return (
    <View
      style={[
        styles.card,
        session.status === 'confirmed' && styles.cardConfirmed,
        session.status === 'cancelled' && styles.cardCancelled,
      ]}
    >
      <View style={styles.headerRow}>
        <Text style={styles.eyebrow}>Study time</Text>
        <Text
          style={[
            styles.status,
            session.status === 'confirmed' && styles.statusConfirmed,
            session.status === 'cancelled' && styles.statusCancelled,
          ]}
        >
          {SESSION_STATUS_LABEL[session.status]}
        </Text>
      </View>

      <Text style={styles.when}>
        {sessionWhenLabel(session.starts_at, session.duration_min, now)}
      </Text>
      <Text style={styles.detail}>
        {formatDuration(session.duration_min)}
        {session.location ? ` · ${session.location}` : ''}
      </Text>
      <Text style={styles.detail}>Proposed by {proposerName}</Text>

      <Text style={styles.tally}>
        {sessionTallyLabel(session)} · {sessionRuleLabel(session.members_counted, session.confirm_threshold)}
      </Text>
      {session.status === 'proposed' && stillNeeded > 0 && (
        <Text style={styles.detail}>
          {stillNeeded} more yes {stillNeeded === 1 ? 'confirms' : 'confirm'} it.
        </Text>
      )}

      {openable ? (
        <View style={styles.answerRow}>
          {RESPONSES.map((response) => {
            const active = chosen === response;
            const spinning = busy === response;
            return (
              <Pressable
                key={response}
                onPress={() => onRespond(response)}
                disabled={respondDisabled || busy !== null}
                accessibilityRole="button"
                accessibilityLabel={SESSION_RESPONSE_LABEL[response]}
                accessibilityState={{ selected: active, busy: spinning }}
                style={({ pressed }) => [
                  styles.answer,
                  active && styles.answerActive,
                  (respondDisabled || busy !== null) && styles.answerDisabled,
                  pressed && styles.answerPressed,
                ]}
              >
                {spinning ? (
                  <ActivityIndicator size="small" color={colors.primaryDark} />
                ) : (
                  <Text style={[styles.answerText, active && styles.answerTextActive]}>
                    {SESSION_RESPONSE_LABEL[response]}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      ) : (
        <Text style={styles.note}>
          {session.status === 'cancelled'
            ? 'This one was called off, so there is nothing to answer.'
            : 'This one has been and gone.'}
        </Text>
      )}

      {!!queuedResponse && (
        <Text style={styles.queued}>
          Saved as “{SESSION_RESPONSE_LABEL[queuedResponse]}” — it reaches the group
          when you are back online, and the tally updates then.
        </Text>
      )}

      <Pressable
        onPress={onToggleAttendees}
        accessibilityRole="button"
        accessibilityState={{ expanded: attendeesOpen }}
        style={styles.disclosure}
      >
        <Text style={styles.disclosureText}>
          {attendeesOpen ? 'Hide who is coming' : 'Who is coming'}
        </Text>
      </Pressable>

      {attendeesOpen && (
        <View style={styles.attendees}>
          {attendeesLoading && attendees.length === 0 ? (
            <ActivityIndicator size="small" color={colors.primaryDark} />
          ) : attendees.length === 0 ? (
            <Text style={styles.note}>
              Nobody could be looked up just now. This list needs a connection.
            </Text>
          ) : (
            <>
              {attendees.map((attendee) => (
                <View key={attendee.user_id} style={styles.attendeeRow}>
                  <Text style={styles.attendeeName} numberOfLines={1}>
                    {(attendee.full_name ?? '').trim() || 'Unnamed student'}
                    {attendee.is_proposer ? ' · proposed it' : ''}
                  </Text>
                  <Text
                    style={[
                      styles.attendeeAnswer,
                      attendee.response === 'yes' && styles.answerYes,
                      attendee.response === 'no' && styles.answerNo,
                    ]}
                  >
                    {attendee.response
                      ? SESSION_RESPONSE_LABEL[attendee.response]
                      : 'No answer yet'}
                  </Text>
                </View>
              ))}
              {!!waiting && <Text style={styles.waiting}>{waiting}</Text>}
            </>
          )}
        </View>
      )}

      {/*
        Cancelling is gated on `openable` as well as `canCancel`. `cancel_session`
        would accept a session that has already run — it only checks who is asking
        and that the row is not already cancelled — but there is nothing left to
        call off, so offering it would be a control that changes a label and
        nothing else.
      */}
      {canCancel && openable && (
        confirmCancel ? (
          <View style={styles.cancelConfirm}>
            <Text style={styles.cancelConfirmText}>
              Call this off? Everybody's answers stay on the row, so the timeline
              keeps its shape — but the study time is off for the whole group, and
              reviving it means proposing it again.
            </Text>
            <View style={styles.cancelRow}>
              <Button
                label="Call it off"
                variant="danger"
                fullWidth={false}
                onPress={onCancel}
                loading={busy === 'cancel'}
                disabled={cancelDisabled || busy !== null}
                style={styles.cancelButton}
              />
              <Button
                label="Keep it"
                variant="ghost"
                fullWidth={false}
                onPress={() => setConfirmCancel(false)}
                disabled={busy !== null}
                style={styles.cancelButton}
              />
            </View>
          </View>
        ) : (
          <View style={styles.cancelTrigger}>
            <Button
              label="Call it off"
              variant="ghost"
              fullWidth={false}
              onPress={() => setConfirmCancel(true)}
              disabled={cancelDisabled || busy !== null}
              style={styles.cancelButton}
            />
            {cancelDisabled && (
              <Text style={styles.note}>
                Calling it off needs a connection — it is not something to land an
                hour late.
              </Text>
            )}
          </View>
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cardConfirmed: { borderColor: colors.success, backgroundColor: colors.background },
  cardCancelled: { backgroundColor: colors.surfaceAlt },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  eyebrow: {
    fontSize: fontSize.xs,
    fontFamily: FONT.bold,
    color: colors.textMuted,
    letterSpacing: 0.5,
  },
  status: { fontSize: fontSize.xs, fontFamily: FONT.bold, color: colors.warning },
  statusConfirmed: { color: colors.success },
  statusCancelled: { color: colors.textMuted },

  when: {
    fontSize: fontSize.md,
    fontFamily: FONT.bold,
    color: colors.text,
    marginTop: spacing.sm,
  },
  detail: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2 },
  tally: {
    fontSize: fontSize.sm,
    fontFamily: FONT.semi,
    color: colors.text,
    marginTop: spacing.sm,
  },
  answerRow: { flexDirection: 'row', marginTop: spacing.md, gap: spacing.sm },
  answer: {
    flex: 1,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  answerActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  answerDisabled: { opacity: 0.5 },
  answerPressed: { opacity: 0.7 },
  answerText: { fontSize: fontSize.sm, fontFamily: FONT.semi, color: colors.textMuted },
  answerTextActive: { color: colors.text },

  note: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: spacing.sm,
    lineHeight: 18,
  },
  queued: {
    fontSize: fontSize.xs,
    color: colors.warning,
    marginTop: spacing.sm,
    lineHeight: 18,
  },
  disclosure: {
    minHeight: MIN_TOUCH,
    justifyContent: 'center',
    marginTop: spacing.xs,
  },
  disclosureText: {
    fontSize: fontSize.sm,
    fontFamily: FONT.semi,
    color: colors.primaryDark,
  },
  attendees: {
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  attendeeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
    gap: spacing.sm,
  },
  attendeeName: { flex: 1, fontSize: fontSize.sm, color: colors.text },
  attendeeAnswer: { fontSize: fontSize.xs, fontFamily: FONT.semi, color: colors.textMuted },
  answerYes: { color: colors.success },
  answerNo: { color: colors.danger },
  waiting: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: spacing.xs,
    fontStyle: 'italic',
  },

  cancelTrigger: { marginTop: spacing.sm, alignItems: 'flex-start' },
  cancelConfirm: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelConfirmText: { fontSize: fontSize.xs, color: colors.text, lineHeight: 18 },
  cancelRow: { flexDirection: 'row', marginTop: spacing.sm, gap: spacing.sm },
  cancelButton: { paddingHorizontal: spacing.md },
});
