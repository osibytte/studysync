import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from './Button';
import { fileKind, formatFileSize } from '@/lib/chatRules';
import type { FileKind } from '@/lib/chatRules';
import { FONT, MIN_TOUCH, colors, fontSize, radius, spacing } from '@/theme';
import type { GroupMaterialRow } from '@/types/database';

/**
 * A shared file, on the timeline where it was shared.
 *
 * The sibling of `SessionCard`, and full-width for the same reason: a name, a
 * size, who shared it and two controls do not fit a bubble, and both of these are
 * things the group acts on rather than reads past.
 *
 * EVERY FACT HERE COMES FROM THE `materials` ROW, not from the message that
 * announced it. The row is the thing Storage's policies consult, so it is also
 * the only honest source for whether the file is still there — a message body
 * saying "Shared notes.pdf" survives a removal untouched.
 *
 * Removing is a two-step confirm inside the card, like every other destructive
 * tap in this codebase, and there is no "undo": `delete_material` stamps
 * `deleted_at`, and by then the bytes are already out of the bucket.
 */

/**
 * The tile's letters, one per family.
 *
 * This mapping lives here rather than in `chatRules` because `fileKind` returns a
 * semantic key precisely so that module need not know how a screen draws it — and
 * letters are how this one draws it. There is no icon set installed, and an emoji
 * glyph is missing or square-boxed on exactly the older Android builds this app
 * is aimed at, which is a worse answer than three plain letters.
 */
const KIND_LABEL: Record<FileKind, string> = {
  pdf: 'PDF',
  doc: 'DOC',
  sheet: 'XLS',
  slides: 'PPT',
  image: 'IMG',
  audio: 'AUD',
  video: 'VID',
  archive: 'ZIP',
  text: 'TXT',
  file: 'FILE',
};

interface Props {
  material: GroupMaterialRow;
  /** `group_materials` joins this in; the roster is the fallback when it is null. */
  uploaderName: string;
  /** True when the uploader is the signed-in student, so it can say "You". */
  isMine: boolean;
  /**
   * What the sharer typed, or null when they typed nothing. From `materialNote`,
   * which drops the "Shared <name>" default rather than printing the file name
   * twice.
   */
  note: string | null;
  /** From `materialStateLabel`: "Removed by Ada", or '' while the file is there. */
  removedLabel: string;
  /** Already formatted — this component does no date work. */
  time: string;
  /** From `canDeleteMaterial`: the uploader or the group's creator. */
  canRemove: boolean;
  /** From `canDownloadMaterial`: false once it is removed, for everybody. */
  downloadable: boolean;
  /**
   * Offline, always. Both file actions are online-only: an upload needs bytes on
   * the wire and a removal needs the bucket to answer, so neither is a thing the
   * outbox could replay.
   */
  actionsDisabled: boolean;
  /** `download` | `remove`, so only the pressed control spins. */
  busy: string | null;
  onDownload: () => void;
  onRemove: () => void;
}

export function FileCard({
  material,
  uploaderName,
  isMine,
  note,
  removedLabel,
  time,
  canRemove,
  downloadable,
  actionsDisabled,
  busy,
  onDownload,
  onRemove,
}: Props) {
  const [confirmRemove, setConfirmRemove] = useState(false);

  const gone = removedLabel !== '';
  const kind = fileKind(material.mime_type, material.file_name);
  const size = formatFileSize(material.size_bytes);
  const sharer = isMine ? 'You' : uploaderName;

  return (
    <View style={[styles.card, gone && styles.cardGone]}>
      <View style={styles.headerRow}>
        <Text style={styles.eyebrow}>Shared file</Text>
        <Text style={styles.time}>{time}</Text>
      </View>

      <View style={styles.fileRow}>
        {/*
          Decorative: the name and the size below say everything this does, so
          reading "PDF" aloud before them only adds noise.
        */}
        <View
          style={[styles.tile, gone && styles.tileGone]}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text style={styles.tileText}>{KIND_LABEL[kind]}</Text>
        </View>
        <View style={styles.fileTextCol}>
          <Text style={[styles.name, gone && styles.nameGone]} numberOfLines={2}>
            {material.file_name}
          </Text>
          <Text style={styles.detail}>
            {size}
            {size && ' · '}
            {sharer === 'You' ? 'shared by you' : `shared by ${sharer}`}
          </Text>
        </View>
      </View>

      {note !== null && <Text style={styles.note}>{note}</Text>}

      {gone ? (
        <Text style={styles.removed}>{removedLabel}</Text>
      ) : confirmRemove ? (
        <View style={styles.confirm}>
          <Text style={styles.confirmText}>
            Remove {material.file_name}? It goes for the whole group, yours
            included, and it cannot be brought back — sharing it again means
            uploading it again.
          </Text>
          <View style={styles.buttonRow}>
            <Button
              label="Remove it"
              variant="danger"
              fullWidth={false}
              onPress={onRemove}
              loading={busy === 'remove'}
              disabled={actionsDisabled || busy !== null}
              style={styles.button}
            />
            <Button
              label="Keep it"
              variant="ghost"
              fullWidth={false}
              onPress={() => setConfirmRemove(false)}
              disabled={busy !== null}
              style={styles.button}
            />
          </View>
        </View>
      ) : (
        <View style={styles.buttonRow}>
          {downloadable && (
            <Button
              label="Download"
              variant="secondary"
              fullWidth={false}
              onPress={onDownload}
              loading={busy === 'download'}
              disabled={actionsDisabled || busy !== null}
              style={styles.button}
            />
          )}
          {canRemove && (
            <Button
              label="Remove"
              variant="ghost"
              fullWidth={false}
              onPress={() => setConfirmRemove(true)}
              disabled={actionsDisabled || busy !== null}
              style={styles.button}
            />
          )}
        </View>
      )}

      {actionsDisabled && !gone && (
        <Text style={styles.hint}>
          Files need a connection — the bytes cannot wait in the outbox with your
          messages.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  /** Mirrors `MessageBubble`'s deleted bubble, so a gap reads the same everywhere. */
  cardGone: { backgroundColor: colors.surfaceAlt },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  eyebrow: {
    fontSize: fontSize.xs,
    fontFamily: FONT.bold,
    color: colors.textMuted,
    letterSpacing: 0.5,
  },
  time: { fontSize: fontSize.xs, color: colors.textMuted },

  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    gap: spacing.md,
  },
  /** Square, so ZIP and FILE sit on the same footprint and the rows line up. */
  tile: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileGone: { backgroundColor: colors.surfaceAlt },
  tileText: {
    fontSize: fontSize.xs,
    fontFamily: FONT.bold,
    color: colors.primaryDark,
  },
  fileTextCol: { flex: 1 },
  name: { fontSize: fontSize.md, fontFamily: FONT.semi, color: colors.text },
  nameGone: { color: colors.textMuted, fontStyle: 'italic' },
  detail: { fontSize: fontSize.sm, fontFamily: FONT.regular, color: colors.textMuted, marginTop: 2 },

  note: {
    fontSize: fontSize.sm,
    color: colors.text,
    marginTop: spacing.sm,
    lineHeight: 20,
  },
  hint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: spacing.sm,
    lineHeight: 18,
  },
  removed: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: spacing.sm,
    fontStyle: 'italic',
  },

  buttonRow: { flexDirection: 'row', marginTop: spacing.md, gap: spacing.sm },
  button: { paddingHorizontal: spacing.md },
  confirm: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  confirmText: { fontSize: fontSize.xs, color: colors.text, lineHeight: 18 },
});
