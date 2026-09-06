import { useCallback, useEffect, useState } from 'react';
import { matchingWindowState } from '@/lib/groups';
import type { MatchingWindowState } from '@/types/database';

/**
 * The current registration period for automatic matching (0020).
 *
 * DELIBERATELY NOT CACHED, unlike every other hook in this folder. The whole
 * value of this row is that it is current: `is_open` from an hour ago would put a
 * live Apply button under a window that has since shut, and `server_now` cached
 * to disk is not a server clock any more — it is a stale number that would make
 * the deadline read as the wrong day. Both failures point the same way, at a
 * student tapping Apply and being refused for a reason nothing on screen showed.
 *
 * So there is no offline answer here, and that costs nothing real: applying is an
 * online-only action anyway (see `requestMatching`), and everything a student can
 * do without automatic matching — browse, request, accept an invitation — works
 * whether this loads or not. `offline` is reported separately from `error` so the
 * screen can say "can't check right now" rather than "there is no window".
 */

interface State {
  window: MatchingWindowState | null;
  loading: boolean;
  /** True when the lookup failed, so `window` is unknown rather than absent. */
  unavailable: boolean;
  reload: () => Promise<void>;
}

export function useMatchingWindow(userId: string | null): State {
  const [window, setWindow] = useState<MatchingWindowState | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    if (!userId) {
      setWindow(null);
      setLoading(false);
      return;
    }
    setUnavailable(false);
    try {
      setWindow(await matchingWindowState());
    } catch {
      // Keep no stale row: an unknown window must not look like an open one.
      setWindow(null);
      setUnavailable(true);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { window, loading, unavailable, reload: load };
}
