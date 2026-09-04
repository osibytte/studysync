import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Local read cache.
 *
 * Half of the offline requirement: chat history, materials lists and group
 * details must stay viewable with no connection. Every screen writes what it
 * fetched here, and reads from here first on mount so there is content on
 * screen before the network answers — or instead of it, when there is no
 * network at all.
 *
 * Deliberately dumb: namespaced JSON blobs in AsyncStorage, no query engine,
 * no schema migration. AsyncStorage on entry-level Android is not fast, so
 * values are kept small and per-screen rather than one large document.
 *
 * Cached data is scoped by user id. Two students sharing a phone must not see
 * each other's cached content — that would be exactly the leak the RLS
 * policies exist to prevent, reintroduced on the client.
 */

const PREFIX = 'studysync:cache:v1';

export const CacheKeys = {
  courses: () => `${PREFIX}:courses`,
  topics: (courseId: string) => `${PREFIX}:topics:${courseId}`,
  profile: (userId: string) => `${PREFIX}:user:${userId}:profile`,
  userCourses: (userId: string) => `${PREFIX}:user:${userId}:courses`,
} as const;

interface Envelope<T> {
  data: T;
  cachedAt: number;
}

export async function cacheWrite<T>(key: string, data: T): Promise<void> {
  try {
    const envelope: Envelope<T> = { data, cachedAt: Date.now() };
    await AsyncStorage.setItem(key, JSON.stringify(envelope));
  } catch {
    // A failed cache write must never break the screen that triggered it.
    // Worst case the student sees a spinner next launch instead of stale data.
  }
}

export async function cacheRead<T>(
  key: string
): Promise<{ data: T; cachedAt: number } | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const envelope = JSON.parse(raw) as Envelope<T>;
    if (envelope == null || typeof envelope !== 'object' || !('data' in envelope)) {
      return null;
    }
    return { data: envelope.data, cachedAt: envelope.cachedAt ?? 0 };
  } catch {
    return null;
  }
}

/** Just the payload, for call sites that don't care how old it is. */
export async function cacheReadData<T>(key: string): Promise<T | null> {
  const hit = await cacheRead<T>(key);
  return hit ? hit.data : null;
}

export async function cacheRemove(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * Wipe every cache entry. Called on sign-out.
 *
 * Necessary, not just tidy: without it, the next student to sign in on a
 * shared phone would briefly see the previous student's cached profile and
 * courses while their own fetch was still in flight.
 */
export async function cacheClearAll(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = keys.filter((k) => k.startsWith(PREFIX));
    if (ours.length > 0) await AsyncStorage.multiRemove(ours);
  } catch {
    /* ignore */
  }
}

/** Age in ms, or Infinity if absent — lets a screen decide whether to refetch. */
export async function cacheAge(key: string): Promise<number> {
  const hit = await cacheRead(key);
  return hit ? Date.now() - hit.cachedAt : Number.POSITIVE_INFINITY;
}
