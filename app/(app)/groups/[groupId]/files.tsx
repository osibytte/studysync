import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/Button';
import { FileCard } from '@/components/FileCard';
import { Screen } from '@/components/Screen';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { useGroupDetail } from '@/hooks/useGroupDetail';
import { useMaterials } from '@/hooks/useMaterials';
import { materialDownloadUrl, removeFile } from '@/lib/chat';
import {
  canDeleteMaterial,
  canDownloadMaterial,
  formatFileSize,
  materialStateLabel,
  materialWhenLabel,
} from '@/lib/chatRules';
import { displayName, isCreator } from '@/lib/groupRules';
import { friendlyError } from '@/lib/supabase';
import { FONT, colors, fontSize, spacing } from '@/theme';
import type { GroupMaterialRow } from '@/types/database';

/**
 * Everything a group has shared, newest first — the library behind the chat.
 *
 * The timeline is where a file is shared and where the note about it lives, and
 * that is deliberately not repeated here. What the timeline cannot do is answer
 * "where are the slides from three weeks ago", because by then the file is
 * hundreds of messages back. This screen is that answer, and nothing more: the
 * same `FileCard`, the same two actions, in one flat list.
 *
 * REMOVED FILES STAY IN THE LIST, marked. `group_materials` returns them on
 * purpose (0017), and a student who remembers a file being shared is better
 * served by "Removed by Ada" than by an empty space where they are sure it was.
 *
 * BOTH ACTIONS ARE ONLINE-ONLY, for the reason the chat screen gives at length:
 * the outbox stores JSON in AsyncStorage, so an upload's bytes have nowhere to
 * wait, and a removal must take the bytes out of the bucket before the row may be
 * stamped (invariant 8) — an order no queue can honour. The list itself is
 * cached, so it reads offline; the cards say why their buttons are down.
 *
 * Sharing is not here either. What you have typed in the composer becomes the
 * note on a file, so the ＋ that shares one belongs beside the field it reads —
 * this screen has no field, and a second upload path with no note would be the
 * more confusing of the two.
 */
export default function GroupFilesScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { profile } = useAuth();
  const { isOnline } = useNetwork();
  const router = useRouter();

  const userId = profile?.user_id ?? null;
  const gid = groupId ?? null;

  // The roster and the caller's role, for the same two jobs as in the chat: a
  // name for an uploader `group_materials` could not resolve, and whether this
  // student is the creator, which `canDeleteMaterial` needs.
  const { group, members, role } = useGroupDetail(userId, gid);
  const { materials, loading, error, reload } = useMaterials(userId, gid);

  /** `{ id, key }`, so only the pressed control on the pressed card spins. */
  const [busy, setBusy] = useState<{ id: string; key: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  /**
   * Refetch on every return to this screen but the first, which the hook has
   * already covered.
   *
   * This is the whole of the screen's liveness, and it is enough: it catches a
   * file somebody else shared or removed while the tab was in the background,
   * and it catches the OS download handler handing control back.
   */
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void reload();
    }, [reload])
  );

  const nameFor = useCallback(
    (id: string): string => {
      if (userId && id === userId) return 'You';
      const member = members.find((m) => m.user_id === id);
      return member ? displayName(member.full_name) : 'A member';
    },
    [members, userId]
  );

  /**
   * Sign a URL and hand it to the OS — the same two lines as the chat's card,
   * for the same reasons. Signed at tap time and never cached, so a file removed
   * while this list was on screen refuses here instead of downloading, and what
   * happens to the bytes afterwards is the OS handler's business.
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
   * Remove a file: bytes first, then the row. `removeFile` holds that order and
   * explains it; invariant 8 is why it cannot be the other way round.
   *
   * The reload is not cosmetic. Nothing here is subscribed to anything, so
   * without it the card would keep offering a Download that now signs nothing.
   */
  async function handleRemove(material: GroupMaterialRow) {
    setActionError(null);
    setStatus(null);
    setBusy({ id: material.material_id, key: 'remove' });
    try {
      await removeFile(material.material_id, material.storage_path);
      await reload();
      setStatus(`Removed ${material.file_name}. The group cannot download it now.`);
    } catch (err) {
      setActionError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  const creator = isCreator(role);
  /** `canDownloadMaterial` IS "still there", so it is also the live filter. */
  const live = materials.filter((row) => canDownloadMaterial(row));
  const removedCount = materials.length - live.length;
  const totalBytes = live.reduce((sum, row) => sum + row.size_bytes, 0);

  return (
    <Screen
      title="Shared files"
      subtitle={
        group?.group_name
          ? `Everything shared in ${group.group_name}.`
          : 'Everything this group has shared.'
      }
      footer={<Button label="Back" variant="secondary" onPress={() => router.back()} />}
    >
      {!isOnline && (
        <Text style={styles.note}>
          You are offline, so this is the last list fetched. Downloading or removing
          a file needs a connection — bytes cannot wait in the outbox with your
          messages.
        </Text>
      )}
      {!!actionError && (
        <Text style={styles.formError} accessibilityLiveRegion="polite">
          {actionError}
        </Text>
      )}
      {!!status && (
        <Text style={styles.status} accessibilityLiveRegion="polite">
          {status}
        </Text>
      )}

      {live.length > 0 && (
        <Text style={styles.summary}>
          {live.length} file{live.length === 1 ? '' : 's'} ·{' '}
          {formatFileSize(totalBytes)}
          {removedCount > 0 ? ` · ${removedCount} removed` : ''}
        </Text>
      )}

      {loading && materials.length === 0 ? (
        <ActivityIndicator color={colors.primaryDark} style={styles.loader} />
      ) : error && materials.length === 0 ? (
        <Text style={styles.errorText}>{error}</Text>
      ) : materials.length === 0 ? (
        <Text style={styles.emptyText}>
          Nothing shared yet. Anyone in the group can send notes, slides or a past
          paper — up to 25 MB — from the ＋ beside the message field in the chat.
        </Text>
      ) : (
        <View>
          {materials.map((row) => (
            <FileCard
              key={row.material_id}
              material={row}
              // `group_materials` joins the name in, because RLS on
              // `public.users` is own-row only. The roster covers the one case
              // it cannot: a member who has since left the group.
              uploaderName={
                (row.uploader_name ?? '').trim() || nameFor(row.uploaded_by)
              }
              isMine={row.uploaded_by === userId}
              // The note a file was shared with is a property of the MESSAGE, and
              // a `materials` row does not carry the body. It stays where it was
              // said, on the timeline, rather than being fetched again for a list
              // whose job is the files themselves.
              note={null}
              removedLabel={materialStateLabel(row, (id) =>
                id === userId ? 'you' : nameFor(id)
              )}
              // Dated, not just clocked: this list has no day separators above
              // its rows to say which week a file is from.
              time={materialWhenLabel(row.created_at)}
              canRemove={canDeleteMaterial(row, userId, creator)}
              downloadable={canDownloadMaterial(row)}
              actionsDisabled={!isOnline}
              busy={busy?.id === row.material_id ? busy.key : null}
              onDownload={() => void handleDownload(row)}
              onRemove={() => void handleRemove(row)}
            />
          ))}
        </View>
      )}

      <Button
        label="Refresh"
        variant="ghost"
        onPress={() => void reload()}
        style={styles.refresh}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  loader: { marginVertical: spacing.xl },
  note: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
    marginBottom: spacing.sm,
  },
  summary: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  errorText: { fontSize: fontSize.sm, color: colors.danger, marginTop: spacing.md },
  emptyText: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    lineHeight: 20,
    marginTop: spacing.md,
  },
  formError: { color: colors.danger, fontSize: fontSize.sm, marginBottom: spacing.sm, lineHeight: 20 },
  status: { color: colors.success, fontSize: fontSize.sm, marginBottom: spacing.sm, lineHeight: 20 },
  refresh: { marginTop: spacing.lg },
});
