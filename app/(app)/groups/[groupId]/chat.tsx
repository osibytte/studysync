import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Feather } from '@expo/vector-icons';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Composer } from '@/components/Composer';
import { FileCard } from '@/components/FileCard';
import { MessageBubble } from '@/components/MessageBubble';
import { ProposeTimeSheet, type ProposalInput } from '@/components/ProposeTimeSheet';
import { Initials, courseTag } from '@/components/Initials';
import { RoundButton } from '@/components/RoundButton';
import { Screen } from '@/components/Screen';
import { SessionCard } from '@/components/SessionCard';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useGroupDetail } from '@/hooks/useGroupDetail';
import { useMessages } from '@/hooks/useMessages';
import { useSessionAttendees } from '@/hooks/useSessionAttendees';
import {
  cancelSession,
  deleteMyMessage,
  materialDownloadUrl,
  proposeSession,
  removeFile,
  respondToSession,
  sendMessage,
  shareFile,
} from '@/lib/chat';
import {
  buildTimeline,
  canCancelSession,
  canDeleteMaterial,
  canDeleteMessage,
  canDownloadMaterial,
  formatClock,
  materialNote,
  materialStateLabel,
  normaliseMessageBody,
  sessionWhenLabel,
  sharedFileBody,
  validateMessageBody,
} from '@/lib/chatRules';
import type { TimelineItem } from '@/lib/chatRules';
import { pickMaterial } from '@/lib/filePicker';
import { displayName, isCreator } from '@/lib/groupRules';
import { makeActionId } from '@/lib/ids';
import { enqueue, pendingActions } from '@/lib/outbox';
import { askAboutReminders, refreshReminders } from '@/lib/reminders';
import { friendlyError } from '@/lib/supabase';
import { FONT, MIN_TOUCH, colors, fontSize, radius, spacing } from '@/theme';
import type {
  GroupMaterialRow,
  GroupSessionRow,
  Message,
  SessionAttendeeRow,
  SessionResponseValue,
} from '@/types/database';

/**
 * A group's conversation — and, because a study time is something a group agrees
 * to in conversation, the only place study times are proposed, answered and
 * called off. Shared files land here for the same reason. There is deliberately
 * no sessions screen.
 *
 * WHAT IS QUEUEABLE HERE AND WHAT IS NOT is the whole shape of this screen, and
 * the rule is the one `outbox.ts` states: does landing late change what the
 * action means?
 *
 *   Sending a message and proposing a time — no. Both go out now if they can and
 *   queue if they cannot, both carry ids generated here, so the bubble on screen
 *   and the row Postgres eventually writes are one object.
 *
 *   Answering a study time — no. Last-write-wins on one row. A queued answer is
 *   shown beside the tally rather than folded into it: the tally comes from the
 *   server, and the confirmation trigger can flip `proposed` to `confirmed` on
 *   its own, so a client that added its own yes would be inventing state.
 *
 *   Calling one off, and deleting a message — yes, both change meaning late, and
 *   both are online-only. "The meeting is off" arriving after everyone has
 *   travelled is worse than a cancel that refused to queue.
 *
 *   Sharing or removing a file — the question does not even arise. The outbox
 *   stores JSON in AsyncStorage; an upload is bytes, and a removal needs the
 *   bucket to answer before the row may be stamped (invariant 8). Both are
 *   online-only, and the card and the ＋ menu both say so rather than failing.
 *
 * Sender names come from the roster, never from the message row: RLS on
 * `public.users` is own-row only, so `sender_id` is genuinely all a message
 * carries. A `materials` row is the exception — `group_materials` is a definer
 * RPC, so it can join `uploader_name` in.
 */
export default function ChatScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { profile } = useAuth();
  const { isOnline, pending, refreshPending } = useNetwork();
  const router = useRouter();

  const userId = profile?.user_id ?? null;
  const gid = groupId ?? null;

  const { group, members, role } = useGroupDetail(userId, gid);
  const {
    messages,
    sessions,
    materials,
    loading,
    error,
    hasMore,
    loadingOlder,
    loadOlder,
    refreshCards,
    mergeLocal,
  } = useMessages(userId, gid);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [proposing, setProposing] = useState(false);
  /** True from the moment the picker returns a file to the end of the upload. */
  const [sharing, setSharing] = useState(false);
  /** `{ id, key }` so only the pressed control on the pressed card spins. */
  const [busy, setBusy] = useState<{ id: string; key: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  /** One attendees sheet at a time, so one hook rather than one per card. */
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const {
    attendees,
    loading: attendeesLoading,
  } = useSessionAttendees(openSessionId);

  /**
   * What the outbox is still holding for this screen.
   *
   * Recomputed whenever the queue's length changes, which covers both ends: a
   * send that queues, and the drain that empties it. Reading it back out rather
   * than tracking it in local state is what makes a queued message survive a
   * remount — leave the screen mid-queue, come back, and the bubble is still
   * marked "Sending…" because the action is still there.
   */
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [queuedResponses, setQueuedResponses] = useState<
    Record<string, SessionResponseValue>
  >({});

  useEffect(() => {
    let alive = true;
    void (async () => {
      const actions = await pendingActions();
      if (!alive) return;

      const ids = new Set<string>();
      const responses: Record<string, SessionResponseValue> = {};
      for (const action of actions) {
        const payload = action.payload as {
          group_id?: string;
          message_id?: string;
          session_id?: string;
          response?: SessionResponseValue;
        };
        if (action.type === 'chat.send' || action.type === 'session.propose') {
          if (payload.group_id === gid && payload.message_id) {
            ids.add(payload.message_id);
          }
        } else if (action.type === 'session.respond') {
          // `session.respond` carries no group_id, so this may pick up an answer
          // to a session in another group. Harmless: it is only ever looked up
          // by the id of a session in this timeline. FIFO order matters though —
          // the last queued answer overwrites the earlier ones here exactly as
          // the drain will apply them.
          if (payload.session_id && payload.response) {
            responses[payload.session_id] = payload.response;
          }
        }
      }
      setPendingIds(ids);
      setQueuedResponses(responses);
    })();
    return () => {
      alive = false;
    };
  }, [gid, pending]);

  const nameFor = useCallback(
    (id: string): string => {
      if (userId && id === userId) return 'You';
      const member = members.find((m) => m.user_id === id);
      return member ? displayName(member.full_name) : 'A member';
    },
    [members, userId]
  );

  const timeline = useMemo(
    () => buildTimeline({ messages, currentUserId: userId, pendingIds }),
    [messages, userId, pendingIds]
  );

  const creator = isCreator(role);

  /* ----------------------------------------------------------------------- */
  /* Writes                                                                   */
  /* ----------------------------------------------------------------------- */

  /**
   * Send now if we can, queue if we cannot, and queue anyway if the attempt
   * threw — the idiom the group screens use, and the reason for the last part is
   * that `isOnline` is a probe, not a promise: hostel wifi associates fine and
   * carries nothing. A permanent refusal queued this way dead-letters instead of
   * retrying forever, which is the outbox's job and not this screen's.
   *
   * The bubble goes up before either, because that is what makes a send feel
   * immediate on the connection this app is written for. If even queueing fails —
   * storage full, essentially — the bubble is left orphaned and the banner says
   * so. Handing the text back to the composer as well would put the same sentence
   * on screen twice, which reads worse than one clear failure.
   */
  async function handleSend() {
    if (!userId || !gid) return;
    if (validateMessageBody(draft) !== null) return;

    const body = normaliseMessageBody(draft);
    const messageId = makeActionId();
    const optimistic: Message = {
      message_id: messageId,
      group_id: gid,
      sender_id: userId,
      body,
      kind: 'text',
      session_id: null,
      material_id: null,
      // The device clock, replaced by the server's when the echo lands. Good
      // enough to place the bubble at the bottom, which is where it goes.
      created_at: new Date().toISOString(),
      deleted_at: null,
    };

    setDraft('');
    setActionError(null);
    setStatus(null);
    mergeLocal([optimistic]);
    setSending(true);

    const queueIt = async () => {
      await enqueue(
        'chat.send',
        { group_id: gid, message_id: messageId, body },
        userId
      );
      await refreshPending();
    };

    try {
      if (isOnline) {
        await sendMessage({ groupId: gid, messageId, body });
      } else {
        await queueIt();
      }
    } catch (err) {
      try {
        await queueIt();
      } catch {
        setActionError(friendlyError(err));
      }
    } finally {
      setSending(false);
    }
  }

  /**
   * Propose a study time. Both ids are generated here, as with a message.
   *
   * Offline, the message row is merged in and the SESSION ROW IS NOT: the tally,
   * the threshold and `members_counted` are computed server-side against members
   * enrolled in the group's course, and a card built from anything else would
   * name a rule the confirmation trigger is not applying. `renderKind` falls back
   * to a plain bubble for a session message whose row has not arrived, and the
   * body is exactly what `propose_session` will write — so nothing on screen
   * changes wording when the real row lands.
   */
  async function handlePropose(input: ProposalInput) {
    if (!userId || !gid) return;

    const sessionId = makeActionId();
    const messageId = makeActionId();
    const when = sessionWhenLabel(input.startsAt, input.durationMin);

    setActionError(null);
    setStatus(null);
    setProposing(true);

    const queueIt = async () => {
      await enqueue(
        'session.propose',
        {
          group_id: gid,
          session_id: sessionId,
          message_id: messageId,
          starts_at: input.startsAt,
          duration_min: input.durationMin,
          location: input.location,
          note: input.note,
        },
        userId
      );
      await refreshPending();
      mergeLocal([
        {
          message_id: messageId,
          group_id: gid,
          sender_id: userId,
          body: input.note ?? 'Proposed a study session',
          kind: 'session',
          session_id: sessionId,
          material_id: null,
          created_at: new Date().toISOString(),
          deleted_at: null,
        },
      ]);
      setStatus(
        `Saved — “${when}” reaches the group when you are back online. If that ` +
          'time has passed by then, it cannot be sent.'
      );
    };

    try {
      if (isOnline) {
        await proposeSession({
          groupId: gid,
          sessionId,
          messageId,
          startsAt: input.startsAt,
          durationMin: input.durationMin,
          location: input.location,
          note: input.note,
        });
        await refreshCards();
      } else {
        await queueIt();
      }
      setSheetOpen(false);
    } catch (err) {
      try {
        await queueIt();
        setSheetOpen(false);
      } catch {
        setActionError(friendlyError(err));
      }
    } finally {
      setProposing(false);
    }
  }

  /** Last-write-wins on one row, so this queues like a message. */
  async function handleRespond(
    session: GroupSessionRow,
    response: SessionResponseValue
  ) {
    if (!userId) return;
    setActionError(null);
    setStatus(null);
    setBusy({ id: session.session_id, key: response });

    const queueIt = async () => {
      await enqueue(
        'session.respond',
        { session_id: session.session_id, response },
        userId
      );
      await refreshPending();
    };

    /**
     * The only place in the app that asks for notification permission, and only
     * on "yes" — the one tap that means "I am going to this", which is when a
     * student expects to be asked about being reminded. Awaited before the RPC so
     * the system dialog is not competing with a card that has already changed,
     * and deliberately not blocking: a refusal must still record the RSVP.
     */
    if (response === 'yes') {
      try {
        await askAboutReminders();
      } catch {
        /* No permission, no alarm. The RSVP is the point of this tap. */
      }
    }

    try {
      if (isOnline) {
        await respondToSession(session.session_id, response);
        // The trigger may have flipped the status as a result, so the card is
        // refetched rather than patched: the server owns every number on it.
        await refreshCards();
        // And if it did flip, this phone is now owed an alarm it does not hold.
        void refreshReminders(userId);
      } else {
        await queueIt();
      }
    } catch (err) {
      try {
        await queueIt();
      } catch {
        setActionError(friendlyError(err));
      }
    } finally {
      setBusy(null);
    }
  }

  /** Online-only, and not queued: see the header. */
  async function handleCancel(session: GroupSessionRow) {
    setActionError(null);
    setStatus(null);
    setBusy({ id: session.session_id, key: 'cancel' });
    try {
      await cancelSession(session.session_id);
      await refreshCards();
      // The alarm has to go with it, or the group is called to a meeting that
      // is off. Every other member's phone drops it on its next reconcile.
      if (userId) void refreshReminders(userId);
      setStatus('Called off. The group sees it on the card.');
    } catch (err) {
      setActionError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  /** Online-only too — the row stays, the text goes, and it goes for everybody. */
  async function handleDelete(message: Message) {
    setActionError(null);
    setStatus(null);
    setDeleting(message.message_id);
    try {
      await deleteMyMessage(message.message_id);
      // The soft delete arrives as an UPDATE on the live channel, so there is
      // nothing to merge here — the tombstone lands on its own.
      setConfirmDelete(null);
    } catch (err) {
      setActionError(friendlyError(err));
    } finally {
      setDeleting(null);
    }
  }

  /**
   * Share a file: check the note, pick the file, upload the bytes, then put the
   * card on the timeline.
   *
   * THE ONLY WRITE HERE WITH NO OPTIMISTIC ROW AHEAD OF IT. A message bubble
   * appears instantly because a queued message is genuinely as good as a sent one;
   * an upload is not. Twenty-five megabytes over hostel wifi takes as long as it
   * takes, and a card that appeared immediately would be claiming the group can
   * already download something that is still going up. So the status line says
   * what is happening and the card arrives when the bytes have.
   *
   * The row is merged in afterwards anyway, rather than left to Realtime. The
   * INSERT does come over the socket — that is how the other members get it — but
   * a channel that dropped during a long upload would leave the sharer looking at
   * a conversation missing the file they just shared. `refreshCards` runs first so
   * the `materials` row is in hand and it renders as a card rather than flickering
   * through the bubble fallback.
   *
   * WHAT YOU HAVE TYPED BECOMES THE NOTE, which the ＋ menu says before you tap.
   * It is checked here rather than after the picker for the obvious reason: being
   * told the message is too long is much less annoying before choosing a file than
   * after. An empty field simply means no note, and `attach_material` writes
   * "Shared <name>" instead — `sharedFileBody` is that default, mirrored so the
   * row merged in below reads exactly as the one Postgres wrote.
   */
  async function handleShareFile() {
    if (!userId || !gid) return;
    setActionError(null);
    setStatus(null);

    const typed = normaliseMessageBody(draft);
    const noteProblem = typed === '' ? null : validateMessageBody(draft);
    if (noteProblem !== null) {
      setActionError(
        `${noteProblem}. Shorten it, or clear the field to share the file on its own.`
      );
      return;
    }
    const note = typed === '' ? null : typed;

    const picked = await pickMaterial();
    if (picked.status === 'cancelled') return;
    if (picked.status === 'refused') {
      setActionError(picked.reason);
      return;
    }

    const { fileName, mimeType, sizeBytes, body } = picked.file;
    const materialId = makeActionId();
    const messageId = makeActionId();

    setSharing(true);
    setStatus(`Uploading ${fileName}…`);
    try {
      await shareFile({
        groupId: gid,
        materialId,
        messageId,
        fileName,
        mimeType,
        sizeBytes,
        body,
        note,
      });
      await refreshCards();
      mergeLocal([
        {
          message_id: messageId,
          group_id: gid,
          sender_id: userId,
          body: sharedFileBody(note, fileName),
          kind: 'file',
          session_id: null,
          material_id: materialId,
          // The device clock, replaced by the server's when the echo lands.
          created_at: new Date().toISOString(),
          deleted_at: null,
        },
      ]);
      setDraft('');
      setStatus(`Shared ${fileName}.`);
    } catch (err) {
      // `shareFile` has already taken the bytes back out if nothing claims them,
      // so there is no half-shared file to explain — just a failure.
      setStatus(null);
      setActionError(friendlyError(err));
    } finally {
      setSharing(false);
    }
  }

  /**
   * Sign a URL and hand it to the OS.
   *
   * Signed at tap time and never cached: sixty seconds is long enough for the
   * browser to start and short enough that a link which leaks is already dead.
   * Signing is itself gated by the Storage read policy, so a file removed while
   * this screen was open refuses here rather than downloading.
   *
   * What happens next is the OS handler's business, and that is the point — a
   * PDF opens in a viewer, a zip lands in Downloads. This app has no business
   * reimplementing either.
   */
  async function handleDownload(material: GroupMaterialRow) {
    setActionError(null);
    setStatus(null);
    setBusy({ id: material.material_id, key: 'download' });
    try {
      const url = await materialDownloadUrl(material.storage_path);
      await Linking.openURL(url);
    } catch (err) {
      setActionError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Remove a shared file. Bytes first, then the row — `removeFile` holds that
   * order and says why at length.
   *
   * `refreshCards` is not optional here. This screen subscribes to `messages` and
   * nothing else, and a removal writes no message — so without the refetch the
   * card would keep offering a Download that now signs nothing.
   */
  async function handleRemove(material: GroupMaterialRow) {
    setActionError(null);
    setStatus(null);
    setBusy({ id: material.material_id, key: 'remove' });
    try {
      await removeFile(material.material_id, material.storage_path);
      await refreshCards();
      setStatus(`Removed ${material.file_name}. The group cannot download it now.`);
    } catch (err) {
      setActionError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Rendering                                                                */
  /* ----------------------------------------------------------------------- */

  const renderItem = ({ item }: { item: TimelineItem }) => {
    if (item.type === 'day') {
      return (
        <View style={styles.day}>
          <Text style={styles.dayText}>{item.label}</Text>
        </View>
      );
    }

    const message = item.message;
    const session =
      item.kind === 'session' && message.session_id
        ? sessions[message.session_id]
        : undefined;

    if (session) {
      const open = openSessionId === session.session_id;
      return (
        <SessionCard
          session={session}
          proposerName={
            (session.proposer_name ?? '').trim() ||
            // The card renders this as "Proposed by …", so the roster's "You"
            // needs lowercasing on the way through.
            (session.proposed_by === userId ? 'you' : nameFor(session.proposed_by))
          }
          canCancel={canCancelSession(session, userId, creator)}
          // Answering queues, so there is nothing to disable here — the card
          // spins whichever chip is in flight and blocks the rest itself.
          respondDisabled={false}
          cancelDisabled={!isOnline}
          busy={busy?.id === session.session_id ? busy.key : null}
          queuedResponse={queuedResponses[session.session_id] ?? null}
          attendeesOpen={open}
          attendees={open ? attendees : NO_ATTENDEES}
          attendeesLoading={open && attendeesLoading}
          onToggleAttendees={() =>
            setOpenSessionId(open ? null : session.session_id)
          }
          onRespond={(response) => void handleRespond(session, response)}
          onCancel={() => void handleCancel(session)}
        />
      );
    }

    /**
     * A shared file, when its `materials` row is in hand.
     *
     * `uploader_name` comes from the RPC because `group_materials` is a definer
     * function; the roster is the fallback for the one case it cannot cover, a
     * member who has since left. "Removed by" goes through a lowercasing wrapper
     * for the same reason `SessionCard`'s proposer does — the roster answers "You",
     * and the card renders it mid-sentence.
     */
    const material =
      item.kind === 'file' && message.material_id
        ? materials[message.material_id]
        : undefined;

    if (material) {
      return (
        <FileCard
          material={material}
          uploaderName={
            (material.uploader_name ?? '').trim() || nameFor(material.uploaded_by)
          }
          isMine={material.uploaded_by === userId}
          note={materialNote(message.body, material.file_name)}
          removedLabel={materialStateLabel(material, (id) =>
            id === userId ? 'you' : nameFor(id)
          )}
          time={formatClock(message.created_at)}
          canRemove={canDeleteMaterial(material, userId, creator)}
          downloadable={canDownloadMaterial(material)}
          actionsDisabled={!isOnline}
          busy={busy?.id === material.material_id ? busy.key : null}
          onDownload={() => void handleDownload(material)}
          onRemove={() => void handleRemove(material)}
        />
      );
    }

    /**
     * Everything else is a bubble. That includes a `session` or `file` message
     * whose row has not arrived yet, which is exactly what `renderKind`'s fallback
     * is for: `body` carries a readable sentence about either.
     *
     * `deletable` gates the open confirm as well as the long press: going offline
     * with one open would otherwise leave a Delete button that can only fail.
     */
    const deletable = canDeleteMessage(message, userId) && isOnline;
    return (
      <MessageBubble
        item={item}
        senderName={nameFor(message.sender_id)}
        onLongPress={
          deletable ? () => setConfirmDelete(message.message_id) : undefined
        }
        confirming={deletable && confirmDelete === message.message_id}
        onDelete={() => void handleDelete(message)}
        onKeep={() => setConfirmDelete(null)}
        deleting={deleting === message.message_id}
      />
    );
  };

  return (
    <Screen
      scroll={false}
      contentStyle={styles.content}
      footerStyle={styles.footerFlush}
      footer={
        sheetOpen ? (
          <ProposeTimeSheet
            onSubmit={(input) => void handlePropose(input)}
            onCancel={() => setSheetOpen(false)}
            submitting={proposing}
            isOnline={isOnline}
          />
        ) : (
          <Composer
            value={draft}
            onChangeText={setDraft}
            onSend={() => void handleSend()}
            onProposeTime={() => setSheetOpen(true)}
            onShareFile={() => void handleShareFile()}
            sending={sending}
            isOnline={isOnline}
            shareDisabled={!isOnline || sharing}
          />
        )
      }
    >
      <View style={styles.header}>
        <RoundButton icon="chevron-left" label="Back" onPress={() => router.back()} />
        <Initials
          text={courseTag(group?.course?.course_code)}
          colorKey={group?.group_id ?? gid}
          size={38}
        />
        <View style={styles.headerText}>
          <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">
            {group?.group_name ?? 'Conversation'}
          </Text>
          <Text style={styles.headerMeta} numberOfLines={1}>
            {group?.course?.course_code ? `${group.course.course_code} · ` : ''}
            {members.length} {members.length === 1 ? 'member' : 'members'}
          </Text>
        </View>
        {/*
          The second place a file can be reached from, and the one that matters
          most: files are shared here, so "where did that PDF go" is asked here.
        */}
        {!!gid && (
          <RoundButton
            icon="folder"
            label="Shared files"
            onPress={() => router.push(`/(app)/groups/${gid}/files`)}
          />
        )}
      </View>

      {/* The conversation sits on a white sheet with a rounded top, under the header. */}
      <View style={styles.sheet}>
      {(!!actionError || !!status) && (
        <View style={styles.banner}>
          <Text
            style={actionError ? styles.bannerError : styles.bannerStatus}
            accessibilityLiveRegion="polite"
          >
            {actionError ?? status}
          </Text>
        </View>
      )}

      {loading && messages.length === 0 ? (
        <ActivityIndicator color={colors.primaryDark} style={styles.loader} />
      ) : timeline.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {error ??
              'Nothing here yet. Say hello, propose a time to study together, or share the notes — whatever the group agrees on becomes a card everybody can answer.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={timeline}
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          // Newest at the bottom, which is what the timeline is built for: index
          // 0 sits at the bottom of the screen, so a day separator is emitted
          // after the messages it labels and appears above them.
          inverted
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          // Inverted, so the "end" is the top — where older messages belong.
          onEndReached={() => void loadOlder()}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingOlder ? (
              <ActivityIndicator color={colors.primaryDark} style={styles.older} />
            ) : !hasMore && messages.length > 0 ? (
              <Text style={styles.start}>The beginning of this conversation</Text>
            ) : null
          }
        />
      )}
      </View>
    </Screen>
  );
}

/** Stable identity, so a card that is not the open one does not re-render. */
const NO_ATTENDEES: SessionAttendeeRow[] = [];

const styles = StyleSheet.create({
  content: { padding: 0, paddingBottom: 0 },
  footerFlush: { padding: 0, borderTopWidth: 0 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  headerText: { flex: 1, minWidth: 0 },
  headerTitle: { fontSize: fontSize.md + 1, fontFamily: FONT.bold, color: colors.text },
  headerMeta: { fontSize: fontSize.xs, fontFamily: FONT.regular, color: colors.textMuted, marginTop: 2 },
  sheet: {
    flex: 1,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    overflow: 'hidden',
  },
  banner: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.surface,
  },
  bannerError: { fontSize: fontSize.xs, color: colors.danger, lineHeight: 18 },
  bannerStatus: { fontSize: fontSize.xs, color: colors.text, lineHeight: 18 },
  loader: { marginVertical: spacing.xl },
  empty: { flex: 1, justifyContent: 'center', padding: spacing.xl },
  emptyText: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    lineHeight: 20,
    textAlign: 'center',
  },
  list: { paddingHorizontal: spacing.md + 2, paddingVertical: spacing.md },
  day: { alignItems: 'center', marginVertical: spacing.md },
  dayText: {
    fontSize: fontSize.xs,
    fontFamily: FONT.semi,
    color: colors.textMuted,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  older: { marginVertical: spacing.md },
  start: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    textAlign: 'center',
    marginVertical: spacing.md,
  },
});
