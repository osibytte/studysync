import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Button } from '@/components/Button';
import { CourseChips } from '@/components/CourseChips';
import { Screen } from '@/components/Screen';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useUserCourses } from '@/hooks/useUserCourses';
import {
  canRequestToJoin,
  capacityLabel,
  defaultGroupName,
  displayName,
  scorePercent,
} from '@/lib/groupRules';
import { createGroup, findGroup, requestToJoin, sendInvitation } from '@/lib/groups';
import { makeActionId } from '@/lib/ids';
import { friendlyError } from '@/lib/supabase';
import { FONT, colors, fontSize, radius, spacing } from '@/theme';
import type { GroupStatus } from '@/types/database';
import type { FindGroupResponse, ScoredGroup, ScoredStudent } from '@/types/matching';

/**
 * Pathway One — ask matching for suggestions on one course.
 *
 * Two kinds of answer, in the order the spec ranks them: existing groups worth
 * asking to join, then lone students to start a new group with. Both come from
 * the `find-group` Edge Function, which is where matching has to live: scoring
 * reads other students' availability, and RLS hides that from the client.
 *
 * Online-only and on demand. There is nothing to cache usefully — a ranking is
 * stale as soon as anyone else joins a group — and each run is a function
 * invocation, so it happens when the student asks for it rather than on every
 * chip tap.
 */
export default function MatchScreen() {
  const { profile } = useAuth();
  const { isOnline } = useNetwork();
  const router = useRouter();

  const userId = profile?.user_id ?? null;
  const { userCourses, loading: coursesLoading } = useUserCourses(userId);

  const [courseId, setCourseId] = useState<string | null>(null);
  const [result, setResult] = useState<FindGroupResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Groups asked to join, and partners invited, this session. */
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const [invited, setInvited] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!courseId && userCourses.length > 0) setCourseId(userCourses[0].course_id);
  }, [courseId, userCourses]);

  const selected = useMemo(
    () => userCourses.find((uc) => uc.course_id === courseId) ?? null,
    [userCourses, courseId]
  );

  // A ranking belongs to one course, so switching courses clears it rather than
  // leaving the previous course's suggestions under the new chip.
  useEffect(() => {
    setResult(null);
    setError(null);
    setStatus(null);
  }, [courseId]);

  async function handleFind() {
    if (!courseId) return;
    setError(null);
    setStatus(null);
    setSearching(true);
    try {
      setResult(await findGroup(courseId));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setSearching(false);
    }
  }

  async function handleAsk(group: ScoredGroup) {
    setError(null);
    setStatus(null);
    setBusyId(group.group_id);
    try {
      await requestToJoin(group.group_id);
      setRequested((current) => new Set(current).add(group.group_id));
      setStatus(`Asked to join ${group.group_name}.`);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Start a group with a suggested partner: create it, then invite them.
   *
   * Two calls, and the second can fail on its own. If it does the group still
   * exists — so say exactly that and leave them here with the group made, rather
   * than pretending nothing happened or silently dropping the invitation.
   */
  async function handleStartWith(partner: ScoredStudent) {
    if (!courseId) return;
    setError(null);
    setStatus(null);
    setBusyId(partner.user_id);
    const groupId = makeActionId();
    try {
      await createGroup({
        groupId,
        groupName: defaultGroupName(selected?.course?.course_code),
        courseId,
        isDiscoverable: true,
      });
      try {
        await sendInvitation(groupId, partner.user_id);
      } catch (inviteError) {
        setInvited((current) => new Set(current).add(partner.user_id));
        setError(
          `Group created, but the invitation to ${displayName(
            partner.full_name
          )} did not send: ${friendlyError(inviteError)} You can invite them from the group.`
        );
        return;
      }
      setInvited((current) => new Set(current).add(partner.user_id));
      router.push(`/(app)/groups/${groupId}`);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusyId(null);
    }
  }

  const noSlots = !!result && result.requester.slot_count === 0;

  return (
    <Screen
      title="Suggested for you"
      subtitle="Ranked by how much of your week lines up with theirs."
      footer={<Button label="Back" variant="secondary" onPress={() => router.back()} />}
    >
      {coursesLoading && userCourses.length === 0 ? (
        <ActivityIndicator color={colors.primaryDark} style={styles.loader} />
      ) : userCourses.length === 0 ? (
        <View>
          <Text style={styles.emptyText}>
            Matching works per course, and you are not enrolled in any yet.
          </Text>
          <Pressable
            onPress={() => router.push('/(app)/courses')}
            accessibilityRole="button"
            accessibilityLabel="Add courses"
          >
            <Text style={styles.link}>Add courses</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <CourseChips
            courses={userCourses}
            selectedCourseId={courseId}
            onSelect={setCourseId}
          />

          {!isOnline ? (
            <Text style={styles.note}>
              Matching compares your schedule with other students on the course, so
              it needs a connection. Everything else on your groups still works
              offline.
            </Text>
          ) : (
            <Button
              label={result ? 'Search again' : 'Find matches'}
              onPress={() => void handleFind()}
              loading={searching}
              disabled={!courseId || searching}
              style={styles.find}
              accessibilityHint="Compares your weekly availability with groups and students on this course"
            />
          )}

          {!!error && (
            <Text style={styles.formError} accessibilityLiveRegion="polite">
              {error}
            </Text>
          )}
          {!!status && (
            <Text style={styles.status} accessibilityLiveRegion="polite">
              {status}
            </Text>
          )}

          {searching && !result && (
            <Text style={styles.note}>Comparing schedules on this course…</Text>
          )}

          {noSlots && (
            <View style={styles.warnCard}>
              <Text style={styles.warnTitle}>Set your availability first</Text>
              <Text style={styles.warnBody}>
                You have no free slots saved for this course, so every score below is
                guesswork. Adding your weekly availability is the single biggest
                improvement you can make to matching.
              </Text>
              <Pressable
                onPress={() => router.push('/(app)/profile')}
                accessibilityRole="button"
                accessibilityLabel="Edit your availability"
              >
                <Text style={styles.link}>Edit availability</Text>
              </Pressable>
            </View>
          )}

          {!!result && (
            <>
              <Text style={styles.sectionHeader}>Groups to join</Text>
              {result.groups.length === 0 ? (
                <Text style={styles.emptyText}>
                  No open groups on{' '}
                  {selected?.course?.course_code ?? 'this course'} match right now.
                  Starting one with a suggested partner below is usually faster than
                  waiting.
                </Text>
              ) : (
                result.groups.map((group) => {
                  const alreadyAsked =
                    group.already_requested || requested.has(group.group_id);
                  const canAsk = canRequestToJoin({
                    // find-group types status loosely on the wire; the values are
                    // the same five the enum holds.
                    status: group.status as GroupStatus,
                    member_count: group.member_count,
                    max_members: group.max_members,
                    already_requested: alreadyAsked,
                  });
                  return (
                    <View key={group.group_id} style={styles.card}>
                      <View style={styles.cardTop}>
                        <Text style={styles.cardName} numberOfLines={1}>
                          {group.group_name}
                        </Text>
                        <Text style={styles.badge}>
                          {scorePercent(group.match.score)}% match
                        </Text>
                      </View>
                      <Text style={styles.cardMeta}>
                        {capacityLabel(group.member_count, group.max_members)} ·{' '}
                        {group.match.shared_slots} slot
                        {group.match.shared_slots === 1 ? '' : 's'} in common
                      </Text>
                      {!!group.availability_summary && (
                        <Text style={styles.cardWhen}>
                          Usually free: {group.availability_summary}
                        </Text>
                      )}
                      <Button
                        label={alreadyAsked ? 'Request sent' : 'Ask to join'}
                        variant={alreadyAsked ? 'secondary' : 'primary'}
                        onPress={() => void handleAsk(group)}
                        disabled={!canAsk || busyId !== null}
                        loading={busyId === group.group_id}
                        style={styles.cardButton}
                      />
                    </View>
                  );
                })
              )}

              <Text style={styles.sectionHeader}>Start a group with</Text>
              {result.suggested_partners.length === 0 ? (
                <Text style={styles.emptyText}>
                  Nobody on this course is currently ungrouped and looking.
                </Text>
              ) : (
                result.suggested_partners.map((partner) => {
                  const asked = invited.has(partner.user_id);
                  return (
                    <View key={partner.user_id} style={styles.card}>
                      <View style={styles.cardTop}>
                        <Text style={styles.cardName} numberOfLines={1}>
                          {displayName(partner.full_name)}
                        </Text>
                        <Text style={styles.badge}>
                          {scorePercent(partner.match.score)}% match
                        </Text>
                      </View>
                      {!!partner.department && (
                        <Text style={styles.cardMeta}>{partner.department}</Text>
                      )}
                      <Text style={styles.cardMeta}>
                        {partner.match.shared_slots} slot
                        {partner.match.shared_slots === 1 ? '' : 's'} in common
                      </Text>
                      {!!partner.availability_summary && (
                        <Text style={styles.cardWhen}>
                          Usually free: {partner.availability_summary}
                        </Text>
                      )}
                      <Button
                        label={asked ? 'Invited' : 'Start a group together'}
                        variant={asked ? 'secondary' : 'primary'}
                        onPress={() => void handleStartWith(partner)}
                        disabled={asked || busyId !== null}
                        loading={busyId === partner.user_id}
                        style={styles.cardButton}
                        accessibilityHint="Creates a group on this course and invites them to it"
                      />
                    </View>
                  );
                })
              )}
            </>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loader: { marginVertical: spacing.xl },
  find: { marginTop: spacing.md },
  note: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
    marginTop: spacing.md,
  },
  emptyText: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    lineHeight: 20,
    marginTop: spacing.md,
  },
  link: {
    fontSize: fontSize.sm,
    fontFamily: FONT.bold,
    color: colors.primaryDark,
    marginTop: spacing.sm,
  },
  sectionHeader: {
    fontSize: fontSize.md,
    fontFamily: FONT.bold,
    color: colors.text,
    marginTop: spacing.xl,
  },
  card: {
    marginTop: spacing.md,
    padding: spacing.lg,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.lg,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardName: {
    flex: 1,
    fontSize: fontSize.md,
    fontFamily: FONT.bold,
    color: colors.text,
    paddingRight: spacing.sm,
  },
  badge: {
    fontSize: fontSize.xs,
    fontFamily: FONT.bold,
    color: colors.primaryDark,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  cardMeta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.xs },
  cardWhen: { fontSize: fontSize.xs, color: colors.text, marginTop: spacing.xs, lineHeight: 18 },
  cardButton: { marginTop: spacing.md },
  warnCard: {
    marginTop: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  warnTitle: { fontSize: fontSize.sm, fontFamily: FONT.bold, color: colors.text },
  warnBody: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
    marginTop: spacing.xs,
  },
  formError: { color: colors.danger, fontSize: fontSize.sm, marginTop: spacing.md, lineHeight: 20 },
  status: { color: colors.success, fontSize: fontSize.sm, marginTop: spacing.md },
});
