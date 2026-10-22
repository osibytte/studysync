import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { TextField } from '@/components/TextField';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useGroupDetail } from '@/hooks/useGroupDetail';
import { canInvite, capacityLabel, displayName, isFull, isLive } from '@/lib/groupRules';
import { searchStudents, sendInvitation } from '@/lib/groups';
import { friendlyError } from '@/lib/supabase';
import { FONT, colors, fontSize, radius, spacing } from '@/theme';
import type { StudentSearchRow } from '@/types/database';

/**
 * Invite a student into this group.
 *
 * The candidate list comes from the `search_students` RPC, not a client-side
 * filter: RLS on `public.users` is own-row only, so there is no local list of
 * students to filter. That function also does the excluding — the caller, current
 * members, and anyone not enrolled in this course — so a name shown here is always
 * a name that can actually be invited.
 *
 * An empty query is meaningful (the first 20 students on the course, by name), so
 * the screen opens with something to act on rather than a blank box.
 *
 * Only `groupId` is in the URL. The course, the caller's role and the member count
 * all come from the same detail read the group screen uses, which keeps the two
 * screens' idea of "can I invite?" identical.
 */
export default function InviteScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { profile } = useAuth();
  const { isOnline } = useNetwork();
  const router = useRouter();

  const userId = profile?.user_id ?? null;
  const { group, members, role, loading: detailLoading } = useGroupDetail(
    userId,
    groupId ?? null
  );

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StudentSearchRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [invited, setInvited] = useState<Set<string>>(new Set());

  const courseId = group?.course_id ?? null;
  const memberCount = members.length > 0 ? members.length : 1;
  const allowed =
    !!group && !!role && canInvite(role, group, memberCount) && isOnline;

  const search = useCallback(
    async (text: string) => {
      if (!courseId || !groupId || !isOnline) return;
      setFormError(null);
      setSearching(true);
      try {
        setResults(await searchStudents(text.trim(), courseId, groupId));
        setSearched(true);
      } catch (err) {
        setFormError(friendlyError(err));
      } finally {
        setSearching(false);
      }
    },
    [courseId, groupId, isOnline]
  );

  // First load: the whole (capped) course list, so the screen is never a dead end
  // for someone who does not know exactly who they are looking for.
  useEffect(() => {
    if (courseId && !searched) void search('');
  }, [courseId, searched, search]);

  async function handleInvite(student: StudentSearchRow) {
    if (!groupId) return;
    setFormError(null);
    setStatus(null);
    setBusyId(student.user_id);
    try {
      await sendInvitation(groupId, student.user_id);
      setInvited((current) => new Set(current).add(student.user_id));
      setStatus(
        `Invited ${displayName(student.full_name)}. They decide whether to join.`
      );
    } catch (err) {
      setFormError(friendlyError(err));
    } finally {
      setBusyId(null);
    }
  }

  /** Why the invite buttons are hidden, in the group's own terms. */
  function blockedReason(): string {
    if (!isOnline) {
      return 'You are offline. An invitation has to reach the other student, so this needs a connection.';
    }
    if (!group) return 'This group could not be loaded.';
    if (!isLive(group.status)) {
      return 'This group is closed, so it is not taking new members.';
    }
    if (isFull(memberCount, group.max_members)) {
      return `This group is full — ${capacityLabel(
        memberCount,
        group.max_members
      )}. Someone would have to leave first.`;
    }
    if (!role) return 'You are not a member of this group.';
    return 'Only the creator can invite people into a group that is not shown on browse.';
  }

  return (
    <Screen
      title="Invite someone"
      subtitle={group ? `To ${group.group_name}` : undefined}
      onBack={() => router.back()}
    >
      {detailLoading && !group ? (
        <ActivityIndicator color={colors.primaryDark} style={styles.loader} />
      ) : !allowed ? (
        <Text style={styles.emptyText}>{blockedReason()}</Text>
      ) : (
        <>
          <TextField
            label="Search by name"
            value={query}
            onChangeText={setQuery}
            placeholder="Leave blank to see everyone on the course"
            autoCapitalize="words"
            returnKeyType="search"
            onSubmitEditing={() => void search(query)}
            editable={!searching}
            helper="Only students enrolled in this course, and not already in the group."
          />
          <Button
            label="Search"
            variant="secondary"
            onPress={() => void search(query)}
            loading={searching}
            disabled={searching}
          />

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

          {searching && results.length === 0 ? (
            <ActivityIndicator color={colors.primaryDark} style={styles.loader} />
          ) : results.length === 0 ? (
            <Text style={styles.emptyText}>
              {searched
                ? 'Nobody on this course matches that name — and anyone already in the group is left out of these results.'
                : 'No students to show yet.'}
            </Text>
          ) : (
            results.map((student) => {
              const done = invited.has(student.user_id);
              return (
                <View key={student.user_id} style={styles.row}>
                  <View style={styles.rowText}>
                    <Text style={styles.rowName}>{displayName(student.full_name)}</Text>
                    {!!student.department && (
                      <Text style={styles.rowMeta}>{student.department}</Text>
                    )}
                  </View>
                  <Button
                    label={done ? 'Invited' : 'Invite'}
                    variant={done ? 'ghost' : 'primary'}
                    fullWidth={false}
                    onPress={() => void handleInvite(student)}
                    disabled={done || busyId !== null}
                    loading={busyId === student.user_id}
                    style={styles.rowButton}
                    accessibilityHint={
                      done
                        ? 'Already invited'
                        : `Invite ${displayName(student.full_name)} to this group`
                    }
                  />
                </View>
              );
            })
          )}

          {results.length === 20 && (
            <Text style={styles.note}>
              Showing the first 20 matches. Narrow the search if the person you want
              is not here.
            </Text>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loader: { marginVertical: spacing.xl },
  emptyText: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 20 },
  note: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
    marginTop: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowText: { flex: 1, paddingRight: spacing.sm },
  rowName: { fontSize: fontSize.sm, fontFamily: FONT.semi, color: colors.text },
  rowMeta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  rowButton: { paddingHorizontal: spacing.lg, borderRadius: radius.md },
  formError: { color: colors.danger, fontSize: fontSize.sm, marginTop: spacing.md, lineHeight: 20 },
  status: { color: colors.success, fontSize: fontSize.sm, marginTop: spacing.md, lineHeight: 20 },
});
