import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { CacheKeys, cacheReadData, cacheWrite } from '@/lib/cache';
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  NOTIFICATION_PAGE_SIZE,
  unreadNotificationCount,
} from '@/lib/notifications';
import {
  applyAllNotificationsRead,
  applyNotificationRead,
  buildInbox,
  countUnreadNotifications,
  nextInboxCursor,
  upsertNotifications,
  type InboxItem,
} from '@/lib/notificationRules';
import type { Notification } from '@/types/database';

/**
 * The in-app inbox: what this student was told, newest first, with day headers.
 *
 * CACHED, unlike `useUnread`. The two look similar and the difference is the
 * point: a badge answers "has anything happened since I looked", which is
 * worthless stale, whereas a notification is a record of something that already
 * happened and stays true — "BIO 201 confirmed Thursday 4pm" is exactly what a
 * student wants to re-read on a bus with no signal. So the list is cached and the
 * count on home is not.
 *
 * Unread is counted from the rows on screen rather than asked of the server, so
 * the number and the list can never disagree. `unreadNotificationCount` exists for
 * home, which holds no rows.
 *
 * Marking read is optimistic and NOT queued offline. `markNotificationRead` is
 * treated like `mark_group_read` for the same reason: a dismissal replayed twenty
 * minutes later would clear notifications that arrived in the meantime. Offline the
 * tap is refused rather than remembered — the screen says so.
 *
 * No Realtime subscription. `notifications` is not in the publication, and a
 * remote push arriving is itself the live signal; the next focus reconciles.
 */

interface State {
  /** Flat, day-sectioned, ready for a FlatList. */
  items: InboxItem[];
  rows: Notification[];
  unread: number;
  loading: boolean;
  /** True while an older page is in flight. */
  loadingMore: boolean;
  /** False once a short page has come back — there is nothing older. */
  hasMore: boolean;
  error: string | null;
  reload: () => Promise<void>;
  loadOlder: () => Promise<void>;
  /** Dismiss one row. Resolves false when the call failed and nothing changed. */
  markRead: (notificationId: string) => Promise<boolean>;
  /** Dismiss every unread row. Resolves false when the call failed. */
  markAllRead: () => Promise<boolean>;
}

const NO_ROWS: Notification[] = [];

export function useNotifications(userId: string | null): State {
  const [rows, setRows] = useState<Notification[]>(NO_ROWS);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Which fetch is the newest one asked for.
   *
   * Overlapping requests are normal here: a focus refetch races the "load older"
   * a scroll started, and without this the older response can land second and
   * replace a merged list with just its own page.
   */
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++sequence.current;

    if (!userId) {
      setRows(NO_ROWS);
      setLoading(false);
      return;
    }
    setError(null);

    const cacheKey = CacheKeys.notifications(userId);
    const cached = await cacheReadData<Notification[]>(cacheKey);
    // Array.isArray rather than a truthiness check, like useMaterials: the cache
    // has no per-shape version, so a future change to what is stored under this
    // key must not be able to hand `.map()` something that is not a list.
    const hadCache = Array.isArray(cached);
    if (hadCache && ticket === sequence.current) {
      setRows(cached);
      setLoading(false);
    }

    try {
      const page = await fetchNotifications(null);
      if (ticket !== sequence.current) return;
      // Replaces rather than merges. This is the newest page from the top, so
      // anything it does not contain is either older — and will come back through
      // loadOlder — or gone. Merging would resurrect a row deleted server-side by
      // a cascade when a group was deleted.
      setRows(page);
      setHasMore(page.length === NOTIFICATION_PAGE_SIZE);
      setLoading(false);
      await cacheWrite(cacheKey, page);
    } catch {
      if (ticket !== sequence.current) return;
      // Only an error when there is nothing to show: a cached inbox plus the
      // offline banner the screen already renders says more than an error does.
      if (!hadCache) setError("Can't load your notifications right now.");
      setLoading(false);
    }
  }, [userId]);

  // Fires on mount and on every return, so this is the only fetch needed — and a
  // student coming back from a group whose notification they just acted on sees
  // it dismissed.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const loadOlder = useCallback(async () => {
    if (!userId || loadingMore || !hasMore) return;
    const cursor = nextInboxCursor(rows);
    if (!cursor) return;

    setLoadingMore(true);
    try {
      const page = await fetchNotifications(cursor);
      setRows((current) => upsertNotifications(current, page));
      setHasMore(page.length === NOTIFICATION_PAGE_SIZE);
    } catch {
      // Silent. The rows already on screen are unaffected, and a student who
      // scrolled into no-signal territory gets the offline banner, not a modal.
    } finally {
      setLoadingMore(false);
    }
  }, [userId, rows, loadingMore, hasMore]);

  /**
   * Older pages are deliberately NOT written to the cache — only the newest page
   * is. The cache is there so the inbox opens with content, and growing it every
   * time somebody scrolls would put an unbounded list in AsyncStorage on a phone
   * where AsyncStorage is not fast.
   */

  const markRead = useCallback(
    async (notificationId: string): Promise<boolean> => {
      const at = new Date().toISOString();
      const before = rows;
      // Optimistic, and reverted below if the call fails. The row stays in the
      // list either way: a dismissal that removed it would leave no way back to
      // something tapped by accident.
      setRows((current) => applyNotificationRead(current, notificationId, at));
      try {
        await markNotificationRead(notificationId);
        return true;
      } catch {
        setRows(before);
        return false;
      }
    },
    [rows]
  );

  const markAllRead = useCallback(async (): Promise<boolean> => {
    const at = new Date().toISOString();
    const before = rows;
    setRows((current) => applyAllNotificationsRead(current, at));
    try {
      await markAllNotificationsRead();
      return true;
    } catch {
      setRows(before);
      return false;
    }
  }, [rows]);

  const items = useMemo(() => buildInbox(rows), [rows]);

  return {
    items,
    rows,
    unread: countUnreadNotifications(rows),
    loading,
    loadingMore,
    hasMore,
    error,
    reload: load,
    loadOlder,
    markRead,
    markAllRead,
  };
}

/**
 * Just the number, for home's badge — no rows, no cache.
 *
 * Split from `useNotifications` rather than folded into it because home must not
 * pay for a page of rows it does not render, and because this one is uncached for
 * `useUnread`'s reason: a stale count that nags is worse than no count. The two
 * hooks answer the same question from different places on purpose.
 */
export function useNotificationBadge(userId: string | null): {
  unread: number;
  reload: () => Promise<void>;
} {
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    if (!userId) {
      setUnread(0);
      return;
    }
    try {
      setUnread(await unreadNotificationCount());
    } catch {
      // Kept as it was. Nothing here is an error a student can act on.
    }
  }, [userId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  return { unread, reload: load };
}
