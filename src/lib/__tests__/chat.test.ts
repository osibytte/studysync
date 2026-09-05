/**
 * chat.ts is a wrapper layer, and most of it is not worth a test: an RPC
 * argument name is either right or an immediate 404, which the first tap finds.
 * Three things in it are different, and they are what this file pins.
 *
 *   1. `shareFile` and `removeFile` each touch Storage AND Postgres, in opposite
 *      orders, and the order IS the correctness argument (HANDOFF invariant 8).
 *      A later edit that swaps two awaits would leave cards pointing at bytes
 *      that never arrived, or bytes nobody can ever delete — and both failures
 *      are invisible until a student hits them.
 *   2. The rollback rule around a lost `attach_material` response: remove the
 *      bytes when nothing claims them, keep them when a row does.
 *   3. `fetchMessages`'s keyset filter, which must name BOTH index columns. The
 *      one-column version is not slower, it silently drops rows.
 *
 * Everything is asserted against a fake Supabase client that records the order of
 * the calls made to it. Names begin with `mock` because jest's hoisting plugin
 * only lets a `jest.mock` factory reach out-of-scope variables that do.
 */

interface MockResult {
  data: unknown;
  error: unknown;
}

/** Every call the fake client received, in order. */
let mockCalls: string[] = [];
let mockUploadResult: MockResult;
let mockRemoveResult: MockResult;
let mockSignedResult: MockResult;
/** Keyed by RPC name, so one test can fail attach_material and nothing else. */
let mockRpcResults: Record<string, MockResult>;
/** What the `materials` read-back finds: a row, nothing, or an error. */
let mockMaterialRow: MockResult;
let mockMessagesResult: MockResult;
/** The `messages` query as built, so the keyset filter can be read back. */
let mockQuery: {
  columns: string;
  eq: string[];
  order: string[];
  limit: number;
  or: string | null;
};
/** Arguments the fake was called with, for the ones worth asserting on. */
let mockUploadArgs: { bucket: string; path: string; options: unknown } | null;
let mockRemoveArgs: { bucket: string; paths: string[] } | null;
let mockSignArgs: { path: string; expiresIn: number } | null;
let mockRpcArgs: Record<string, Record<string, unknown>>;

jest.mock('../supabase', () => {
  const bucketApi = (bucket: string) => ({
    upload: (path: string, _body: unknown, options: unknown) => {
      mockCalls.push('storage.upload');
      mockUploadArgs = { bucket, path, options };
      return Promise.resolve(mockUploadResult);
    },
    remove: (paths: string[]) => {
      mockCalls.push('storage.remove');
      mockRemoveArgs = { bucket, paths };
      return Promise.resolve(mockRemoveResult);
    },
    createSignedUrl: (path: string, expiresIn: number) => {
      mockCalls.push('storage.sign');
      mockSignArgs = { path, expiresIn };
      return Promise.resolve(mockSignedResult);
    },
  });

  // A chainable stand-in for PostgrestFilterBuilder. Awaitable through `then`,
  // which is all `await query` needs.
  const messagesQuery = () => {
    const q = {
      select: (columns: string) => {
        mockQuery.columns = columns;
        return q;
      },
      eq: (column: string, value: string) => {
        mockQuery.eq.push(`${column}=${value}`);
        return q;
      },
      order: (column: string, options: { ascending: boolean }) => {
        mockQuery.order.push(`${column} ${options.ascending ? 'asc' : 'desc'}`);
        return q;
      },
      limit: (count: number) => {
        mockQuery.limit = count;
        return q;
      },
      or: (filter: string) => {
        mockQuery.or = filter;
        return q;
      },
      then: (resolve: (result: MockResult) => unknown) => {
        mockCalls.push('select.messages');
        return Promise.resolve(resolve(mockMessagesResult));
      },
    };
    return q;
  };

  return {
    supabase: {
      rpc: (name: string, params: Record<string, unknown>) => {
        mockCalls.push(`rpc.${name}`);
        mockRpcArgs[name] = params;
        return Promise.resolve(mockRpcResults[name] ?? { data: null, error: null });
      },
      storage: { from: bucketApi },
      from: (table: string) => {
        if (table === 'messages') return messagesQuery();
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => {
                mockCalls.push(`select.${table}`);
                return Promise.resolve(mockMaterialRow);
              },
            }),
          }),
        };
      },
    },
  };
});

import {
  MESSAGE_PAGE_SIZE,
  fetchMessages,
  materialDownloadUrl,
  removeFile,
  shareFile,
} from '../chat';
import { MATERIALS_BUCKET } from '@/types/database';

const GROUP = '11111111-1111-4111-8111-111111111111';
const MATERIAL = '22222222-2222-4222-8222-222222222222';
const MESSAGE = '33333333-3333-4333-8333-333333333333';

function shareArgs(over: Partial<Parameters<typeof shareFile>[0]> = {}) {
  return {
    groupId: GROUP,
    materialId: MATERIAL,
    messageId: MESSAGE,
    fileName: 'week3-notes.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 12_345,
    body: new ArrayBuffer(8),
    ...over,
  };
}

beforeEach(() => {
  mockCalls = [];
  mockUploadResult = { data: { path: 'ok' }, error: null };
  mockRemoveResult = { data: [{ name: 'ok' }], error: null };
  mockSignedResult = { data: { signedUrl: 'https://example.test/signed' }, error: null };
  mockRpcResults = {};
  mockMaterialRow = { data: null, error: null };
  mockMessagesResult = { data: [], error: null };
  mockQuery = { columns: '', eq: [], order: [], limit: 0, or: null };
  mockUploadArgs = null;
  mockRemoveArgs = null;
  mockSignArgs = null;
  mockRpcArgs = {};
});

describe('shareFile — bytes first, row second', () => {
  it('uploads before it records, and records the path it uploaded to', async () => {
    const result = await shareFile(shareArgs());

    expect(mockCalls).toEqual(['storage.upload', 'rpc.attach_material']);
    expect(result).toEqual({
      materialId: MATERIAL,
      storagePath: `${GROUP}/${MATERIAL}/week3-notes.pdf`,
    });
    // The path is the permission: Storage's INSERT policy reads its first folder
    // and attach_material re-checks the whole prefix, so the two must agree.
    expect(mockUploadArgs?.path).toBe(result.storagePath);
    expect(mockRpcArgs.attach_material.p_storage_path).toBe(result.storagePath);
    expect(mockUploadArgs?.bucket).toBe(MATERIALS_BUCKET);
  });

  it("uploads with the file's own content type and never overwrites", async () => {
    await shareFile(shareArgs({ mimeType: 'image/png', fileName: 'board.png' }));

    expect(mockUploadArgs?.options).toEqual({
      contentType: 'image/png',
      upsert: false,
    });
  });

  it('sanitises the last path segment without touching the recorded name', async () => {
    const result = await shareFile(
      shareArgs({ fileName: '../notes/week 3.pdf' })
    );

    // One segment: a name holding a slash would pass attach_material's prefix
    // check and quietly create a nested folder the row does not describe. The
    // leading dots go too, so the name cannot read as a relative path.
    expect(result.storagePath).toBe(`${GROUP}/${MATERIAL}/_notes_week 3.pdf`);
    expect(result.storagePath.split('/')).toHaveLength(3);
    // The card renders materials.file_name, so the real name is recorded as typed.
    expect(mockRpcArgs.attach_material.p_file_name).toBe('../notes/week 3.pdf');
  });

  it('records nothing when the upload fails', async () => {
    mockUploadResult = { data: null, error: new Error('network request failed') };

    await expect(shareFile(shareArgs())).rejects.toThrow('network request failed');
    expect(mockCalls).toEqual(['storage.upload']);
  });

  it('removes the bytes again when attach_material really failed', async () => {
    mockRpcResults.attach_material = {
      data: null,
      error: new Error('This group is closed, so you cannot share files in it.'),
    };
    mockMaterialRow = { data: null, error: null }; // nothing claims the object

    await expect(shareFile(shareArgs())).rejects.toThrow('This group is closed');
    expect(mockCalls).toEqual([
      'storage.upload',
      'rpc.attach_material',
      'select.materials',
      'storage.remove',
    ]);
    expect(mockRemoveArgs?.paths).toEqual([`${GROUP}/${MATERIAL}/week3-notes.pdf`]);
  });

  it('keeps the bytes when the row landed but the response was lost', async () => {
    mockRpcResults.attach_material = {
      data: null,
      error: new Error('network request failed'),
    };
    mockMaterialRow = { data: { material_id: MATERIAL }, error: null };

    await expect(shareFile(shareArgs())).rejects.toThrow('network request failed');
    // Rolling this one back would strand a live row pointing at deleted bytes.
    expect(mockCalls).not.toContain('storage.remove');
  });

  it('keeps the bytes when it cannot tell whether the row landed', async () => {
    mockRpcResults.attach_material = { data: null, error: new Error('timeout') };
    mockMaterialRow = { data: null, error: new Error('timeout') };

    await expect(shareFile(shareArgs())).rejects.toThrow('timeout');
    // Litter a sweep can reach beats bytes deleted out from under a live row.
    expect(mockCalls).not.toContain('storage.remove');
  });

  it('surfaces the RPC error, not whatever the cleanup did', async () => {
    mockRpcResults.attach_material = {
      data: null,
      error: new Error('That upload is not where it claims to be.'),
    };
    mockRemoveResult = { data: null, error: new Error('cleanup exploded') };

    await expect(shareFile(shareArgs())).rejects.toThrow(
      'That upload is not where it claims to be.'
    );
  });
});

describe('removeFile — bytes first, row second, for the opposite reason', () => {
  const PATH = `${GROUP}/${MATERIAL}/week3-notes.pdf`;

  it('removes the bytes before it marks the row removed', async () => {
    await removeFile(MATERIAL, PATH);

    // Once delete_material stamps deleted_at the Storage read policy stops
    // admitting the object — and the API reads an object before deleting it, so
    // nothing short of a service_role sweep could reach those bytes again.
    expect(mockCalls).toEqual(['storage.remove', 'rpc.delete_material']);
    expect(mockRemoveArgs).toEqual({ bucket: MATERIALS_BUCKET, paths: [PATH] });
    expect(mockRpcArgs.delete_material.p_material_id).toBe(MATERIAL);
  });

  it('leaves the row alone when Storage refuses', async () => {
    mockRemoveResult = { data: null, error: new Error('network request failed') };

    await expect(removeFile(MATERIAL, PATH)).rejects.toThrow(
      'network request failed'
    );
    expect(mockCalls).toEqual(['storage.remove']);
  });

  it('still marks the row removed when the object was already gone', async () => {
    mockRemoveResult = { data: [], error: null }; // a retry whose first half landed

    await removeFile(MATERIAL, PATH);
    expect(mockCalls).toEqual(['storage.remove', 'rpc.delete_material']);
  });
});

describe('materialDownloadUrl', () => {
  it('signs the path for a minute by default', async () => {
    const url = await materialDownloadUrl(`${GROUP}/${MATERIAL}/notes.pdf`);

    expect(url).toBe('https://example.test/signed');
    expect(mockSignArgs).toEqual({
      path: `${GROUP}/${MATERIAL}/notes.pdf`,
      expiresIn: 60,
    });
  });

  it('throws a sentence when Storage answers without a URL', async () => {
    mockSignedResult = { data: null, error: null };

    await expect(materialDownloadUrl('a/b/c.pdf')).rejects.toThrow(
      'That file could not be opened. Please try again.'
    );
  });
});

describe('fetchMessages — the keyset', () => {
  const AT = '2026-09-05T09:00:00.123456+00:00';
  const ID = '44444444-4444-4444-8444-444444444444';

  it('asks for one page of the group, newest first, on both index columns', async () => {
    await fetchMessages(GROUP);

    expect(mockCalls).toEqual(['select.messages']);
    expect(mockQuery.eq).toEqual([`group_id=${GROUP}`]);
    // Both, in this order: it is 0013's (group_id, created_at desc, message_id
    // desc) index, and message_id is what makes the order total.
    expect(mockQuery.order).toEqual(['created_at desc', 'message_id desc']);
    expect(mockQuery.limit).toBe(MESSAGE_PAGE_SIZE);
    expect(MESSAGE_PAGE_SIZE).toBe(30);
    expect(mockQuery.or).toBeNull(); // first page: no cursor
  });

  it('filters on both columns for an older page, never on created_at alone', async () => {
    await fetchMessages(GROUP, { created_at: AT, message_id: ID });

    expect(mockQuery.or).toBe(
      `created_at.lt.${AT},and(created_at.eq.${AT},message_id.lt.${ID})`
    );
    // The tiebreak half is the whole point. created_at is not unique — now() is
    // fixed for a transaction — so `created_at.lt` alone drops every message
    // sharing the boundary instant, into neither page.
    expect(mockQuery.or).toContain(`created_at.eq.${AT}`);
    expect(mockQuery.or).toContain(`message_id.lt.${ID}`);
  });

  it('selects deleted_at rather than filtering deleted messages out', async () => {
    await fetchMessages(GROUP);

    // A deleted message keeps its row and renders as "message deleted", which is
    // what holds the transcript's shape and the cursor still.
    expect(mockQuery.columns).toContain('deleted_at');
    expect(mockQuery.columns).toContain('message_id');
    expect(mockQuery.columns).toContain('session_id');
    expect(mockQuery.columns).toContain('material_id');
  });

  it('returns an empty list rather than null when a group has nothing', async () => {
    mockMessagesResult = { data: null, error: null };

    await expect(fetchMessages(GROUP)).resolves.toEqual([]);
  });

  it('throws whatever PostgREST refused with', async () => {
    mockMessagesResult = { data: null, error: new Error('JWT expired') };

    await expect(fetchMessages(GROUP)).rejects.toThrow('JWT expired');
  });
});
