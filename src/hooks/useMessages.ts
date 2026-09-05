import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CacheKeys, cacheReadData, cacheWrite } from '@/lib/cache';
import {
  MESSAGE_PAGE_SIZE,
  fetchMessages,
  groupMaterials,
  groupSessions,
  markGroupRead,
} from '@/lib/chat';
import { nextPageCursor, upsertMessages } from '@/lib/chatRules';
import { supabase } from '@/lib/supabase';
import type {
  GroupMaterialRow,
  GroupSessionRow,
  Message,
} from '@/types/database';

/**
 * The chat screen's data: one page of a group's timeline, live, plus the cards
 * its rows point at.
 *
 * THREE SOURCES, ONE LOADING STATE, for the reason useGroupDetail gives: a
 * transcript that renders its bubbles, then its session cards, then its file
 * cards reflows three times on a slow connection. There is a second reason
 * here though, and it is the load-bearing one.
 *
 * ONLY `public.messages` IS SUBSCRIBED TO HERE. `study_sessions` and `materials`
 * are in the `supabase_realtime` publication too (0016, 0017), so subscribing to
 * them is possible — it is just not useful. Both are read through SECURITY
 * DEFINER RPCs that join in the proposer's name, the uploader's name, the tally
 * and the threshold a card renders, and a replicated row carries none of that; a
 * card built from the raw row would be missing most of its own text. So the live
 * edge is deliberately narrow — a message arrives, and when it is a session or
 * file message the hook refetches the lists behind it through those RPCs. A row
 * that changes with no message attached (somebody else answering a study time,
 * somebody removing a file) produces nothing this hook is listening for; that one
 * is caught on the next focus, or by whichever screen made the change calling
 * `refreshCards`.
 *
 * Nothing here replaces the transcript, everything merges into it by
 * `message_id` through upsertMessages: an optimistic bubble, that same INSERT
 * echoing back off the socket, and the page a reload fetched are three copies
 * of one row, and the newest copy wins.
 *
 * Sessions and materials are held as plain objects keyed by id rather than
 * Maps, because this state is written to the cache and a Map survives
 * JSON.stringify as `{}`.
 */

export interface ChatTimeline {
  /** Newest first — the order an inverted FlatList renders from. */
  messages: Message[];
  /** Keyed by the id a `kind='session'` message points at. */
  sessions: Record<string, GroupSessionRow>;
  /** Keyed by the id a `kind='file'` message points at. */
  materials: Record<string, GroupMaterialRow>;
}

interface State extends ChatTimeline {
  loading: boolean;
  error: string | null;
  /** False once a short page comes back: nothing older left to ask for. */
  hasMore: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
  reload: () => Promise<void>;
  /** Refetch the session and file cards without disturbing the transcript. */
  refreshCards: () => Promise<void>;
  /** Put a locally made message on screen now — the optimistic send path. */
  mergeLocal: (messages: Message[]) => void;
}

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_SESSIONS: Record<string, GroupSessionRow> = {};
const EMPTY_MATERIALS: Record<string, GroupMaterialRow> = {};

function byId<T>(rows: readonly T[], id: (row: T) => string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const row of rows) out[id(row)] = row;
  return out;
}

export function useMessages(
  userId: string | null,
  groupId: string | null
): State {
  const [messages, setMessages] = useState<Message[]>(EMPTY_MESSAGES);
  const [sessions, setSessions] = useState(EMPTY_SESSIONS);
  const [materials, setMaterials] = useState(EMPTY_MATERIALS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // The transcript as a ref too, so loadOlder can read the oldest message it
  // holds without listing `messages` as a dependency — a cursor that changes
  // identity on every arriving message would rebuild the callback, and with it
  // the FlatList prop that uses it, thirty times a busy minute.
  const held = useRef<Message[]>(EMPTY_MESSAGES);
  useEffect(() => {
    held.current = messages;
  }, [messages]);

  const olderInFlight = useRef(false);
  /** Whether this screen is the one the student is looking at. */
  const focused = useRef(false);

  const mergeLocal = useCallback((incoming: Message[]) => {
    if (incoming.length === 0) return;
    setMessages((prev) => upsertMessages(prev, incoming));
  }, []);

  const refreshCards = useCallback(async () => {
    if (!groupId) return;
    try {
      // Past sessions and removed files included: a card can be scrolled back
      // to weeks later, and it still has to render as the thing it was.
      const [sessionRows, materialRows] = await Promise.all([
        groupSessions(groupId, true),
        groupMaterials(groupId, true),
      ]);
      setSessions(byId(sessionRows, (row) => row.session_id));
      setMaterials(byId(materialRows, (row) => row.material_id));
    } catch {
      // Silent by design. A card whose row has not arrived falls back to the
      // message body, which is a readable sentence for exactly this reason —
      // one failed refetch is not worth an error over a transcript already up.
    }
  }, [groupId]);

  const markRead = useCallback(async () => {
    if (!groupId) return;
    try {
      await markGroupRead(groupId);
    } catch {
      // Never queued for later (HANDOFF §8). A read cursor replayed when the
      // connection returns would mark messages read that arrived after the
      // student put the phone down — the one thing a badge must not do.
    }
  }, [groupId]);

  const load = useCallback(async () => {
    if (!userId || !groupId) {
      setMessages(EMPTY_MESSAGES);
      setLoading(false);
      return;
    }
    setError(null);

    const cacheKey = CacheKeys.chat(userId, groupId);
    const cached = await cacheReadData<ChatTimeline>(cacheKey);
    if (cached) {
      setMessages((prev) => upsertMessages(prev, cached.messages ?? []));
      setSessions(cached.sessions ?? EMPTY_SESSIONS);
      setMaterials(cached.materials ?? EMPTY_MATERIALS);
      setLoading(false);
    }

    try {
      const [page, sessionRows, materialRows] = await Promise.all([
        fetchMessages(groupId),
        groupSessions(groupId, true),
        groupMaterials(groupId, true),
      ]);
      const nextSessions = byId(sessionRows, (row) => row.session_id);
      const nextMaterials = byId(materialRows, (row) => row.material_id);

      // Merged, not assigned: a message sent while this was in the air, and
      // anything the socket delivered in the same window, are both newer than
      // the page and have to survive it.
      setMessages((prev) => upsertMessages(prev, page));
      setSessions(nextSessions);
      setMaterials(nextMaterials);
      // A short page means there is nothing older. A full one means there may
      // be, and the only way to find out is to ask, which loadOlder does.
      setHasMore(page.length === MESSAGE_PAGE_SIZE);
      setLoading(false);

      // The fetched page, not the merged list — the cache stays one screenful
      // however far back the student has scrolled this session.
      await cacheWrite(cacheKey, {
        messages: page,
        sessions: nextSessions,
        materials: nextMaterials,
      });
    } catch {
      if (!cached) setError("Can't load this conversation right now.");
      setLoading(false);
    }
  }, [userId, groupId]);

  const loadOlder = useCallback(async () => {
    if (!groupId || !hasMore || olderInFlight.current) return;
    const cursor = nextPageCursor(held.current);
    if (!cursor) return;

    olderInFlight.current = true;
    setLoadingOlder(true);
    try {
      const page = await fetchMessages(groupId, cursor);
      setMessages((prev) => upsertMessages(prev, page));
      setHasMore(page.length === MESSAGE_PAGE_SIZE);
    } catch {
      // hasMore is left as it was: the older page still exists, the connection
      // does not. The next scroll to the top asks again.
    } finally {
      olderInFlight.current = false;
      setLoadingOlder(false);
    }
  }, [groupId, hasMore]);

  // A different group starts empty. upsertMessages merges by id and nothing
  // ever removes a row from the list, so without this the previous group's
  // transcript would sit underneath the new one's and stay there.
  useEffect(() => {
    setMessages(EMPTY_MESSAGES);
    setSessions(EMPTY_SESSIONS);
    setMaterials(EMPTY_MATERIALS);
    held.current = EMPTY_MESSAGES;
    setHasMore(false);
    setLoading(true);
  }, [userId, groupId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The live edge.
   *
   * postgres_changes re-evaluates `messages_select_members` for every subscriber
   * (0014), so the filter below is a narrowing and not the permission: a student
   * subscribed to a group they are not in receives nothing with or without it.
   *
   * UPDATE matters as much as INSERT. A delete arrives as one — delete_my_message
   * blanks the body and stamps deleted_at rather than removing the row, and that
   * tombstone is what holds both the transcript's shape and the keyset cursor.
   */
  useEffect(() => {
    if (!groupId) return;

    const channel = supabase
      .channel(`chat:${groupId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `group_id=eq.${groupId}`,
        },
        (payload) => {
          const row = payload.new as Message;
          setMessages((prev) => upsertMessages(prev, [row]));
          // The card behind a session or file message is not replicated, so it
          // has to be fetched before the row can render as anything but text.
          if (row.kind !== 'text') void refreshCards();
          // It arrived while the student was looking at it, so it is read. The
          // RPC only moves the cursor forward, so an extra call costs nothing.
          if (focused.current && row.sender_id !== userId) void markRead();
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `group_id=eq.${groupId}`,
        },
        (payload) => {
          setMessages((prev) => upsertMessages(prev, [payload.new as Message]));
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [groupId, userId, refreshCards, markRead]);

  /**
   * Read on mount and on every return to the screen — focus fires on mount too,
   * so one effect covers both halves of what the badge needs.
   *
   * This lives in the hook rather than in the screen, where the rest of the app
   * puts useFocusEffect, because a read cursor that is silently never advanced
   * reads as a broken badge rather than as a missing call.
   *
   * The first focus skips refreshCards, since load() has just fetched both
   * lists. Later ones do not, and that refetch is the only thing that catches a
   * study time somebody answered while this screen was in the background.
   */
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void markRead();
      if (firstFocus.current) {
        firstFocus.current = false;
      } else {
        void refreshCards();
      }
      return () => {
        focused.current = false;
      };
    }, [markRead, refreshCards])
  );

  return {
    messages,
    sessions,
    materials,
    loading,
    error,
    hasMore,
    loadingOlder,
    loadOlder,
    reload: load,
    refreshCards,
    mergeLocal,
  };
}
