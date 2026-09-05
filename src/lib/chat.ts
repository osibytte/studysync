import { materialStoragePath } from './chatRules';
import type { MessageCursor } from './chatRules';
import { makeActionId } from './ids';
import { supabase } from './supabase';
import { MATERIALS_BUCKET } from '@/types/database';
import type {
  GroupMaterialRow,
  GroupSessionRow,
  Message,
  SessionAttendeeRow,
  SessionResponseValue,
  SessionStatus,
  UnreadCountRow,
} from '@/types/database';

/**
 * Typed wrappers over the Stage 3 and Stage 4 timeline RPCs (migrations
 * 0013–0018), plus the two Storage handshakes a shared file needs.
 *
 * This exists for the same three reasons groups.ts does — one place that names
 * `p_client_action_id`, one place where an argument name can be misspelled into
 * a runtime 404, and errors that throw rather than hide in a `{ data, error }`
 * nobody checked — so those notes are not repeated here. Two things are new:
 *
 *   Reads split across two mechanisms deliberately. `messages` is queried
 *   straight through PostgREST because its RLS SELECT policy is what Realtime
 *   re-evaluates for every subscriber (0014's header); a definer function would
 *   leave the live subscription with no policy to consult. Sessions, files and
 *   badges are definer RPCs, because they resolve other students' names and
 *   `public.users` is own-row-only.
 *
 *   Two functions are not single calls. Sharing a file and removing one each
 *   touch Storage AND Postgres, and the order is load-bearing in opposite
 *   directions. They are the only functions here with any logic in them, and
 *   both say why at length.
 *
 * Offline: `sendMessage`, `proposeSession` and `respondToSession` take an
 * optional `clientActionId` so the outbox can replay them under the id they were
 * queued with. `markGroupRead` is never queued, and cancelling a session or
 * touching a file is online-only (§8 of HANDOFF.md gives the reasoning for each).
 */

/**
 * Thrown for a failed RPC. Screens map it with friendlyError().
 *
 * Deliberately a second copy of groups.ts's helper rather than an import: four
 * lines with no behaviour to drift, and the alternative is two sibling wrapper
 * modules importing each other for it.
 */
function unwrap<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw result.error;
  return result.data;
}

// ---------------------------------------------------------------------------
// Messages — writes
// ---------------------------------------------------------------------------

export interface SendMessageArgs {
  groupId: string;
  /** Generated on the device, so the optimistic bubble and its row are one thing. */
  messageId: string;
  body: string;
  /** Supplied when replaying a queued action, so the replay is idempotent. */
  clientActionId?: string;
}

/**
 * Post a text message to a group you belong to. Returns the message id.
 *
 * The same id on a replay, which is where this differs from the Stage 2 RPCs:
 * they return null when the ledger says the action already ran, because a
 * server-generated id they no longer hold is nothing truthful to return. Here
 * the id came from the device, so it is the answer either way (0014) and the
 * outbox never has to work out which attempt won.
 *
 * `dormant` groups accept messages — a message is exactly what should wake a
 * quiet group up, and the RPC flips it back to active.
 */
export async function sendMessage(args: SendMessageArgs): Promise<string> {
  return unwrap(
    await supabase.rpc('send_message', {
      p_client_action_id: args.clientActionId ?? makeActionId(),
      p_message_id: args.messageId,
      p_group_id: args.groupId,
      p_body: args.body,
    })
  );
}

/**
 * Move your read cursor for one group to now; returns where it landed.
 *
 * Never queued offline. The RPC clamps with `greatest(last_read_at, now())` so
 * the cursor cannot go backwards, but a cursor replayed on reconnect is wrong in
 * the other direction — it would mark as read everything that arrived while the
 * device was away. Called on mount and on focus, so it is also the one write
 * here that runs without the student asking for it.
 */
export async function markGroupRead(groupId: string): Promise<string> {
  return unwrap(await supabase.rpc('mark_group_read', { p_group_id: groupId }));
}

/**
 * Soft-delete one of your own messages, blanking its text server-side.
 *
 * Idempotent (0014), so a double tap on a slow connection is not an error. The
 * row survives with `deleted_at` set, which is what keeps the transcript's shape
 * and the page cursor stable — the client renders `deletedMessageText()` in place.
 */
export async function deleteMyMessage(messageId: string): Promise<void> {
  unwrap(await supabase.rpc('delete_my_message', { p_message_id: messageId }));
}

// ---------------------------------------------------------------------------
// Messages — reads
// ---------------------------------------------------------------------------

/** A screenful and a bit on a phone, and small enough to be cheap on hostel wifi. */
export const MESSAGE_PAGE_SIZE = 30;

/**
 * Named rather than `*` so a column added to `messages` later is not silently
 * shipped to every device — and so this list can be compared against `Message`.
 */
const MESSAGE_COLUMNS =
  'message_id, group_id, sender_id, body, kind, session_id, material_id, created_at, deleted_at';

/**
 * One page of a group's timeline, newest first. Pass the cursor from
 * `nextPageCursor()` to get the page before it.
 *
 * THE FILTER NAMES BOTH INDEX COLUMNS, and that is the part to keep. `created_at`
 * is not unique: `now()` is fixed for a whole transaction, so `propose_session`'s
 * session card and any rows a seed writes together share an instant exactly, and
 * two concurrent transactions can coincide at microsecond resolution anyway. A
 * one-column `.lt('created_at', cursor)` would skip every row sharing the
 * boundary instant, and a row skipped that way appears in NEITHER page — an
 * invisible hole that reads as "nothing was said".
 *
 * PostgREST ANDs `.or()` with the other filters, so what runs is
 * `group_id = $1 and (created_at < $2 or (created_at = $2 and message_id < $3))`
 * ordered `created_at desc, message_id desc` — which is exactly the shape of
 * 0013's `(group_id, created_at desc, message_id desc)` index.
 *
 * Deleted messages are included, with a blanked body and `deleted_at` set. The
 * screen shows "message deleted" in place rather than losing a row out of the
 * middle of a conversation.
 */
export async function fetchMessages(
  groupId: string,
  before?: MessageCursor | null
): Promise<Message[]> {
  let query = supabase
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .order('message_id', { ascending: false })
    .limit(MESSAGE_PAGE_SIZE);

  if (before) {
    // Values are unquoted: neither a timestamptz rendering nor a uuid can hold
    // one of PostgREST's reserved characters, and the '+' of a UTC offset
    // survives because supabase-js encodes the query string for us.
    query = query.or(
      `created_at.lt.${before.created_at},` +
        `and(created_at.eq.${before.created_at},message_id.lt.${before.message_id})`
    );
  }

  const data = unwrap(await query);
  return (data ?? []) as Message[];
}

/**
 * Every unread badge in the app, in one round trip (0014).
 *
 * Own messages never count — you have not "not read" something you typed — and
 * the preview is the newest message that has not been deleted, so deleting the
 * last thing you said reveals the one before it rather than blanking the row.
 */
export async function unreadCounts(): Promise<UnreadCountRow[]> {
  const data = unwrap(await supabase.rpc('my_unread_counts', {}));
  return (data ?? []) as UnreadCountRow[];
}

// ---------------------------------------------------------------------------
// Study times — writes. Proposed, agreed and managed from the chat itself;
// there is no separate sessions screen.
// ---------------------------------------------------------------------------

export interface ProposeSessionArgs {
  groupId: string;
  /** Client-generated, like messageId: the card and the row are one object. */
  sessionId: string;
  messageId: string;
  /** ISO instant, in the future — the RPC refuses the past. */
  startsAt: string;
  /** 15–480 minutes. Check with validateSessionProposal() before calling. */
  durationMin: number;
  /** A room, someone's flat, a meeting link. Null for unspecified. */
  location?: string | null;
  /** What the proposer typed; becomes the message body, or a default sentence. */
  note?: string | null;
  clientActionId?: string;
}

/**
 * Propose a study time. Returns the session id, on a replay too.
 *
 * One call writes three rows (0016): the session, the timeline message that
 * renders as its card, and the proposer's own `yes`. That third one is not a
 * convenience — a proposal whose proposer has not said they are coming reads as
 * an invitation from nobody, and in a one-member group it is what confirms the
 * session immediately, correctly.
 */
export async function proposeSession(args: ProposeSessionArgs): Promise<string> {
  return unwrap(
    await supabase.rpc('propose_session', {
      p_client_action_id: args.clientActionId ?? makeActionId(),
      p_session_id: args.sessionId,
      p_message_id: args.messageId,
      p_group_id: args.groupId,
      p_starts_at: args.startsAt,
      p_duration_min: args.durationMin,
      p_location: args.location ?? null,
      p_note: args.note ?? null,
    })
  );
}

/**
 * Say yes, no or maybe, changeable until the session starts.
 *
 * Returns the status AFTER the write, which the confirmation trigger may just
 * have changed: a yes that reaches the threshold flips `proposed` to `confirmed`
 * in the same transaction, and the caller learns that from the return value
 * instead of re-reading the card.
 *
 * Takes a queued id even though 0016's header calls this online-only — §8
 * revisits that: an RSVP is last-write-wins on one `(session_id, user_id)` row
 * and hands out nothing finite, so queueing it is safe, and the server refuses
 * one that arrives after the session has started rather than recording it late.
 */
export async function respondToSession(
  sessionId: string,
  response: SessionResponseValue,
  clientActionId?: string
): Promise<SessionStatus> {
  return unwrap(
    await supabase.rpc('respond_to_session', {
      p_client_action_id: clientActionId ?? makeActionId(),
      p_session_id: sessionId,
      p_response: response,
    })
  ) as SessionStatus;
}

/**
 * Cancel a session. Whoever proposed it, or the group's creator (0016).
 *
 * Online-only, so no queued id: this is the one action here that other people
 * act on ("the meeting is off"), and a cancel that lands an hour late, after
 * everybody has travelled, is worse than one that refused to be queued.
 * Idempotent, and it posts no message — the existing card reads as cancelled.
 */
export async function cancelSession(sessionId: string): Promise<void> {
  unwrap(
    await supabase.rpc('cancel_session', {
      p_client_action_id: makeActionId(),
      p_session_id: sessionId,
    })
  );
}

// ---------------------------------------------------------------------------
// Study times — reads
// ---------------------------------------------------------------------------

/**
 * Sessions for a group, oldest start first, with the tally already computed.
 *
 * Defaults to what has not finished happening yet — the RPC keeps anything
 * starting more than an hour ago out, so a session you are sitting in does not
 * vanish off the screen. Pass `includePast` for the history.
 *
 * `confirm_threshold` and `members_counted` come back per row and must be
 * rendered, not re-derived: the rule is everybody below four members and a
 * majority at four or more (0012), and `members_counted` counts members enrolled
 * in the group's COURSE, which the client cannot see.
 */
export async function groupSessions(
  groupId: string,
  includePast = false
): Promise<GroupSessionRow[]> {
  const data = unwrap(
    await supabase.rpc('group_sessions', {
      p_group_id: groupId,
      p_include_past: includePast,
    })
  );
  return (data ?? []) as GroupSessionRow[];
}

/**
 * Who is coming, for the sheet behind a session card.
 *
 * The whole roster, not just the people who answered: a member who has said
 * nothing comes back with `response` null, which is what makes "waiting on Ada"
 * renderable. "Three of five answered" is the interesting fact, and a query that
 * returned only the three could not tell you that.
 */
export async function sessionAttendees(
  sessionId: string
): Promise<SessionAttendeeRow[]> {
  const data = unwrap(
    await supabase.rpc('session_attendees', { p_session_id: sessionId })
  );
  return (data ?? []) as SessionAttendeeRow[];
}

// ---------------------------------------------------------------------------
// Shared files — [Stage 4]. The bytes live in the private `group-materials`
// bucket; Postgres holds only the row that claims a path (0017, 0018).
// ---------------------------------------------------------------------------

/**
 * Files shared in a group, newest first.
 *
 * Removed files are included by default and come back with `deleted_at` set, so
 * the files tab can say "removed by Ada" instead of quietly losing a row
 * somebody is looking for. Pass false for the live-only list.
 */
export async function groupMaterials(
  groupId: string,
  includeDeleted = true
): Promise<GroupMaterialRow[]> {
  const data = unwrap(
    await supabase.rpc('group_materials', {
      p_group_id: groupId,
      p_include_deleted: includeDeleted,
    })
  );
  return (data ?? []) as GroupMaterialRow[];
}

/**
 * The bytes to upload, in whatever form the picker layer produced them. Storage
 * accepts all of these; in Expo the practical two are a `FormData` holding
 * `{ uri, name, type }` and an `ArrayBuffer` decoded from base64.
 */
export type UploadBody = ArrayBuffer | ArrayBufferView | Blob | FormData;

export interface ShareFileArgs {
  groupId: string;
  /** Client-generated: it is half of the storage path, so it exists before the upload. */
  materialId: string;
  messageId: string;
  fileName: string;
  mimeType: string;
  /** Real byte length. Check with validateUpload() before spending the upload. */
  sizeBytes: number;
  body: UploadBody;
  /** What the sharer typed; becomes the message body, or "Shared <name>". */
  note?: string | null;
}

/**
 * Upload a file, then put it on the timeline. Returns the id and the path.
 *
 * BYTES FIRST, ROW SECOND, and it has to be that way round: `attach_material`
 * records a path, and a row pointing at bytes that never arrived is a card that
 * downloads nothing. The path is decided before either step because the path IS
 * the permission — Storage's INSERT policy reads its first folder to decide
 * whether you may write, and the RPC refuses any path not beginning with
 * `<group>/<material>/` (0017). That is what stops a member registering a row
 * that points into another group's folder.
 *
 * `upsert: false` on purpose: a path collision means somebody else's bytes are
 * already there, which should surface rather than overwrite. It cannot happen
 * from a retry, because a retry generates a fresh material id.
 *
 * IF THE RPC FAILS, the bytes are removed again — 0018's second policy branch
 * exists for exactly this window, where an object nobody has claimed yet belongs
 * to whoever uploaded it. But a failed RPC does not always mean a failed write:
 * a request that committed and then lost its response looks identical from here,
 * and rolling that one back would strand a live row pointing at deleted bytes.
 * So the row is read back first (members may select `materials` directly, 0017),
 * and the bytes are only removed if nothing claims them.
 */
export async function shareFile(
  args: ShareFileArgs
): Promise<{ materialId: string; storagePath: string }> {
  const storagePath = materialStoragePath(
    args.groupId,
    args.materialId,
    args.fileName
  );

  const upload = await supabase.storage
    .from(MATERIALS_BUCKET)
    .upload(storagePath, args.body, {
      contentType: args.mimeType,
      upsert: false,
    });
  if (upload.error) throw upload.error;

  try {
    unwrap(
      await supabase.rpc('attach_material', {
        p_client_action_id: makeActionId(),
        p_material_id: args.materialId,
        p_message_id: args.messageId,
        p_group_id: args.groupId,
        p_storage_path: storagePath,
        p_file_name: args.fileName,
        p_mime_type: args.mimeType,
        p_size_bytes: args.sizeBytes,
        p_note: args.note ?? null,
      })
    );
  } catch (error) {
    if (!(await materialRowExists(args.materialId))) {
      await removeObjects([storagePath]);
    }
    throw error;
  }

  return { materialId: args.materialId, storagePath };
}

/**
 * Does a `materials` row claim this id? Used only to tell a genuinely failed
 * `attach_material` from one whose response was lost.
 *
 * Answers true when it cannot tell (offline, most likely). Keeping bytes that may
 * be litter is recoverable by a sweep; deleting bytes that a live row points at
 * is not recoverable at all.
 */
async function materialRowExists(materialId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('materials')
    .select('material_id')
    .eq('material_id', materialId)
    .maybeSingle();
  if (error) return true;
  return data != null;
}

/**
 * Best-effort byte removal. Never throws: this only runs while unwinding a
 * failure, and the error the student must see is the one that got them here.
 */
async function removeObjects(paths: string[]): Promise<void> {
  try {
    await supabase.storage.from(MATERIALS_BUCKET).remove(paths);
  } catch {
    // Nothing further to try. The object becomes litter that only a service_role
    // sweep can reach, which is the price of not masking the real failure.
  }
}

/**
 * Remove a shared file: bytes first, then the row. Uploader or group creator.
 *
 * THE ORDER IS THE OPPOSITE OF SHARING, and it is not a preference. Storage's
 * read policy asks the `materials` row, so the instant `delete_material` stamps
 * `deleted_at` the download is revoked for everybody — the uploader included —
 * and the Storage API, which reads an object before deleting it, can no longer
 * reach the bytes to clean them up. After that only a service_role sweep could.
 *
 * A removal that succeeds but deletes nothing is not a failure: it means the
 * object was already gone (a retry whose first half landed), and the row still
 * has to be marked removed. Only a real Storage error stops us, because
 * proceeding then would leave the bytes behind a row that says they are gone.
 */
export async function removeFile(
  materialId: string,
  storagePath: string
): Promise<void> {
  const removal = await supabase.storage
    .from(MATERIALS_BUCKET)
    .remove([storagePath]);
  if (removal.error) throw removal.error;

  unwrap(
    await supabase.rpc('delete_material', {
      p_client_action_id: makeActionId(),
      p_material_id: materialId,
    })
  );
}

/**
 * A short-lived signed URL for one file. Sign at tap time; never cache one.
 *
 * The bucket is private, so this is the only way to the bytes, and signing is
 * itself gated by the Storage read policy (0018): a member of the file's group
 * gets a URL, and somebody who has left the group — or whose group had the file
 * removed — gets a refusal instead. Sixty seconds is long enough to hand to the
 * OS downloader and short enough that a link pasted somewhere is already dead.
 */
export async function materialDownloadUrl(
  storagePath: string,
  expiresInSeconds = 60
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(MATERIALS_BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds);
  if (error) throw error;
  if (!data?.signedUrl) {
    throw new Error('That file could not be opened. Please try again.');
  }
  return data.signedUrl;
}
