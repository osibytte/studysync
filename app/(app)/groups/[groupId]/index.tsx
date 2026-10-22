import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { Initials, courseTag, initialsOf } from '@/components/Initials';
import { StatusPill } from '@/components/StatusPill';
import { TextField } from '@/components/TextField';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useGroupDetail } from '@/hooks/useGroupDetail';
import { useMyGroups } from '@/hooks/useMyGroups';
import { countSelected, decodeAvailability, describeSelection } from '@/lib/availability';
import {
  STATUS_HINT,
  canInvite,
  capacityLabel,
  displayName,
  isCreator,
  isLive,
  meetRuleLabel,
  memberLine,
  requiresEveryone,
  seatsLeft,
} from '@/lib/groupRules';
import {
  archiveGroup,
  leaveGroup,
  removeMember,
  renameGroup,
  respondJoinRequest,
  setGroupDiscoverable,
} from '@/lib/groups';
import { enqueue } from '@/lib/outbox';
import { refreshReminders } from '@/lib/reminders';
import { friendlyError } from '@/lib/supabase';
import { validateGroupName } from '@/lib/validation';
import { FONT, MIN_TOUCH, colors, fontSize, radius, spacing, shadowCard, typography } from '@/theme';

/**
 * One group: who is in it, when it can meet, who wants in, and what you can do
 * about any of it.
 *
 * Everything here except leaving is online-only. Approving a request or renaming
 * a group is a decision other people see immediately, and a queued approval could
 * hand out a seat that no longer exists. Leaving is the exception — it is entirely
 * about the student's own membership, cannot fail for a reason they could fix, and
 * is the one action they may urgently want while on a bad connection.
 */
export default function GroupDetailScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { profile } = useAuth();
  const { isOnline, refreshPending } = useNetwork();
  const router = useRouter();

  const userId = profile?.user_id ?? null;
  const {
    group,
    members,
    common,
    joinRequests,
    role,
    loading,
    error,
    reload,
  } = useGroupDetail(userId, groupId ?? null);
  const { groups, setLocal } = useMyGroups(userId);

  /** Key of the action in flight, so only the pressed button shows a spinner. */
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  /** Two-step confirmation, since this codebase uses no native alert dialogs. */
  const [confirm, setConfirm] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);

  // Refetch when returning from the invite screen — an invitation sent there does
  // not change this screen's data, but a request answered in between does.
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void reload();
    }, [reload])
  );

  /** Run an online-only action, then refetch. Keeps the six of them uniform. */
  async function run(key: string, action: () => Promise<unknown>, done?: string) {
    setFormError(null);
    setStatus(null);
    setBusy(key);
    try {
      await action();
      await reload();
      if (done) setStatus(done);
    } catch (err) {
      setFormError(friendlyError(err));
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  async function handleRename() {
    if (!groupId) return;
    const problem = validateGroupName(nameDraft);
    if (problem) {
      setNameError(problem);
      return;
    }
    setNameError(null);
    await run('rename', () => renameGroup(groupId, nameDraft.trim()), 'Renamed.');
    setRenaming(false);
  }

  /**
   * Leave, offline included.
   *
   * Mirrors create: drop the card locally, send it now if we can and queue it if
   * we cannot, and only surface an error if even queueing fails. The list is the
   * destination either way — this group's reads stop being permitted the moment
   * the membership row goes.
   */
  async function handleLeave() {
    if (!userId || !groupId) return;
    const dropLocally = () =>
      setLocal(groups.filter((g) => g.group_id !== groupId));

    const queueLeave = async () => {
      await enqueue('group.leave', { group_id: groupId }, userId);
      dropLocally();
      await refreshPending();
    };

    setFormError(null);
    setBusy('leave');
    try {
      if (isOnline) {
        await leaveGroup(groupId);
        dropLocally();
        // The group's study times are no longer this student's business, so the
        // alarms they placed have to go with the membership.
        void refreshReminders(userId);
      } else {
        await queueLeave();
      }
      router.replace('/(app)/groups');
    } catch (err) {
      try {
        await queueLeave();
        router.replace('/(app)/groups');
      } catch {
        setFormError(friendlyError(err));
      }
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  const commonGrid = decodeAvailability(common.common_mask);
  const commonCount = countSelected(commonGrid);
  const meetRule = meetRuleLabel(common.members_counted, common.meet_threshold);
  const everyoneNeeded = requiresEveryone(
    common.members_counted,
    common.meet_threshold
  );
  const memberCount = members.length > 0 ? members.length : 1;
  const creator = isCreator(role);
  const live = !!group && isLive(group.status);
  const showInvite =
    !!group && !!role && canInvite(role, group, memberCount) && isOnline;
  const actionsDisabled = !isOnline || busy !== null;

  if (loading && !group) {
    return (
      <Screen title="Group" onBack={() => router.back()}>
        <ActivityIndicator color={colors.primaryDark} style={styles.loader} />
      </Screen>
    );
  }

  if (!group) {
    return (
      <Screen
        title="Group unavailable"
        onBack={() => router.back()}
        footer={
          <Button label="Back to groups" onPress={() => router.replace('/(app)/groups')} />
        }
      >
        <Text style={styles.emptyText}>
          {error ??
            'This group could not be loaded. If you created it offline it will appear here once it syncs; if you have left it, it is no longer yours to open.'}
        </Text>
      </Screen>
    );
  }

  return (
    <Screen
      onBack={() => router.back()}
      footer={
        // Chat is the primary action, and the only one that works offline: it
        // is where the group actually happens — messages, and the study times
        // it proposes, answers and calls off.
        <Button
          label="Open chat"
          onPress={() => router.push(`/(app)/groups/${group.group_id}/chat`)}
          accessibilityHint="Messages, and the study times this group has proposed"
        />
      }
    >
      <View style={styles.identity}>
        <Initials
          text={courseTag(group.course?.course_code)}
          colorKey={group.group_id}
          size={84}
          ring
        />
        <Text style={styles.groupName} accessibilityRole="header">
          {group.group_name}
        </Text>
        <View style={styles.headerRow}>
          <Text style={styles.headerCourse}>{group.course?.course_code ?? '—'}</Text>
          <Text style={styles.capacity}>
            {' · '}
            {capacityLabel(memberCount, group.max_members)}
            {live && seatsLeft(memberCount, group.max_members) > 0
              ? ` · ${seatsLeft(memberCount, group.max_members)} free`
              : ''}
          </Text>
          <StatusPill status={group.status} />
        </View>
        {!!group.course?.course_title && (
          <Text style={styles.courseTitle}>{group.course.course_title}</Text>
        )}
        <Text style={styles.statusHint}>{STATUS_HINT[group.status]}</Text>
      </View>

      <View style={styles.quick}>
        <QuickTile
          icon="message-square"
          label="Chat"
          onPress={() => router.push(`/(app)/groups/${group.group_id}/chat`)}
        />
        <QuickTile
          icon="folder"
          label="Files"
          onPress={() => router.push(`/(app)/groups/${group.group_id}/files`)}
        />
        {showInvite && (
          <QuickTile
            icon="user-plus"
            label="Invite"
            hint="Search students on this course and invite one"
            onPress={() => router.push(`/(app)/groups/${group.group_id}/invite`)}
          />
        )}
      </View>

      {!isOnline && (
        <Text style={styles.note}>
          You are offline, so this is the last version fetched. Leaving still works;
          the rest waits for a connection.
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

      <Text style={styles.sectionHeader}>
        {everyoneNeeded ? 'When you can all meet' : 'When most of you can meet'}
      </Text>
      {common.members_counted === 0 ? (
        <Text style={styles.emptyText}>
          No availability on file for this course yet, so there is nothing to
          compare. Set yours in Courses and it appears here.
        </Text>
      ) : commonCount === 0 ? (
        <Text style={styles.emptyText}>
          No slot works {meetRule} yet. Anyone who has not filled in their
          availability is holding this back.
        </Text>
      ) : (
        <View style={styles.meetCard}>
          <Text style={styles.body}>{describeSelection(commonGrid, 6)}</Text>
          <Text style={styles.bodyMuted}>
            {commonCount} slot{commonCount === 1 ? '' : 's'} {meetRule}.
            {everyoneNeeded
              ? ''
              : ' Below four members every slot needs everyone; above it, a majority.'}
          </Text>
        </View>
      )}

      <Text style={styles.sectionHeader}>Members</Text>
      {members.length === 0 ? (
        <Text style={styles.emptyText}>Roster unavailable.</Text>
      ) : (
        members.map((member) => (
          <View key={member.user_id} style={styles.row}>
            <Initials
              text={initialsOf(member.full_name)}
              colorKey={member.user_id}
              size={44}
              shape="circle"
            />
            <View style={styles.rowText}>
              <Text style={styles.rowName}>
                {memberLine(member)}
                {member.user_id === userId ? ' · you' : ''}
              </Text>
              {!!member.department && (
                <Text style={styles.rowMeta}>{member.department}</Text>
              )}
            </View>
            {creator && member.user_id !== userId && (
              <View style={styles.rowActions}>
                {confirm === `remove:${member.user_id}` ? (
                  <>
                    <Button
                      label="Remove"
                      variant="danger"
                      fullWidth={false}
                      onPress={() =>
                        void run(
                          `remove:${member.user_id}`,
                          () => removeMember(group.group_id, member.user_id),
                          'Removed from the group.'
                        )
                      }
                      loading={busy === `remove:${member.user_id}`}
                      disabled={actionsDisabled}
                      style={styles.smallButton}
                    />
                    <Button
                      label="Keep"
                      variant="ghost"
                      fullWidth={false}
                      onPress={() => setConfirm(null)}
                      style={styles.smallButton}
                    />
                  </>
                ) : (
                  <Button
                    label="Remove"
                    variant="ghost"
                    fullWidth={false}
                    onPress={() => setConfirm(`remove:${member.user_id}`)}
                    disabled={actionsDisabled}
                    style={styles.smallButton}
                    accessibilityHint={`Remove ${memberLine(member)} from this group`}
                  />
                )}
              </View>
            )}
          </View>
        ))
      )}

      {/*
        The files the group has shared. A link rather than a list: rendering it
        here would mean a second RPC on the screen every group is opened from,
        and the tab it leads to is the thing that can afford one.
      */}
      <Text style={styles.sectionHeader}>Shared files</Text>
      <Pressable
        onPress={() => router.push(`/(app)/groups/${group.group_id}/files`)}
        style={styles.linkRow}
        accessibilityRole="button"
        accessibilityLabel="Shared files"
        accessibilityHint="Notes, slides and past papers shared in this group"
      >
        <Text style={styles.linkRowText}>
          Notes, slides and past papers, newest first
        </Text>
        <Text style={styles.linkRowAction}>Open</Text>
      </Pressable>

      {joinRequests.length > 0 && (
        <>
          <Text style={styles.sectionHeader}>
            Asking to join ({joinRequests.length})
          </Text>
          {!creator && (
            <Text style={styles.bodyMuted}>
              Only the group&apos;s creator can answer these.
            </Text>
          )}
          {joinRequests.map((request) => (
            <View key={request.request_id} style={styles.requestCard}>
              <Text style={styles.rowName}>{displayName(request.full_name)}</Text>
              {!!request.department && (
                <Text style={styles.rowMeta}>{request.department}</Text>
              )}
              {creator && (
                <View style={styles.requestActions}>
                  <Button
                    label="Approve"
                    fullWidth={false}
                    onPress={() =>
                      void run(
                        `approve:${request.request_id}`,
                        () => respondJoinRequest(request.request_id, true),
                        'Approved — they are in the group.'
                      )
                    }
                    loading={busy === `approve:${request.request_id}`}
                    disabled={actionsDisabled}
                    style={styles.smallButton}
                  />
                  <Button
                    label="Decline"
                    variant="ghost"
                    fullWidth={false}
                    onPress={() =>
                      void run(
                        `decline:${request.request_id}`,
                        () => respondJoinRequest(request.request_id, false),
                        'Declined.'
                      )
                    }
                    loading={busy === `decline:${request.request_id}`}
                    disabled={actionsDisabled}
                    style={styles.smallButton}
                  />
                </View>
              )}
            </View>
          ))}
        </>
      )}

      {creator && live && (
        <>
          <Text style={styles.sectionHeader}>Manage</Text>

          {renaming ? (
            <View>
              <TextField
                label="Group name"
                value={nameDraft}
                onChangeText={setNameDraft}
                error={nameError}
                helper="Up to 80 characters."
                autoCapitalize="words"
                editable={busy !== 'rename'}
              />
              <Button
                label="Save name"
                onPress={() => void handleRename()}
                loading={busy === 'rename'}
                disabled={actionsDisabled}
              />
              <Button
                label="Cancel"
                variant="ghost"
                onPress={() => {
                  setRenaming(false);
                  setNameError(null);
                }}
                style={styles.spaced}
              />
            </View>
          ) : (
            <Button
              label="Rename group"
              variant="secondary"
              onPress={() => {
                setNameDraft(group.group_name);
                setRenaming(true);
              }}
              disabled={actionsDisabled}
            />
          )}

          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <Text style={styles.rowName}>Show on browse</Text>
              <Text style={styles.rowMeta}>
                {group.is_discoverable
                  ? 'Students on this course can find the group and ask to join.'
                  : 'Invite-only — the group is hidden from browse and matching.'}
              </Text>
            </View>
            <Switch
              value={group.is_discoverable}
              onValueChange={(next) =>
                void run('discoverable', () =>
                  setGroupDiscoverable(group.group_id, next)
                )
              }
              disabled={actionsDisabled}
              trackColor={{ true: colors.primary, false: colors.borderStrong }}
              accessibilityLabel="Show this group on browse"
            />
          </View>

          {confirm === 'archive' ? (
            <View style={styles.confirmCard}>
              <Text style={styles.confirmText}>
                Archiving closes the group to new members and removes it from browse
                and matching. Members keep access to it, and it cannot be reopened
                from the app.
              </Text>
              <Button
                label="Yes, archive it"
                variant="danger"
                onPress={() =>
                  void run('archive', () => archiveGroup(group.group_id), 'Archived.')
                }
                loading={busy === 'archive'}
                disabled={actionsDisabled}
              />
              <Button
                label="Cancel"
                variant="ghost"
                onPress={() => setConfirm(null)}
                style={styles.spaced}
              />
            </View>
          ) : (
            <Button
              label="Archive group"
              variant="secondary"
              onPress={() => setConfirm('archive')}
              disabled={actionsDisabled}
              style={styles.spaced}
            />
          )}
        </>
      )}

      <Text style={styles.sectionHeader}>Leave</Text>
      {confirm === 'leave' ? (
        <View style={styles.confirmCard}>
          <Text style={styles.confirmText}>
            {creator && members.length > 1
              ? 'You created this group. Leaving hands the creator role to the longest-standing member and cannot be undone from here.'
              : members.length <= 1
                ? 'You are the only member, so leaving closes the group.'
                : 'You will need a new invitation or an approved request to come back.'}
          </Text>
          <Button
            label="Yes, leave the group"
            variant="danger"
            onPress={() => void handleLeave()}
            loading={busy === 'leave'}
            disabled={busy !== null}
          />
          <Button
            label="Stay"
            variant="ghost"
            onPress={() => setConfirm(null)}
            style={styles.spaced}
          />
        </View>
      ) : (
        <Button
          label="Leave group"
          variant="secondary"
          onPress={() => setConfirm('leave')}
          disabled={busy !== null}
        />
      )}
    </Screen>
  );
}

/** One of the three square shortcuts under the group's name. */
function QuickTile({
  icon,
  label,
  hint,
  onPress,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  hint?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      style={({ pressed }) => [styles.quickTile, pressed && styles.quickPressed]}
    >
      <Feather name={icon} size={20} color={colors.text} />
      <Text style={styles.quickLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  loader: { marginVertical: spacing.xl },
  identity: { alignItems: 'center', paddingTop: spacing.sm },
  groupName: {
    ...typography.title,
    fontFamily: FONT.extra,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginTop: spacing.sm,
    gap: 4,
  },
  headerCourse: { fontSize: fontSize.sm, fontFamily: FONT.semi, color: colors.textSecondary },
  statusHint: {
    fontSize: fontSize.xs,
    fontFamily: FONT.regular,
    color: colors.textMuted,
    marginTop: spacing.sm,
    lineHeight: 18,
    textAlign: 'center',
  },
  courseTitle: {
    fontSize: fontSize.sm,
    fontFamily: FONT.regular,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    textAlign: 'center',
  },
  capacity: { fontSize: fontSize.sm, fontFamily: FONT.regular, color: colors.textMuted, marginRight: spacing.xs },
  quick: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl - 4 },
  quickTile: {
    flex: 1,
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md + 2,
    borderRadius: radius.lg - 2,
    backgroundColor: colors.surface,
    ...shadowCard,
  },
  quickPressed: { opacity: 0.8 },
  quickLabel: { fontSize: fontSize.sm - 1, fontFamily: FONT.semi, color: colors.text },
  meetCard: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.primarySoft,
  },
  note: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
    marginTop: spacing.md,
  },
  sectionHeader: {
    ...typography.section,
    marginTop: spacing.xl + 2,
    marginBottom: spacing.md,
    paddingHorizontal: 2,
  },
  body: { fontSize: fontSize.md, fontFamily: FONT.semi, color: colors.primaryDark, lineHeight: 22 },
  bodyMuted: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: spacing.xs,
    lineHeight: 18,
  },
  emptyText: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 20 },
  // Each member is a card of their own, like the people in the reference.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 72,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
    ...shadowCard,
  },
  rowText: { flex: 1, paddingRight: spacing.sm },
  rowName: { fontSize: fontSize.md, fontFamily: FONT.bold, color: colors.text },
  rowMeta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, lineHeight: 18 },
  rowActions: { flexDirection: 'row', alignItems: 'center' },
  smallButton: { paddingHorizontal: spacing.md, marginLeft: spacing.xs },
  requestCard: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    ...shadowCard,
  },
  requestActions: { flexDirection: 'row', marginTop: spacing.sm },
  /**
   * A destination, not an action, so it is a row with an "Open" affordance
   * rather than a button — shaped like the invitation banner on the groups list
   * for the same reason: both are "there is more of this through here".
   */
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 60,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    ...shadowCard,
  },
  linkRowText: { flex: 1, fontSize: fontSize.sm, color: colors.text, paddingRight: spacing.sm },
  linkRowAction: { fontSize: fontSize.sm, fontFamily: FONT.bold, color: colors.primaryDark },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    ...shadowCard,
  },
  switchText: { flex: 1, paddingRight: spacing.md },
  confirmCard: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    ...shadowCard,
    marginTop: spacing.sm,
  },
  confirmText: {
    fontSize: fontSize.sm,
    color: colors.text,
    lineHeight: 20,
    marginBottom: spacing.md,
  },
  spaced: { marginTop: spacing.sm },
  footerRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  footerRowButton: { flex: 1 },
  formError: { color: colors.danger, fontSize: fontSize.sm, marginTop: spacing.md, lineHeight: 20 },
  status: { color: colors.success, fontSize: fontSize.sm, marginTop: spacing.md },
});
