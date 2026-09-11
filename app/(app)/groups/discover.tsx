import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { Button } from '@/components/Button';
import { CourseChips } from '@/components/CourseChips';
import { Screen } from '@/components/Screen';
import { StatusPill } from '@/components/StatusPill';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useDiscover } from '@/hooks/useDiscover';
import { useUserCourses } from '@/hooks/useUserCourses';
import { canRequestToJoin, capacityLabel, isFull, seatsLeft } from '@/lib/groupRules';
import { requestToJoin } from '@/lib/groups';
import { friendlyError } from '@/lib/supabase';
import { FONT, colors, fontSize, radius, spacing } from '@/theme';
import type { DiscoverGroupRow } from '@/types/database';

/**
 * Browse the open groups on a course, and ask to join one.
 *
 * The listing itself is a server-side projection (`discover_groups`): it can
 * report how full a group is and whether you have already asked to join without
 * exposing who is in it. Groups you are already in are filtered out server-side,
 * so this list is only ever "somewhere new to go".
 *
 * Asking to join is online-only, unlike creating a group. A request is answered
 * by a person, and queueing one that the group fills up before it is even sent
 * would produce an approval that cannot be honoured.
 */
export default function DiscoverScreen() {
  const { profile } = useAuth();
  const { isOnline } = useNetwork();
  const router = useRouter();

  const userId = profile?.user_id ?? null;
  const { userCourses, loading: coursesLoading } = useUserCourses(userId);

  const [courseId, setCourseId] = useState<string | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const { groups, loading, error, reload } = useDiscover(userId, courseId);

  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  /** Rows we have asked to join this session — the RPC's flag is a fetch behind. */
  const [requested, setRequested] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!courseId && userCourses.length > 0) setCourseId(userCourses[0].course_id);
  }, [courseId, userCourses]);

  const selected = useMemo(
    () => userCourses.find((uc) => uc.course_id === courseId) ?? null,
    [userCourses, courseId]
  );

  /**
   * The toggle filters the list already in hand rather than refetching with the
   * RPC's `p_only_open`, which does nothing but drop full groups. Same rows, no
   * round trip per flick of the switch — and the hook keeps one cache entry per
   * course instead of one per course and filter state.
   */
  const visible = useMemo(
    () => (onlyOpen ? groups.filter((g) => !isFull(g.member_count, g.max_members)) : groups),
    [groups, onlyOpen]
  );

  async function handleRequest(group: DiscoverGroupRow) {
    setFormError(null);
    setStatus(null);
    setBusyGroupId(group.group_id);
    try {
      await requestToJoin(group.group_id);
      setRequested((current) => new Set(current).add(group.group_id));
      setStatus(`Asked to join ${group.group_name}. The group decides from here.`);
    } catch (error) {
      setFormError(friendlyError(error));
    } finally {
      setBusyGroupId(null);
    }
  }

  return (
    <Screen
      title="Open groups"
      subtitle="Groups on your courses that are taking new members."
      footer={
        <Button label="Back" variant="secondary" onPress={() => router.back()} />
      }
    >
      {coursesLoading && userCourses.length === 0 ? (
        <ActivityIndicator color={colors.primaryDark} style={styles.loader} />
      ) : userCourses.length === 0 ? (
        <View>
          <Text style={styles.emptyText}>
            Groups are per course, and you are not enrolled in any yet.
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

          <View style={styles.filterRow}>
            <Text style={styles.filterLabel}>Only groups with room</Text>
            <Switch
              value={onlyOpen}
              onValueChange={setOnlyOpen}
              trackColor={{ true: colors.accent, false: colors.border }}
              accessibilityLabel="Show only groups with a free seat"
            />
          </View>

          {!isOnline && (
            <Text style={styles.note}>
              You are offline, so this list may be out of date and joining is
              paused until you reconnect.
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

          {loading && groups.length === 0 ? (
            <ActivityIndicator color={colors.primaryDark} style={styles.loader} />
          ) : error && groups.length === 0 ? (
            <Text style={styles.errorText}>{error}</Text>
          ) : visible.length === 0 ? (
            <Text style={styles.emptyText}>
              {groups.length > 0
                ? `Every group on ${selected?.course?.course_code ?? 'this course'} is full. Turn the filter off to see them, or start your own.`
                : `Nothing open on ${selected?.course?.course_code ?? 'this course'} right now. Creating one is often faster than waiting — everyone on the course can then find it.`}
            </Text>
          ) : (
            visible.map((group) => {
              const alreadyAsked = group.already_requested || requested.has(group.group_id);
              const canAsk =
                isOnline &&
                canRequestToJoin({ ...group, already_requested: alreadyAsked });
              return (
                <View key={group.group_id} style={styles.card}>
                  <View style={styles.cardTop}>
                    <Text style={styles.cardName} numberOfLines={1}>
                      {group.group_name}
                    </Text>
                    <StatusPill status={group.status} />
                  </View>
                  <Text style={styles.cardMeta}>
                    {capacityLabel(group.member_count, group.max_members)}
                    {isFull(group.member_count, group.max_members)
                      ? ' · full'
                      : ` · ${seatsLeft(group.member_count, group.max_members)} free`}
                  </Text>
                  <Button
                    label={
                      alreadyAsked
                        ? 'Request sent'
                        : isFull(group.member_count, group.max_members)
                          ? 'Group is full'
                          : 'Ask to join'
                    }
                    variant={alreadyAsked ? 'secondary' : 'primary'}
                    onPress={() => void handleRequest(group)}
                    disabled={!canAsk}
                    loading={busyGroupId === group.group_id}
                    style={styles.cardButton}
                    accessibilityHint={
                      alreadyAsked
                        ? 'Waiting for the group to respond'
                        : 'A member of the group has to approve you'
                    }
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
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loader: { marginVertical: spacing.xl },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  filterLabel: { fontSize: fontSize.sm, color: colors.text, fontFamily: FONT.semi },
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
  link: { fontSize: fontSize.sm, fontFamily: FONT.bold, color: colors.primaryDark, marginTop: spacing.sm },
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
  cardMeta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.xs },
  cardButton: { marginTop: spacing.md },
  formError: { color: colors.danger, fontSize: fontSize.sm, marginBottom: spacing.sm },
  status: { color: colors.success, fontSize: fontSize.sm, marginBottom: spacing.sm },
  refresh: { marginTop: spacing.lg },
});
