import { useCallback, useEffect, useState } from 'react';
import { CacheKeys, cacheReadData, cacheWrite } from '@/lib/cache';
import { myInvitations } from '@/lib/groups';
import type { InvitationDetailRow } from '@/types/database';

/**
 * The student's pending invitations.
 *
 * Via the `my_invitations` RPC (0010) rather than a select on `invitations`,
 * because the invitation rows are readable but the group name behind them often
 * is not: a non-discoverable group is invisible to a non-member, so an invite to
 * a private group would render as a nameless card.
 *
 * Cached so the inbox opens offline; responding to one still needs a connection.
 */

interface State {
  invitations: InvitationDetailRow[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Drop one locally after responding, so the card leaves immediately. */
  removeLocal: (invitationId: string) => void;
}

export function useInvitations(userId: string | null): State {
  const [invitations, setInvitations] = useState<InvitationDetailRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setInvitations([]);
      setLoading(false);
      return;
    }
    setError(null);

    const cacheKey = CacheKeys.invitations(userId);
    const cached = await cacheReadData<InvitationDetailRow[]>(cacheKey);
    if (cached) {
      setInvitations(cached);
      setLoading(false);
    }

    try {
      const rows = await myInvitations();
      setInvitations(rows);
      setLoading(false);
      await cacheWrite(cacheKey, rows);
    } catch {
      if (!cached) setError("Can't load your invitations right now.");
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const removeLocal = useCallback(
    (invitationId: string) => {
      setInvitations((current) => {
        const next = current.filter((i) => i.invitation_id !== invitationId);
        if (userId) void cacheWrite(CacheKeys.invitations(userId), next);
        return next;
      });
    },
    [userId]
  );

  return { invitations, loading, error, reload: load, removeLocal };
}
