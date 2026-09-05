import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { StatusPill } from '@/components/StatusPill';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useInvitations } from '@/hooks/useInvitations';
import { capacityLabel, displayName, isFull, isLive } from '@/lib/groupRules';
import { respondInvitation } from '@/lib/groups';
import { friendlyError } from '@/lib/supabase';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { InvitationDetailRow } from '@/types/database';

/**
 * Your invitation inbox.
 *
 * Rows come from the `my_invitations` read (0010) rather than a select on
 * `invitations`, because the group behind an invite is often unreadable to the
 * person being invited — a non-discoverable group is invisible to non-members, so
 * a plain select would render a nameless card.
 *
 * Responding needs a connection. Accepting adds you to a roster with a fixed
 * number of seats, and queueing that offline could hand out a seat that is gone
 * by the time the queue drains. The inbox itself is cached, so you can still read
 * what is waiting.
 */
export default function InvitationsScreen() {
  const { profile } = useAuth();
  const { isOnline } = useNetwork();
  const router = useRouter();

  const userId = profile?.user_id ?? null;
  const { invitations, loading, error, reload, removeLocal } = useInvitations(userId);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function handleRespond(invite: InvitationDetailRow, accept: boolean) {
    setFormError(null);
    setStatus(null);
    setBusyId(invite.invitation_id);
    try {
      await respondInvitation(invite.invitation_id, accept);
      removeLocal(invite.invitation_id);
      if (accept) {
        // You are a member as of now, so go straight to the group.
        router.replace(`/(app)/groups/${invite.group_id}`);
        return;
      }
      setStatus(`Declined the invitation to ${invite.group_name}.`);
    } catch (err) {
      setFormError(friendlyError(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Screen
      title="Invitations"
      subtitle="Groups that have asked you to join them."
      footer={<Button label="Back" variant="secondary" onPress={() => router.back()} />}
    >
      {!isOnline && (
        <Text style={styles.note}>
          You are offline. You can read your invitations, but answering one has to
          wait until you reconnect — a seat in a group is not something to promise
          from a queue.
        </Text>
      )}
      {!!formError && (
        <Text style={styles.formError} accessibilityLiveRegion="polite">
          {formError}
        </Text>
      )}
      {!!status && (
        <Text style={styles.status} accessibilityLiveRegion="polite">
          {status}
        </Text>
      )}

      {loading && invitations.length === 0 ? (
        <ActivityIndicator color={colors.primary} style={styles.loader} />
      ) : error && invitations.length === 0 ? (
        <Text style={styles.errorText}>{error}</Text>
      ) : invitations.length === 0 ? (
        <Text style={styles.emptyText}>
          Nothing waiting. Invitations show up here when someone asks you into their
          group.
        </Text>
      ) : (
        invitations.map((invite) => {
          const full = isFull(invite.member_count, invite.max_members);
          const closed = !isLive(invite.group_status);
          const canAccept = isOnline && !full && !closed && busyId === null;
          return (
            <View key={invite.invitation_id} style={styles.card}>
              <View style={styles.cardTop}>
                <Text style={styles.cardName} numberOfLines={1}>
                  {invite.group_name}
                </Text>
                <StatusPill status={invite.group_status} />
              </View>
              <Text style={styles.cardCourse}>
                {invite.course_code}
                {invite.course_title ? ` · ${invite.course_title}` : ''}
              </Text>
              <Text style={styles.cardMeta}>
                From {displayName(invite.inviter_name)} ·{' '}
                {capacityLabel(invite.member_count, invite.max_members)}
              </Text>
              {(full || closed) && (
                <Text style={styles.cardWarn}>
                  {closed
                    ? 'This group has since closed, so the invitation can only be declined.'
                    : 'This group filled up after the invitation was sent.'}
                </Text>
              )}
              <Button
                label={full ? 'Group is full' : 'Accept'}
                onPress={() => void handleRespond(invite, true)}
                disabled={!canAccept}
                loading={busyId === invite.invitation_id}
                style={styles.cardButton}
              />
              <Button
                label="Decline"
                variant="ghost"
                onPress={() => void handleRespond(invite, false)}
                disabled={!isOnline || busyId !== null}
                style={styles.declineButton}
              />
            </View>
          );
        })
      )}

      <Button
        label="Refresh"
        variant="ghost"
        onPress={() => void reload()}
        style={styles.refresh}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  loader: { marginVertical: spacing.xl },
  note: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
    marginBottom: spacing.sm,
  },
  errorText: { fontSize: fontSize.sm, color: colors.danger, marginTop: spacing.md },
  emptyText: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    lineHeight: 20,
    marginTop: spacing.md,
  },
  card: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardName: {
    flex: 1,
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
    paddingRight: spacing.sm,
  },
  cardCourse: { fontSize: fontSize.sm, color: colors.primary, marginTop: spacing.xs },
  cardMeta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  cardWarn: {
    fontSize: fontSize.xs,
    color: colors.warning,
    marginTop: spacing.xs,
    lineHeight: 18,
  },
  cardButton: { marginTop: spacing.md },
  declineButton: { marginTop: spacing.xs },
  formError: { color: colors.danger, fontSize: fontSize.sm, marginBottom: spacing.sm },
  status: { color: colors.success, fontSize: fontSize.sm, marginBottom: spacing.sm },
  refresh: { marginTop: spacing.lg },
});
