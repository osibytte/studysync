import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionAttendees } from '@/lib/chat';
import type { SessionAttendeeRow } from '@/types/database';

/**
 * Who is coming to one session, fetched when the card is opened.
 *
 * DELIBERATELY UNCACHED, unlike every other read in this app. The rest of the
 * offline story is about the screen still working with no connection; this list
 * is the opposite kind of data — it is the answer to "has Ada replied yet",
 * which is only worth anything if it is current. A cached copy would say "waiting
 * on Ada" a day after Ada said yes, and the student would act on it.
 *
 * One hook per screen, not per card. React hooks cannot be called conditionally
 * or in a loop over list items, so the chat screen holds a single `openSessionId`
 * and passes the result down to the card that matches. Only one sheet is open at
 * a time anyway, so this also means one request per tap rather than one per
 * session in the timeline.
 *
 * Passing null (nothing open) clears the list, so reopening a card cannot flash
 * the previous session's roster.
 */

interface State {
  attendees: SessionAttendeeRow[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useSessionAttendees(sessionId: string | null): State {
  const [attendees, setAttendees] = useState<SessionAttendeeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Which session the in-flight request belongs to. Tapping one card and then
   * another before the first answers would otherwise let the slower response
   * overwrite the faster one, and the open card would list the wrong people.
   */
  const wanted = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) {
      wanted.current = null;
      setAttendees([]);
      setLoading(false);
      setError(null);
      return;
    }

    wanted.current = sessionId;
    setLoading(true);
    setError(null);
    try {
      const rows = await sessionAttendees(sessionId);
      if (wanted.current !== sessionId) return;
      setAttendees(rows);
      setLoading(false);
    } catch {
      if (wanted.current !== sessionId) return;
      // The card renders its own line for an empty list, so this only has to
      // stop the spinner — there is nothing stale to keep showing.
      setAttendees([]);
      setError('Cannot see who is coming just now.');
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { attendees, loading, error, reload: load };
}
