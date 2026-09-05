import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import { refreshReminders, restoreReminders } from '@/lib/reminders';

/**
 * Keeps this phone's study alarms level with the server, for as long as a student
 * is signed in.
 *
 * Mounted once, in the signed-in layout, and renders nothing. It lives in the
 * layout rather than on a screen for the same reason the outbox drain lives in
 * `NetworkContext`: it has to keep working while the student is looking at any
 * screen, or none. There is no state and no return value — the alarms are the
 * output, and they are held by the OS.
 *
 * Four moments, each earning its place:
 *
 *  1. **Sign-in, from disk.** Before any network call, so it works on a plane and
 *     so it survives the case where iOS has cleared the app's pending
 *     notifications (reinstall, restore from backup).
 *  2. **Whenever there is a connection.** The authoritative pass.
 *  3. **After an outbox drain.** A queued "yes" has just reached the server and
 *     may have carried a session over its confirmation threshold, which means an
 *     alarm this phone does not yet hold.
 *  4. **On coming back to the foreground.** Sessions get confirmed and called off
 *     while the app is not running; without this the alarms would only ever catch
 *     up on a cold start, and phones are not cold-started for weeks.
 *
 * Every one of them funnels into the same all-or-nothing reconcile, so an extra
 * call costs a round trip and never correctness. Nothing here reports an error:
 * there is no action a student could take, and `reminders.ts` leaves the alarms
 * untouched when it cannot establish what they should be.
 */
export function useReminderSync(): void {
  const { session } = useAuth();
  const { isOnline, syncing } = useNetwork();
  const userId = session?.user?.id ?? null;

  const refresh = useCallback(() => {
    if (!userId) return;
    void refreshReminders(userId);
  }, [userId]);

  // 1. Disk first, and independent of the network.
  useEffect(() => {
    if (!userId) return;
    void restoreReminders(userId);
  }, [userId]);

  // 2. Then the server, whenever it is reachable.
  useEffect(() => {
    if (!isOnline) return;
    refresh();
  }, [isOnline, refresh]);

  // 3. A drain just finished. Watch the falling edge of `syncing` rather than
  //    `pending`, which also moves when a screen queues something new.
  const wasSyncing = useRef(false);
  useEffect(() => {
    if (wasSyncing.current && !syncing) refresh();
    wasSyncing.current = syncing;
  }, [syncing, refresh]);

  // 4. Back from the background.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => subscription.remove();
  }, [refresh]);
}
