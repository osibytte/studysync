import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Button } from '@/components/Button';
import { CourseChips } from '@/components/CourseChips';
import { Screen } from '@/components/Screen';
import { TextField } from '@/components/TextField';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useMyGroups } from '@/hooks/useMyGroups';
import { useUserCourses } from '@/hooks/useUserCourses';
import { defaultGroupName } from '@/lib/groupRules';
import { createGroup } from '@/lib/groups';
import { makeActionId } from '@/lib/ids';
import { enqueue } from '@/lib/outbox';
import { friendlyError } from '@/lib/supabase';
import { validateGroupName } from '@/lib/validation';
import { FONT, colors, fontSize, radius, spacing } from '@/theme';
import type { MyGroupRow } from '@/types/database';

/**
 * Create a group — Pathway Two's starting point.
 *
 * Works offline, which is the reason the group id is generated here rather than
 * by Postgres: the optimistic card and the eventual row share one id, so nothing
 * has to be reconciled when the queued action finally lands, and the student can
 * keep using the app in between.
 *
 * Only enrolled courses are offered. Everything that fills a group afterwards is
 * scoped to the course's students — discover lists it to them, search_students
 * only finds them, matching only scores them — so a group on a course you are not
 * in is a group you would be sitting in alone.
 */
export default function CreateGroupScreen() {
  const { profile } = useAuth();
  const { isOnline, refreshPending } = useNetwork();
  const router = useRouter();

  const userId = profile?.user_id ?? null;
  const { userCourses, loading: coursesLoading } = useUserCourses(userId);
  const { groups, setLocal } = useMyGroups(userId);

  const [courseId, setCourseId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [discoverable, setDiscoverable] = useState(true);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Default to the first course once they load, so the form is usable on open.
  useEffect(() => {
    if (!courseId && userCourses.length > 0) setCourseId(userCourses[0].course_id);
  }, [courseId, userCourses]);

  const selected = useMemo(
    () => userCourses.find((uc) => uc.course_id === courseId) ?? null,
    [userCourses, courseId]
  );

  /**
   * Suggest "CSC 201 Study Group" and keep the suggestion in step with the
   * chosen course — but stop the moment the student types their own name, or we
   * would overwrite their wording on the next chip tap.
   */
  useEffect(() => {
    if (nameTouched) return;
    setName(defaultGroupName(selected?.course?.course_code));
  }, [selected, nameTouched]);

  async function handleCreate() {
    if (!userId || !courseId) return;
    setFormError(null);

    const problem = validateGroupName(name);
    if (problem) {
      setNameError(problem);
      return;
    }
    setNameError(null);

    const groupId = makeActionId();
    const trimmed = name.trim();
    const base = groups;

    /**
     * Optimistic card. `status: 'forming'` and `member_count: 1` are what the
     * RPC will produce (creator inserted as the only member), not guesses.
     */
    const optimistic: MyGroupRow = {
      group_id: groupId,
      group_name: trimmed,
      course_id: courseId,
      formation_type: 'self_organized',
      status: 'forming',
      is_discoverable: discoverable,
      max_members: 8,
      created_by: userId,
      last_activity_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      role: 'creator',
      joined_at: new Date().toISOString(),
      member_count: 1,
      course: selected?.course ?? null,
    };

    /** Queue for later and show the card now. Used offline and as the fallback. */
    const queueCreate = async () => {
      await enqueue(
        'group.create',
        {
          group_id: groupId,
          group_name: trimmed,
          course_id: courseId,
          is_discoverable: discoverable,
        },
        userId
      );
      setLocal([...base, optimistic]);
      await refreshPending();
    };

    setSaving(true);
    try {
      if (isOnline) {
        await createGroup({
          groupId,
          groupName: trimmed,
          courseId,
          isDiscoverable: discoverable,
        });
        setLocal([...base, optimistic]);
        // Straight into the group: the row exists server-side, so the detail
        // screen's reads will resolve.
        router.replace(`/(app)/groups/${groupId}`);
      } else {
        await queueCreate();
        // Deliberately NOT the detail screen. Its roster and availability come
        // from RPCs that need the row to exist, so it would show an error for a
        // group that is perfectly fine — just not sent yet. The list shows the
        // optimistic card instead.
        router.replace('/(app)/groups');
      }
    } catch (error) {
      try {
        await queueCreate();
        router.replace('/(app)/groups');
      } catch {
        setFormError(friendlyError(error));
      }
    } finally {
      setSaving(false);
    }
  }

  const canCreate = !!courseId && !saving && name.trim().length > 0;

  return (
    <Screen
      title="New group"
      subtitle="You become its creator, and can invite people or approve requests to join."
      onBack={() => router.back()}
      backIcon="close"
      footer={
        <Button
          label="Create group"
          onPress={() => void handleCreate()}
          loading={saving}
          disabled={!canCreate}
        />
      }
    >
      <Text style={styles.label}>Course</Text>
      {coursesLoading && userCourses.length === 0 ? (
        <Text style={styles.hint}>Loading your courses…</Text>
      ) : userCourses.length === 0 ? (
        <View>
          <Text style={styles.hint}>
            A group belongs to one course, and you are not enrolled in any yet.
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
        <CourseChips
          courses={userCourses}
          selectedCourseId={courseId}
          onSelect={setCourseId}
        />
      )}
      {!!selected?.course?.course_title && (
        <Text style={styles.hint}>{selected.course.course_title}</Text>
      )}

      <View style={styles.nameBlock}>
        <TextField
          label="Group name"
          value={name}
          onChangeText={(next) => {
            setNameTouched(true);
            setName(next);
          }}
          error={nameError}
          helper="Up to 80 characters. Members see this everywhere."
          autoCapitalize="words"
          editable={!saving}
        />
      </View>

      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.switchLabel}>Show on browse</Text>
          <Text style={styles.hint}>
            {discoverable
              ? 'Anyone on this course can find the group and ask to join.'
              : 'Invite-only — the group stays hidden until you invite someone.'}
          </Text>
        </View>
        <Switch
          value={discoverable}
          onValueChange={setDiscoverable}
          disabled={saving}
          trackColor={{ true: colors.primary, false: colors.borderStrong }}
          accessibilityLabel="Show this group on browse"
        />
      </View>

      {!!formError && (
        <Text style={styles.formError} accessibilityLiveRegion="polite">
          {formError}
        </Text>
      )}
      {!isOnline && (
        <Text style={styles.offlineNote}>
          You are offline. The group is created on this device now and synced when
          you are back online.
        </Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: fontSize.sm,
    fontFamily: FONT.semi,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  hint: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.xs, lineHeight: 18 },
  link: {
    fontSize: fontSize.sm,
    fontFamily: FONT.bold,
    color: colors.primaryDark,
    marginTop: spacing.sm,
  },
  nameBlock: { marginTop: spacing.xl },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  switchText: { flex: 1, paddingRight: spacing.md },
  switchLabel: { fontSize: fontSize.sm, fontFamily: FONT.semi, color: colors.text },
  formError: { color: colors.danger, fontSize: fontSize.sm, marginTop: spacing.lg },
  offlineNote: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: spacing.lg,
    lineHeight: 18,
  },
  cancel: { marginTop: spacing.sm },
});
