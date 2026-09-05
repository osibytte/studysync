import { useCallback, useEffect, useState } from 'react';
import { CacheKeys, cacheReadData, cacheWrite } from '@/lib/cache';
import {
  groupCommonAvailabilityMask,
  groupJoinRequests,
  groupMembersDetail,
} from '@/lib/groups';
import { supabase } from '@/lib/supabase';
import type {
  Course,
  Group,
  GroupMemberDetailRow,
  GroupRole,
  JoinRequestDetailRow,
} from '@/types/database';

/**
 * Everything the group detail screen renders, in one hook.
 *
 * Four sources, fetched together: the group row (readable to a member under the
 * 0005 policy), the roster with names, the majority-rule availability mask, and
 * pending join requests — the last three via the 0010 SECURITY DEFINER reads,
 * which exist because RLS on public.users is own-row only.
 *
 * Bundled rather than four hooks so the screen has one loading state and one
 * cache entry: a detail screen that renders its roster, then its availability,
 * then its requests reflows three times on a slow connection.
 *
 * `role` is derived from the roster instead of queried separately — the caller
 * is always in the list, since every read here is membership-gated.
 */

export interface GroupDetail {
  group: (Group & { course: Course | null }) | null;
  members: GroupMemberDetailRow[];
  /** 28-char '0'/'1' mask. Read it with decodeAvailability(). */
  commonMask: string;
  joinRequests: JoinRequestDetailRow[];
}

interface State extends GroupDetail {
  /** The caller's own role in this group, or null if they are not a member. */
  role: GroupRole | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

const EMPTY: GroupDetail = {
  group: null,
  members: [],
  commonMask: '',
  joinRequests: [],
};

export function useGroupDetail(
  userId: string | null,
  groupId: string | null
): State {
  const [detail, setDetail] = useState<GroupDetail>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId || !groupId) {
      setDetail(EMPTY);
      setLoading(false);
      return;
    }
    setError(null);

    const cacheKey = CacheKeys.groupDetail(userId, groupId);
    const cached = await cacheReadData<GroupDetail>(cacheKey);
    if (cached) {
      setDetail(cached);
      setLoading(false);
    }

    try {
      const [groupResult, members, commonMask, joinRequests] = await Promise.all([
        supabase
          .from('groups')
          .select(
            `
            group_id,
            group_name,
            course_id,
            formation_type,
            status,
            is_discoverable,
            max_members,
            created_by,
            last_activity_at,
            created_at,
            course:courses (
              course_id,
              course_code,
              course_title,
              department,
              created_at
            )
          `
          )
          .eq('group_id', groupId)
          .maybeSingle(),
        groupMembersDetail(groupId),
        groupCommonAvailabilityMask(groupId),
        groupJoinRequests(groupId),
      ]);

      if (groupResult.error) throw groupResult.error;

      const next: GroupDetail = {
        group: (groupResult.data as GroupDetail['group']) ?? null,
        members,
        commonMask,
        joinRequests,
      };
      setDetail(next);
      setLoading(false);
      await cacheWrite(cacheKey, next);
    } catch {
      if (!cached) setError("Can't load this group right now.");
      setLoading(false);
    }
  }, [userId, groupId]);

  useEffect(() => {
    void load();
  }, [load]);

  const role =
    detail.members.find((m) => m.user_id === userId)?.role ?? null;

  return { ...detail, role, loading, error, reload: load };
}
