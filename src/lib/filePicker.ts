import * as DocumentPicker from 'expo-document-picker';
import type { UploadBody } from './chat';
import {
  MATERIALS_ALLOWED_MIME_TYPES,
  uploadMimeType,
  validateUpload,
} from './chatRules';

/**
 * The one place that turns a document picker's answer into something
 * `shareFile()` can upload.
 *
 * Everything questionable about a picked file is settled here rather than in the
 * screen, because all three of the awkward facts are about the picker and none of
 * them are about chat:
 *
 *   `mimeType` is optional and often wrong. Android reports
 *   `application/octet-stream` for perfectly ordinary PDFs, and the bucket only
 *   accepts fifteen exact types (0017), so the type is resolved through
 *   `uploadMimeType` before any bytes move — a wrong type is rejected by Storage
 *   only after the whole upload has been sent.
 *
 *   `size` is optional too. When it is missing we refuse instead of guessing:
 *   `attach_material` checks `size_bytes` against the real object, so a made-up
 *   number costs the student a full upload and then fails anyway.
 *
 *   The bytes are a file URI, not a buffer. See `buildUploadBody`.
 *
 * WHY THIS IS NOT A HOOK: it is one await with no state, and the screen already
 * owns the busy flag it would duplicate.
 */

/** Everything `shareFile()` needs, and nothing about how it was chosen. */
export interface PickedUpload {
  fileName: string;
  /** From `uploadMimeType`, so the bucket is known to accept it. */
  mimeType: string;
  sizeBytes: number;
  body: UploadBody;
}

/**
 * Three outcomes, kept apart because the screen must treat them differently: a
 * cancel is silent, a refusal is a sentence to show, and only a pick uploads.
 */
export type PickMaterialResult =
  | { status: 'picked'; file: PickedUpload }
  | { status: 'cancelled' }
  | { status: 'refused'; reason: string };

/**
 * The upload body: a `FormData` part holding the file's URI, name and type.
 *
 * NOT a buffer, and that is a memory decision, not a style one. Reading a 25 MB
 * file as base64 would build a ~33 MB JavaScript string and then a 25 MB
 * ArrayBuffer beside it — some 60 MB of peak heap on the entry-level Android
 * phones this app is for. React Native's networking layer streams a `{ uri, name,
 * type }` part straight from disk with no JS-side copy at all.
 *
 * Verified against the two libraries this leans on, because both behaviours are
 * load-bearing and neither is documented as a guarantee:
 *
 *   `RN/Libraries/Network/FormData.js` turns `{ uri, name, type }` into a part
 *   carrying `content-disposition: form-data; name=""; filename="…"` and
 *   `content-type: <type>`. That part header is the ONLY place the object's MIME
 *   type is stated, which is why `type` here must already be an allowed one.
 *
 *   `storage-js`'s `uploadOrUpdate` passes a `FormData` body through untouched
 *   and deliberately sets no `content-type` header, letting fetch supply the
 *   multipart boundary. It appends the file under the field name `''` in its own
 *   `Blob` branch, so that is the name used here.
 *
 * If a device ever turns out not to accept this, swapping to base64 is a change
 * to this function alone — which is the whole reason it is a function.
 */
function buildUploadBody(uri: string, fileName: string, mimeType: string): UploadBody {
  const form = new FormData();
  // RN's FormData takes `{ uri, name, type }` where the web takes a Blob. The
  // cast says exactly that and nothing more.
  form.append('', { uri, name: fileName, type: mimeType } as unknown as Blob);
  return form;
}

/**
 * Ask the student for one file and hand back something uploadable.
 *
 * The picker is filtered to the bucket's own allow-list, which is what 0017's
 * comment means by "a student who picks the wrong file gets told at the picker
 * instead of after a 20 MB upload". The checks after it are not redundant: on
 * Android the filter is a hint the file manager may ignore, and a student can
 * always reach a file through "browse".
 *
 * `copyToCacheDirectory` is on so the URI survives long enough to upload. A
 * content:// URI handed straight from another app's provider can be revoked the
 * moment the picker closes, which would fail mid-upload rather than up front.
 */
export async function pickMaterial(): Promise<PickMaterialResult> {
  const result = await DocumentPicker.getDocumentAsync({
    type: [...MATERIALS_ALLOWED_MIME_TYPES],
    copyToCacheDirectory: true,
    multiple: false,
  });

  if (result.canceled) return { status: 'cancelled' };

  const asset = result.assets[0];
  if (!asset) return { status: 'cancelled' };

  const fileName = (asset.name ?? '').trim();
  if (fileName === '') {
    return { status: 'refused', reason: 'That file has no name, so it cannot be shared.' };
  }

  const mimeType = uploadMimeType(asset.mimeType, fileName);
  if (mimeType === null) {
    return {
      status: 'refused',
      reason: `${fileName} is not a kind of file this can share. Documents, images, spreadsheets, slides, text and zip files all work.`,
    };
  }

  if (typeof asset.size !== 'number' || !Number.isFinite(asset.size)) {
    return {
      status: 'refused',
      reason: `The size of ${fileName} could not be read, and it has to be checked before uploading. Try saving it to your device first, then sharing that copy.`,
    };
  }

  const problem = validateUpload({ fileName, mimeType, sizeBytes: asset.size });
  if (problem !== null) return { status: 'refused', reason: `${problem}.` };

  return {
    status: 'picked',
    file: {
      fileName,
      mimeType,
      sizeBytes: asset.size,
      body: buildUploadBody(asset.uri, fileName, mimeType),
    },
  };
}
