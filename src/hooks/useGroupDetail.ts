import { useCallback, useEffect, useState } from 'react';
import { CacheKeys, cacheReadData, cacheWrite } from '@/lib/cache';
import {
  groupCommonAvailability,
  groupJoinRequests,
  groupMembersDetail,
} from '@/lib/groups';
import { supabase } from '@/lib/supabase';
import type {
  Course,
  Group,
  GroupCommonAvailabilityRow,
  GroupMemberDetailRow,
  GroupRole,
  JoinRequestDetailRow,
} from '@/types/database';

/**
 * Everything the group detail screen renders, in one hook.
 *
 * Four sources, fetched together: the group row (readable to a member under the
 * 0005 policy), the roster with names, the shared availability mask and the rule
 * behind it, and pending join requests — the last three via the 0010 SECURITY
 * DEFINER reads, which exist because RLS on public.users is own-row only.
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
  /** Shared free time, with the member count and threshold behind it (0012). */
  common: GroupCommonAvailabilityRow;
  joinRequests: JoinRequestDetailRow[];
}

interface State extends GroupDetail {
  /** The caller's own role in this group, or null if they are not a member. */
  role: GroupRole | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

const NO_COMMON: GroupCommonAvailabilityRow = {
  common_mask: '',
  members_counted: 0,
  meet_threshold: 0,
};

const EMPTY: GroupDetail = {
  group: null,
  members: [],
  common: NO_COMMON,
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
      // `common` replaced a bare `commonMask` string in 0012. An entry written
      // by an older build has no `common` key, and rendering `undefined.mask`
      // would crash the screen it is meant to keep working offline.
      setDetail({ ...cached, common: cached.common ?? NO_COMMON });
      setLoading(false);
    }

    try {
      const [groupResult, members, common, joinRequests] = await Promise.all([
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
        groupCommonAvailability(groupId),
        groupJoinRequests(groupId),
      ]);

      if (groupResult.error) throw groupResult.error;

      const next: GroupDetail = {
        group: (groupResult.data as GroupDetail['group']) ?? null,
        members,
        common,
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
