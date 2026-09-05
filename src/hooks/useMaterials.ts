import { useCallback, useEffect, useRef, useState } from 'react';
import { CacheKeys, cacheReadData, cacheWrite } from '@/lib/cache';
import { groupMaterials } from '@/lib/chat';
import type { GroupMaterialRow } from '@/types/database';

/**
 * Every file a group has shared, newest first — the files tab's only source.
 *
 * NOT `useMessages`, and that is the point of this file existing. The chat hook
 * already holds a `materials` map, but it subscribes to Realtime and calls
 * `mark_group_read` on mount and on every focus. A student who opens the files
 * tab looking for last week's slides has not read the conversation, and a hook
 * that quietly cleared their unread badge would be lying to them about it.
 *
 * Cached, following `useGroupDetail`: a list of what the group has shared is
 * worth having on screen with no connection, even though the download itself
 * needs one. The rows carry `storage_path`, so a cached list is still enough to
 * sign a URL the moment the connection is back.
 *
 * REMOVED FILES ARE ASKED FOR. `group_materials` marks them rather than hiding
 * them, and `materialStateLabel` renders "Removed by Ada" — somebody hunting for
 * a file they know was shared deserves an answer better than an absence.
 *
 * No Realtime subscription at all. `materials` is in the publication (0017), but
 * a replicated row carries neither `uploader_name` nor the note, and every write
 * on this screen is one the student just made — so the refetch after it, plus the
 * one on focus, covers everything a subscription would. What that leaves is a
 * file somebody else shares while this tab is open, which the next focus picks
 * up; a files list is not a conversation, and it does not have to be live.
 */

interface State {
  materials: GroupMaterialRow[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

const EMPTY: GroupMaterialRow[] = [];

export function useMaterials(
  userId: string | null,
  groupId: string | null
): State {
  const [materials, setMaterials] = useState<GroupMaterialRow[]>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Which fetch is the newest one asked for.
   *
   * Two of them overlap more often here than anywhere else in the app: removing
   * a file reloads, and so does coming back from the OS download handler, so a
   * remove followed by a focus has two requests in the air. Without this, the
   * older response can land second and put the removed file back on screen
   * offering a Download that now signs nothing.
   */
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++sequence.current;

    if (!userId || !groupId) {
      setMaterials(EMPTY);
      setLoading(false);
      return;
    }
    setError(null);

    const cacheKey = CacheKeys.materials(userId, groupId);
    const cached = await cacheReadData<GroupMaterialRow[]>(cacheKey);
    // Array.isArray, not a truthiness check: the key is new in Stage 4, but the
    // cache has no per-shape version, so a future change to what is stored here
    // must not be able to hand `.map()` something that is not a list.
    const hadCache = Array.isArray(cached);
    if (hadCache && ticket === sequence.current) {
      setMaterials(cached);
      setLoading(false);
    }

    try {
      const rows = await groupMaterials(groupId, true);
      if (ticket !== sequence.current) return;
      setMaterials(rows);
      setLoading(false);
      await cacheWrite(cacheKey, rows);
    } catch {
      if (ticket !== sequence.current) return;
      // Only an error when there is nothing to show. A cached list plus the
      // offline note the screen already renders says more than an error would.
      if (!hadCache) setError("Can't load this group's files right now.");
      setLoading(false);
    }
  }, [userId, groupId]);

  // A different group starts empty rather than showing the last one's files
  // while its own fetch is in flight.
  useEffect(() => {
    setMaterials(EMPTY);
    setLoading(true);
  }, [userId, groupId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { materials, loading, error, reload: load };
}
