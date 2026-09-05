import { useCallback, useEffect, useState } from 'react';
import { CacheKeys, cacheReadData, cacheWrite } from '@/lib/cache';
import { discoverGroups } from '@/lib/groups';
import type { DiscoverGroupRow } from '@/types/database';

/**
 * Discoverable groups on one course — the browse list behind Pathway Two.
 *
 * Goes through the `discover_groups` RPC rather than a direct select because the
 * RPC also computes `member_count` and `already_requested` and excludes groups
 * the caller is already in. Doing that client-side would need the rosters, which
 * RLS correctly withholds from a non-member.
 *
 * Always fetches the unfiltered list, even though the RPC can drop full groups
 * server-side (`p_only_open`). The screen's "only groups with room" toggle then
 * filters what is already in hand: no refetch on every flick of the switch, one
 * cache entry per course instead of one per course and filter state, and no
 * chance of showing a filtered list under an unfiltered heading. Nothing is lost
 * to the RPC's `limit 50`, because it orders groups with room first.
 *
 * Cached so the list survives a dropped connection, but note that
 * `already_requested` and the counts go stale — the buttons the cached list
 * offers are re-checked by the RPC when tapped.
 */

interface State {
  groups: DiscoverGroupRow[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useDiscover(userId: string | null, courseId: string | null): State {
  const [groups, setGroups] = useState<DiscoverGroupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId || !courseId) {
      setGroups([]);
      setLoading(false);
      return;
    }
    setError(null);

    const cacheKey = CacheKeys.discover(userId, courseId);
    const cached = await cacheReadData<DiscoverGroupRow[]>(cacheKey);
    if (cached) {
      setGroups(cached);
      setLoading(false);
    }

    try {
      const rows = await discoverGroups(courseId);
      setGroups(rows);
      setLoading(false);
      await cacheWrite(cacheKey, rows);
    } catch {
      if (!cached) setError("Can't load groups for this course right now.");
      setLoading(false);
    }
  }, [userId, courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { groups, loading, error, reload: load };
}
