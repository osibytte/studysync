import { supabase } from './supabase';
import type { NotificationCursor } from './notificationRules';
import type { Notification } from '@/types/database';

/**
 * The in-app inbox's data access: read the ledger, mark rows read.
 *
 * Small on purpose, and the reason it is small is worth stating. Every other list
 * in this app goes through a definer RPC because it has to resolve another
 * student's name and `public.users` is own-row-only (0010). A notification stores
 * its own `title` and `body` as sent, so there is nothing to join and `0019`'s
 * `notifications_select_own` policy is the entire read path — one fewer definer
 * function to audit, and the query is a plain `select` a reader can check against
 * the policy by eye.
 *
 * WRITES ARE THE OPPOSITE. `authenticated` holds no INSERT, UPDATE or DELETE on
 * the table (0019 revokes them, and no policy grants them either), so dismissing a
 * notification cannot be an `update` from here — it goes through
 * `mark_notification_read`, which moves `read_at` forward and nothing else. A
 * student may not rewrite a title, invent a row, or delete the evidence that their
 * daily cap was spent.
 *
 * Nothing here is queued offline, unlike `profile.update`. A dismissal replayed
 * twenty minutes later is worse than one that was lost: the row is already off the
 * screen, and the replay would clear notifications that arrived in between. Same
 * call the same way `markGroupRead` is treated, and for the same reason.
 *
 * The local 30-minute study alarm appears nowhere in here. It is scheduled by the
 * device (`notifier.ts` via `reminders.ts`), fires from the OS with no server
 * involved, and writes no ledger row — `0019`'s `kind` check refuses one.
 */

/** Thrown for a failed call. Screens map it with friendlyError(). */
function unwrap<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw result.error;
  return result.data;
}

/**
 * Named rather than `*`, so a column added to `notifications` later is not
 * silently shipped to every device, and so this list can be read against the
 * `Notification` interface.
 */
const NOTIFICATION_COLUMNS =
  'notification_id, user_id, group_id, kind, title, body, urgent, dedupe_key, created_at, read_at';

/** A screenful and a bit, matching MESSAGE_PAGE_SIZE. */
export const NOTIFICATION_PAGE_SIZE = 30;

/**
 * One page of the student's inbox, newest first. Pass the cursor from
 * `nextInboxCursor()` to get the page after it.
 *
 * THE FILTER NAMES BOTH INDEX COLUMNS, exactly as `fetchMessages` does and for the
 * same reason: `created_at` is not unique here either. A sender fan-out writes one
 * row per recipient in a single statement, so `now()` is identical across them,
 * and a one-column `.lt('created_at', cursor)` would skip every row sharing the
 * boundary instant — a notification that then appears in NEITHER page, which
 * reads as "we never told you".
 *
 * What runs is `user_id = auth.uid()` (the policy, not this query) and
 * `(created_at < $1 or (created_at = $1 and notification_id < $2))` ordered
 * `created_at desc, notification_id desc` — the shape of `notifications_inbox_idx`.
 */
export async function fetchNotifications(
  before?: NotificationCursor | null
): Promise<Notification[]> {
  let query = supabase
    .from('notifications')
    .select(NOTIFICATION_COLUMNS)
    .order('created_at', { ascending: false })
    .order('notification_id', { ascending: false })
    .limit(NOTIFICATION_PAGE_SIZE);

  if (before) {
    // Unquoted, like fetchMessages: neither a timestamptz rendering nor a uuid
    // can hold one of PostgREST's reserved characters, and supabase-js encodes
    // the query string, so the '+' of a UTC offset survives.
    query = query.or(
      `created_at.lt.${before.created_at},` +
        `and(created_at.eq.${before.created_at},notification_id.lt.${before.notification_id})`
    );
  }

  const data = unwrap(await query);
  return (data ?? []) as Notification[];
}

/**
 * How many unread notifications this student has, for the badge — a count, not a
 * page.
 *
 * `head: true` sends no rows at all, which matters because the badge is asked for
 * on every focus of home and the answer is one integer. `count: 'exact'` rather
 * than an estimate: an inbox holds tens of rows, so the exact count is cheap, and
 * `notifications_unread_idx` is the partial index that serves it.
 */
export async function unreadNotificationCount(): Promise<number> {
  const { count, error } = await supabase
    .from('notifications')
    .select('notification_id', { count: 'exact', head: true })
    .is('read_at', null);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Dismiss one notification. Returns when it was first read, or null when the id
 * is not this student's.
 *
 * Idempotent server-side (`coalesce(read_at, now())`), so a second tap on a slow
 * connection cannot move the timestamp — which matters because `read_at` is a
 * value the list is looking at, and one that drifts forward reorders the screen
 * under the student's thumb.
 */
export async function markNotificationRead(
  notificationId: string
): Promise<string | null> {
  return unwrap(
    await supabase.rpc('mark_notification_read', { p_notification_id: notificationId })
  );
}

/**
 * Clear the whole inbox. Returns how many rows were actually unread.
 *
 * One RPC rather than a loop over `markNotificationRead`, because clearing twenty
 * notifications is one intention and twenty round trips over hostel wifi turns it
 * into a half-cleared inbox the moment one of them fails.
 */
export async function markAllNotificationsRead(): Promise<number> {
  const n = unwrap(await supabase.rpc('mark_all_notifications_read', {}));
  return typeof n === 'number' ? n : 0;
}
