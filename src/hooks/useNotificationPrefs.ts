import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useNetwork } from '@/context/NetworkContext';
import {
  notificationSwitchRows,
  withNotificationDefaults,
  type NotificationSwitchRow,
} from '@/lib/notificationRules';
import { ensureNotifierReady, notifierBlockedReason, type NotifierStatus } from '@/lib/notifier';
import { enqueue } from '@/lib/outbox';
import { friendlyError, supabase } from '@/lib/supabase';
import type { NotificationPrefs, NotificationSwitchKey } from '@/types/database';

/**
 * The prefs screen's state: what the student has chosen, and what the OS allows.
 *
 * TWO LAYERS THAT ARE EASY TO CONFUSE, and the screen has to show both. This app's
 * prefs (`users.notification_prefs`) decide what the sender is *willing* to send;
 * the OS permission decides whether anything can be shown at all. A student who
 * declined the system prompt and then turns every switch here on has changed
 * nothing, and a prefs screen that does not say so is a screen that lies. So
 * `osStatus` is read alongside the prefs and reported separately.
 *
 * NO SEPARATE FETCH. Prefs live on the profile row `AuthContext` already holds and
 * caches, so this hook reads from there — which also means the screen opens
 * populated offline, with no loading state and nothing to reconcile.
 *
 * WRITES ARE LAST-WRITE-WINS ON THE WHOLE COLUMN, deliberately. `notification_prefs`
 * is jsonb and PostgREST has no partial-object update, so every save sends the
 * complete object; two devices editing prefs in the same minute means the later
 * save stands. That is the same bargain `full_name` already makes and the right one
 * here: the alternative is a per-key RPC for a screen a student visits twice a
 * term.
 *
 * QUEUED OFFLINE, through `profile.update` — which already carries
 * `notification_prefs` (see `outbox.ts`), so this needs no new action type. A
 * preference replayed twenty minutes late is still the preference the student
 * chose, which is exactly the test that action list applies; contrast
 * `markNotificationRead`, which is never queued because a dismissal replayed late
 * clears notifications that arrived in between.
 */

export interface NotificationPrefsState {
  /** Complete — `0001`'s defaults merged over whatever the row actually holds. */
  prefs: NotificationPrefs;
  /** The eight per-category switches, in screen order. */
  rows: NotificationSwitchRow[];
  /**
   * What the OS will allow, or null until it has been asked. Asked without
   * prompting, so opening the screen never triggers a system dialog.
   */
  osStatus: NotifierStatus | null;
  /** Why notifications are unavailable on this build at all, or null. */
  blockedReason: string | null;
  saving: boolean;
  error: string | null;
  /** One line of feedback after a save, e.g. the offline case. */
  status: string | null;
  /** Read the OS permission without prompting. Safe on focus. */
  refreshOsStatus: () => Promise<void>;
  /** Show the system prompt. Only from a tap the student made. */
  requestPermission: () => Promise<NotifierStatus>;
  /** Patch one or more prefs keys and persist the merged object. */
  save: (patch: Partial<NotificationPrefs>) => Promise<void>;
  setSwitch: (key: NotificationSwitchKey, value: boolean) => Promise<void>;
}

export function useNotificationPrefs(): NotificationPrefsState {
  const { profile, applyLocalProfilePatch, refreshProfile } = useAuth();
  const { isOnline, refreshPending } = useNetwork();

  const [osStatus, setOsStatus] = useState<NotifierStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const userId = profile?.user_id ?? null;

  const prefs = useMemo(
    () => withNotificationDefaults(profile?.notification_prefs),
    [profile?.notification_prefs]
  );
  const rows = useMemo(() => notificationSwitchRows(prefs), [prefs]);

  const refreshOsStatus = useCallback(async () => {
    // `askIfNeeded` left false: this runs on focus, and a system dialog that
    // appears because a screen opened is the one a student refuses on reflex.
    setOsStatus(await ensureNotifierReady(false));
  }, []);

  const requestPermission = useCallback(async (): Promise<NotifierStatus> => {
    const next = await ensureNotifierReady(true);
    setOsStatus(next);
    return next;
  }, []);

  /**
   * Persist a patch: optimistic locally, then the server or the queue.
   *
   * The optimistic write goes first and unconditionally, because the switch the
   * student flipped has to stay flipped — `AuthContext` is the only copy of the
   * prefs, so a switch that waits for a round trip springs back on hostel wifi.
   *
   * The catch enqueues rather than reporting failure, matching `profile.tsx`: an
   * error that is really a dropped connection should leave the change saved and
   * pending, not lose it. Only a failure to even queue reaches the student.
   */
  const save = useCallback(
    async (patch: Partial<NotificationPrefs>) => {
      if (!profile || !userId) return;
      setError(null);
      setStatus(null);

      const next: NotificationPrefs = { ...prefs, ...patch };
      setSaving(true);
      applyLocalProfilePatch({ notification_prefs: next });

      try {
        if (isOnline) {
          const { error: updateError } = await supabase
            .from('users')
            .update({ notification_prefs: next })
            .eq('user_id', userId);
          if (updateError) throw updateError;
          await refreshProfile();
        } else {
          await enqueue('profile.update', { notification_prefs: next }, userId);
          await refreshPending();
          setStatus('Saved on this phone — it will sync when you are back online.');
        }
      } catch (err) {
        try {
          await enqueue('profile.update', { notification_prefs: next }, userId);
          await refreshPending();
          setStatus('Saved on this phone — it will sync when you are back online.');
        } catch {
          setError(friendlyError(err));
        }
      } finally {
        setSaving(false);
      }
    },
    [profile, userId, prefs, isOnline, applyLocalProfilePatch, refreshProfile, refreshPending]
  );

  /**
   * `true` is written out rather than deleting the key.
   *
   * Absence and `true` mean the same thing to every reader (`isKindEnabled` only
   * looks for an explicit `false`), so deleting would be a second representation
   * of one state — and the whole-object save above has no way to express a key
   * removal that a merge-based reader would have to understand.
   */
  const setSwitch = useCallback(
    (key: NotificationSwitchKey, value: boolean) => save({ [key]: value }),
    [save]
  );

  return {
    prefs,
    rows,
    osStatus,
    blockedReason: notifierBlockedReason(),
    saving,
    error,
    status,
    refreshOsStatus,
    requestPermission,
    save,
    setSwitch,
  };
}
