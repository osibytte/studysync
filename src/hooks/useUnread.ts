import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { unreadCounts } from '@/lib/chat';
import { totalUnread, unreadSummary } from '@/lib/chatRules';
import type { UnreadCountRow } from '@/types/database';

/**
 * Every unread badge in the app, from one `my_unread_counts()` round trip (0014).
 *
 * DELIBERATELY UNCACHED, like `useSessionAttendees` and unlike the rest of this
 * app's reads. A badge answers "what has happened since I last looked", which is
 * only worth anything if it is current — and the way it goes wrong offline is the
 * nagging kind. `mark_group_read` is never queued (see `useMessages`: a read
 * cursor replayed later would mark messages read that arrived after the student
 * put the phone down), so a student who reads a group's chat from the cache with
 * no connection has not moved their cursor. A cached badge would still claim
 * three unread when they came back to the list, and opening the chat again to
 * find nothing new is worse than no badge at all.
 *
 * The cost is that offline there are no badges and no preview lines — the cards
 * render as they did before Stage 3. That is the honest failure: the offline
 * banner is already on screen saying why.
 *
 * Refetched on every focus, because the screens that show badges stay mounted
 * while the student is in a chat marking it read. Like `useMessages`, that
 * belongs in the hook rather than in each caller: a badge that is silently never
 * refreshed reads as a broken badge and not as a missing call.
 *
 * A failed fetch keeps whatever was last shown rather than zeroing it. Nothing
 * here is an error the student can act on, so nothing here reports one.
 */

interface State {
  /** Keyed by `group_id`, for the list to look up per card. */
  byGroup: Record<string, UnreadCountRow>;
  rows: UnreadCountRow[];
  /** Across every group — home's single number. */
  total: number;
  /** "4 unread messages in 2 groups", or null when there is nothing. */
  summary: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

const NO_ROWS: UnreadCountRow[] = [];

export function useUnread(userId: string | null): State {
  const [rows, setRows] = useState<UnreadCountRow[]>(NO_ROWS);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!userId) {
      setRows(NO_ROWS);
      return;
    }
    setLoading(true);
    try {
      setRows(await unreadCounts());
    } catch {
      // Kept as it was: see the header.
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // Fires on mount as well as on every return, so this is the only fetch needed.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const byGroup = useMemo(() => {
    const out: Record<string, UnreadCountRow> = {};
    for (const row of rows) out[row.group_id] = row;
    return out;
  }, [rows]);

  return {
    byGroup,
    rows,
    total: totalUnread(rows),
    summary: unreadSummary(rows),
    loading,
    reload: load,
  };
}
