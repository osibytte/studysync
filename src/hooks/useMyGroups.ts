import { useCallback, useEffect, useState } from 'react';
import { CacheKeys, cacheReadData, cacheWrite } from '@/lib/cache';
import { sortMyGroups } from '@/lib/groupRules';
import { supabase } from '@/lib/supabase';
import type { MyGroupRow } from '@/types/database';

/**
 * The groups the signed-in student belongs to.
 *
 * No RPC needed, unlike the roster and invitation reads: a member can already
 * read their own `group_members` rows, the `groups` rows behind them
 * (groups_select_member_or_discoverable) and `courses` (readable to every
 * authenticated user), so one nested select covers it. Only the *names* of
 * other members require privilege escalation — see migration 0010.
 *
 * Cache-first: this is the student's own data and the home screen leads with it,
 * so it has to render offline.
 */

interface State {
  groups: MyGroupRow[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Patch local state without a refetch — for optimistic create/leave. */
  setLocal: (next: MyGroupRow[]) => void;
}

const EMPTY: MyGroupRow[] = [];

/**
 * Fill `member_count` for groups the caller belongs to.
 *
 * A second query rather than an embedded `group_members(count)` aggregate: the
 * counts are needed for a handful of rows, and one plain select over ids is far
 * easier to reason about against RLS than a nested aggregate. Returns the rows
 * unchanged if the count query fails — a missing count degrades a capacity
 * label, it should not blank the whole list.
 */
async function withMemberCounts(rows: MyGroupRow[]): Promise<MyGroupRow[]> {
  if (rows.length === 0) return rows;

  const { data, error } = await supabase
    .from('group_members')
    .select('group_id')
    .in(
      'group_id',
      rows.map((r) => r.group_id)
    );
  if (error || !data) return rows;

  const tally = new Map<string, number>();
  for (const row of data as { group_id: string }[]) {
    tally.set(row.group_id, (tally.get(row.group_id) ?? 0) + 1);
  }
  return rows.map((r) => ({
    ...r,
    member_count: tally.get(r.group_id) ?? r.member_count,
  }));
}

export function useMyGroups(userId: string | null): State {
  const [groups, setGroups] = useState<MyGroupRow[]>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setGroups(EMPTY);
      setLoading(false);
      return;
    }
    setError(null);

    const cached = await cacheReadData<MyGroupRow[]>(CacheKeys.myGroups(userId));
    if (cached) {
      setGroups(cached);
      setLoading(false);
    }

    const { data, error: fetchError } = await supabase
      .from('group_members')
      .select(
        `
        role,
        joined_at,
        group:groups (
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
        )
      `
      )
      .eq('user_id', userId);

    if (fetchError) {
      if (!cached) setError("Can't load your groups right now.");
      setLoading(false);
      return;
    }

    // Flatten membership + group + course into the one row the list renders.
    // A null `group` would mean the row was deleted between the two halves of
    // the join; skip it rather than render a card with no name.
    const shaped: MyGroupRow[] = (data ?? [])
      .filter((row: any) => row.group)
      .map((row: any) => ({
        ...row.group,
        course: row.group.course ?? null,
        role: row.role,
        joined_at: row.joined_at,
        // Replaced below. 1 is the floor, not a guess: the caller is a member.
        member_count: 1,
      }));

    const counted = await withMemberCounts(shaped);
    const sorted = sortMyGroups(counted);
    setGroups(sorted);
    setLoading(false);
    await cacheWrite(CacheKeys.myGroups(userId), sorted);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const setLocal = useCallback(
    (next: MyGroupRow[]) => {
      const sorted = sortMyGroups(next);
      setGroups(sorted);
      if (userId) void cacheWrite(CacheKeys.myGroups(userId), sorted);
    },
    [userId]
  );

  return { groups, loading, error, reload: load, setLocal };
}
