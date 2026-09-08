import { Platform } from 'react-native';
import { getExpoPushToken, pushTokenBlockedReason } from '@/lib/notifier';
import { supabase } from '@/lib/supabase';

/**
 * Two facts the sender cannot work without, reported by the device that knows them.
 *
 * Everything else in Stage 5 is decided on this phone. Step 6 moves the deciding to
 * a scheduled Edge Function, and the moment it moves, two things the client always
 * had for free become unknowable:
 *
 *   - WHERE TO SEND. A push goes to an Expo token, which only the device can mint.
 *   - WHEN NOT TO SEND. Quiet hours are a wall-clock rule — `isWithinQuietHours`
 *     reads `getHours()` — and the server has no idea what wall clock a student is
 *     standing under. `0021` added `users.timezone` for exactly this.
 *
 * Both are reported at sign-in, both fail silently, and neither is allowed to block
 * anything. A student whose token registration fails still has an app, an inbox, and
 * local alarms; what they lose is the lock-screen half, which is the half that was
 * already optional.
 */

/**
 * The last token this process registered, so sign-out can un-register it without a
 * second trip through the OS.
 *
 * In memory rather than in the cache on purpose. `cacheClearAll()` runs on sign-out
 * and would wipe it before the delete, and a token is a device fact anyway — it
 * outlives the student, which is the whole reason `register_push_token` exists.
 * Empty after a cold start, which is fine: see `forgetPushToken`.
 */
let lastRegistered: string | null = null;

/** `platform` in `device_push_tokens` is a two-value CHECK; web has no token. */
function devicePlatform(): 'ios' | 'android' | null {
  if (Platform.OS === 'ios' || Platform.OS === 'android') return Platform.OS;
  return null;
}

export interface PushRegistration {
  /** True when this device now has a row the sender can push to. */
  registered: boolean;
  /** Null on success, otherwise why not — safe to show, or to ignore. */
  blocked: string | null;
}

/**
 * Claim this device for the signed-in student.
 *
 * The RPC does the claiming rather than a direct upsert, because on a shared phone
 * the row being updated belongs to the PREVIOUS student and no own-row policy can
 * allow that — see `0022`'s header. The client cannot name a user id at all here,
 * which is the point.
 *
 * Called on sign-in and again when the prefs screen turns notifications on, so it
 * must be idempotent and quiet. It is both: the RPC upserts, and every failure path
 * returns rather than throws.
 */
export async function registerPushToken(): Promise<PushRegistration> {
  const platform = devicePlatform();
  if (!platform) {
    return { registered: false, blocked: 'Push notifications need the phone app.' };
  }

  const { token, blocked } = await getExpoPushToken();
  if (!token) return { registered: false, blocked };

  const { error } = await supabase.rpc('register_push_token', {
    p_expo_token: token,
    p_platform: platform,
  });
  if (error) {
    // Offline is the common case and it is not worth a word to the student: the
    // next sign-in, or the next visit to the prefs screen, tries again.
    console.warn('[pushTokens] could not register the device', error);
    return { registered: false, blocked: 'Could not reach the server.' };
  }

  lastRegistered = token;
  return { registered: true, blocked: null };
}

/**
 * Release this device before signing out. Never throws.
 *
 * MUST be called BEFORE `supabase.auth.signOut()`, or `auth.uid()` is null inside
 * the RPC and it raises — the ordering in `AuthContext.signOut` is load-bearing.
 *
 * If the token is not in memory (the app was restarted since sign-in) this asks the
 * OS for it again rather than giving up, but it does not treat failure as a problem:
 * the row is reassigned by whoever signs in next, so this is closing a window, not
 * holding the only key. Deliberately does not ask for permission if the student has
 * since revoked it — `getExpoPushToken` never prompts.
 */
export async function forgetPushToken(): Promise<boolean> {
  if (pushTokenBlockedReason()) return false;

  let token = lastRegistered;
  if (!token) token = (await getExpoPushToken()).token;
  if (!token) return false;

  lastRegistered = null;
  const { data, error } = await supabase.rpc('forget_push_token', {
    p_expo_token: token,
  });
  if (error) {
    console.warn('[pushTokens] could not release the device', error);
    return false;
  }
  return data === true;
}

/**
 * This device's IANA timezone, or null when the runtime will not say.
 *
 * The one `Intl` call in the app, and the reason it is allowed here when
 * `notificationRules.ts` refuses it throughout: that module formats times on every
 * Android build including the Hermes ones that shipped without `Intl`, whereas this
 * asks a single optional question and is content with "don't know". A null answer
 * leaves `users.timezone` null, and `0021` says what the sender does then — falls
 * back to a stated default rather than to UTC.
 */
export function deviceTimezone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Some runtimes answer 'UTC' when they simply do not know. Kept anyway: it is
    // a legal zone, and second-guessing it would mean overriding a student who
    // really is on UTC.
    return typeof zone === 'string' && zone.length > 0 ? zone : null;
  } catch {
    return null;
  }
}

/**
 * Report the device's timezone, but only when it is news.
 *
 * `known` is the value already on the profile row, which `AuthContext` has in hand
 * — so the steady state is no write at all. Worth the parameter: this runs on every
 * sign-in and every launch with a restored session, and a `users` UPDATE per launch
 * for a string that changes when a student gets on a plane is a lot of writes for
 * nothing.
 *
 * `userId` is passed in for the same reason. `supabase.auth.getUser()` would do a
 * round trip to fetch a value the caller is already holding, and the filter is
 * belt-and-braces anyway — 0002's own-row policy is what actually confines the
 * update.
 *
 * Returns the zone when it wrote one, so the caller can patch its cached profile
 * without a refetch.
 */
export async function reportDeviceTimezone(
  userId: string,
  known: string | null | undefined
): Promise<string | null> {
  const zone = deviceTimezone();
  if (!zone || zone === known) return null;

  const { error } = await supabase
    .from('users')
    .update({ timezone: zone })
    .eq('user_id', userId);
  if (error) {
    console.warn('[pushTokens] could not report the timezone', error);
    return null;
  }
  return zone;
}
