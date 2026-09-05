import { Platform } from 'react-native';
import { isRunningInExpoGo } from 'expo';
import {
  diffReminders,
  isReminderId,
  type PlannedReminder,
  type ScheduledReminder,
} from '@/lib/notificationRules';

/**
 * The ONE file in this project allowed to name `expo-notifications`.
 *
 * Everything else asks this module. That is not tidiness — it is the containment
 * for a live crash (verified in installed source at 57.0.17, the version
 * `expo/bundledNativeModules.json` itself pins):
 *
 *   - `build/warnOfExpoGoPushUsage.js` **throws** rather than warns when
 *     `isRunningInExpoGo()` and `Platform.OS === 'android'`.
 *   - `build/TokenEmitter.js`'s `addPushTokenListener` calls it.
 *   - `build/DevicePushTokenAutoRegistration.fx.js` calls `addPushTokenListener`
 *     **at module scope**, inside `if (ServerRegistrationModule
 *     .getRegistrationInfoAsync)` — and `index.js` re-exports that module, so
 *     merely importing the package evaluates it.
 *
 * Whether the throw fires depends on whether that native method is present in
 * Expo Go's own Android build, which no amount of reading JS settles. So the
 * rule here is belt and braces: the import is a `require()` **inside a
 * function**, reached only after the guard says we are not in Expo Go on
 * Android. Hoisting it to a top-level `import` would move the risk from "this
 * one configuration has no notifications" to "this one configuration has no
 * app", and there is no warning when you get it wrong — the red screen only
 * appears on a physical Android phone running Expo Go.
 *
 * Everything below therefore returns a falsy or empty result instead of
 * throwing. A student whose OS refuses an alarm still gets an app.
 */

/** Type-only, so it costs nothing at runtime and cannot pull the module in. */
type NotificationsModule = typeof import('expo-notifications');

/**
 * Why `app.json` says what it says about alarms — recorded here because `app.json`
 * is strict JSON, rejects comments, and `expo-doctor`'s schema check rejects a
 * `"// permissions"` key too, so this is the only place the reasoning can live.
 *
 *  - `android.permissions: ['SCHEDULE_EXACT_ALARM']` — Android 12+ honours an
 *    EXACT alarm only when the app may schedule one. `ExpoSchedulingDelegate.kt`
 *    checks `alarmManager.canScheduleExactAlarms()` and falls back to
 *    `setAndAllowWhileIdle`, which the OS is free to batch by minutes. A study
 *    reminder that drifts is a reminder that arrives after the session starts.
 *  - `USE_EXACT_ALARM` is deliberately absent. It is auto-granted, but Play policy
 *    restricts it to alarm and calendar apps, and this is neither.
 *  - `RECEIVE_BOOT_COMPLETED` is deliberately absent: `expo-notifications`'
 *    own `android/src/main/AndroidManifest.xml` already declares it, and that is
 *    what carries a pending reminder across a reboot.
 *  - All of it is inert in Expo Go, whose manifest is fixed and prebuilt. Local
 *    alarms still work there; only their exactness is at the OS's discretion.
 */

/** RN has no ambient `require`, and this file needs the real CommonJS one. */
declare const require: (name: string) => unknown;

/** `undefined` = not tried yet, `null` = tried and unavailable. */
let cached: NotificationsModule | null | undefined;
let handlerInstalled = false;
let channelInstalled = false;

/**
 * The Android channel study reminders arrive on.
 *
 * Android 13+ **never shows a permission prompt until a channel exists**, and a
 * notification posted to a channel the user has since muted is dropped in
 * silence. The id is a literal and must never change: renaming it creates a
 * second channel at full volume and orphans whatever the student had already
 * tuned on the first.
 */
export const REMINDER_CHANNEL_ID = 'study-reminders';

/**
 * Why the notifier is not available, in words a screen can show — or null when
 * it is available.
 *
 * Web is out because this is a phone app with a phone alarm in its scope; the
 * browser build exists only so `expo start --web` does not explode.
 */
export function notifierBlockedReason(): string | null {
  if (Platform.OS === 'web') return 'Reminders need the phone app.';
  if (Platform.OS === 'android' && isRunningInExpoGo()) {
    return 'Reminders need a development build on Android, not Expo Go.';
  }
  return null;
}

export function isNotifierAvailable(): boolean {
  return notifierBlockedReason() === null;
}

/**
 * The only `require` of `expo-notifications` in the codebase. Do not add another,
 * and do not turn this into an `import` — see the header.
 */
function loadNotifications(): NotificationsModule | null {
  if (cached !== undefined) return cached;
  if (!isNotifierAvailable()) {
    cached = null;
    return null;
  }
  try {
    cached = require('expo-notifications') as NotificationsModule;
  } catch (error) {
    console.warn('[notifier] expo-notifications failed to load', error);
    cached = null;
  }
  return cached;
}

// ---------------------------------------------------------------------------
// Setup — three things, in this order, or nothing fires
// ---------------------------------------------------------------------------

/**
 * Without a handler, a notification that arrives while the app is FOREGROUNDED is
 * swallowed with no error at all — which reads exactly like a scheduling bug and
 * is the single most common way this library is written off as broken.
 *
 * `shouldSetBadge` is false on purpose: Stage 3 already badges unread chat inside
 * the app off `last_read_at`, and a study reminder is not an unread message. Two
 * systems writing one number is how a badge gets stuck.
 */
function installHandler(mod: NotificationsModule): void {
  if (handlerInstalled) return;
  mod.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  handlerInstalled = true;
}

/**
 * Must run BEFORE any permission request on Android, per the note on
 * `REMINDER_CHANNEL_ID`.
 *
 * `audioAttributes.usage: ALARM` is the field that makes this the phone's alarm
 * rather than a notification chirp. It moves the sound onto the device's ALARM
 * audio stream — alarm volume, which is the one volume a student does not turn
 * down — and it is how Android classifies the sound for Do Not Disturb, whose
 * default policy lets alarms through. `enforceAudibility` is Android's
 * `FLAG_AUDIBILITY_ENFORCED` (`AndroidXNotificationsChannelManager.java:200`),
 * asking the OS to sound it even on a muted stream. `importance: MAX` adds the
 * heads-up banner; `PUBLIC` puts it on the lock screen, where a T-30 reminder is
 * actually read.
 *
 * The tone is the device's default NOTIFICATION tone played at alarm volume, not
 * its alarm ringtone. That is a library limit, not a choice: `SoundResolver.kt`
 * maps `'default'` to `Settings.System.DEFAULT_NOTIFICATION_URI` or to a raw
 * resource bundled in the app, and never to `DEFAULT_ALARM_ALERT_URI`. Shipping a
 * true alarm tone means adding an audio file to the config plugin and naming it
 * here — a follow-up needing a dev build, not a blocker.
 *
 * `bypassDnd` is deliberately absent: an app cannot grant itself Do Not Disturb
 * access, so setting it would read like a feature while doing nothing.
 *
 * Idempotent, but only just. Android applies a CHANGED importance, sound or
 * vibration to an existing channel at most once and in practice not at all — the
 * student owns those after creation. Nothing has created this channel on a real
 * device yet, so this is the last point these values can change without burning
 * the id.
 */
async function installChannel(mod: NotificationsModule): Promise<void> {
  if (channelInstalled || Platform.OS !== 'android') return;
  try {
    await mod.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
      name: 'Study time alarms',
      description: 'Rings 30 minutes before a study time your group agreed on.',
      importance: mod.AndroidImportance.MAX,
      lockscreenVisibility: mod.AndroidNotificationVisibility.PUBLIC,
      sound: 'default',
      audioAttributes: {
        usage: mod.AndroidAudioUsage.ALARM,
        contentType: mod.AndroidAudioContentType.SONIFICATION,
        flags: { enforceAudibility: true, requestHardwareAudioVideoSynchronization: false },
      },
      vibrationPattern: [0, 500, 250, 500, 250, 500],
      enableVibrate: true,
      showBadge: false,
    });
    channelInstalled = true;
  } catch (error) {
    console.warn('[notifier] could not create the reminder channel', error);
  }
}

/**
 * What this device can actually do about reminders.
 *
 *  - `unavailable` — the notifier is blocked here (see `notifierBlockedReason`).
 *  - `denied` — the OS said no, or the student did. Nothing to retry in code; the
 *    prefs screen sends them to Settings.
 *  - `ready` — alarms can be placed.
 */
export type NotifierStatus = 'ready' | 'denied' | 'unavailable';

/**
 * Idempotent setup, safe to call on every app start and from the prefs screen.
 *
 * `askIfNeeded` is false by default so a background sync never triggers a system
 * prompt out of nowhere. The screen that explains what reminders are passes true;
 * that is the moment a student expects to be asked.
 */
export async function ensureNotifierReady(askIfNeeded = false): Promise<NotifierStatus> {
  const mod = loadNotifications();
  if (!mod) return 'unavailable';

  try {
    installHandler(mod);
    await installChannel(mod);

    const current = await mod.getPermissionsAsync();
    if (current.granted) return 'ready';
    // Not granted and not asking: 'denied' either way, since the effect on the
    // caller is identical — no alarm can be placed right now.
    if (!askIfNeeded) return 'denied';

    const asked = await mod.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    return asked.granted ? 'ready' : 'denied';
  } catch (error) {
    console.warn('[notifier] setup failed', error);
    return 'unavailable';
  }
}

// ---------------------------------------------------------------------------
// Placing, reading back and cancelling alarms
// ---------------------------------------------------------------------------

/**
 * Place one alarm. Returns whether the OS took it.
 *
 * The identifier is `PlannedReminder.id`, derived from the session id, so
 * scheduling the same session twice REPLACES rather than duplicates — which is
 * the second line of defence behind `diffReminders`.
 *
 * On Android everything audible is decided by the channel (see `installChannel`);
 * `sound` here only keeps the library from marking the notification silent
 * (`ExpoNotificationBuilder.kt:163`).
 *
 * iOS has no alarm stream a third-party app may use, so `timeSensitive` is as
 * close to an alarm as Apple permits: it breaks through Focus and Scheduled
 * Summary. It needs the Time Sensitive Notifications entitlement on the eventual
 * dev build; without it iOS ignores the field, so this is safe to ship now. Going
 * further — sounding through the silent switch — requires `'critical'` plus an
 * entitlement Apple grants by individual application, which a study app will not
 * get. On an iPhone with the ringer off, the reminder is therefore a silent banner
 * and a lock-screen entry, and the Android phone is the one that rings.
 */
export async function scheduleReminder(reminder: PlannedReminder): Promise<boolean> {
  const mod = loadNotifications();
  if (!mod) return false;
  try {
    await mod.scheduleNotificationAsync({
      identifier: reminder.id,
      content: {
        title: reminder.title,
        body: reminder.body,
        sound: 'default',
        interruptionLevel: 'timeSensitive',
        data: { kind: 'session_reminder', sessionId: reminder.sessionId },
      },
      trigger: {
        type: mod.SchedulableTriggerInputTypes.DATE,
        date: reminder.fireAt,
        channelId: REMINDER_CHANNEL_ID,
      },
    });
    return true;
  } catch (error) {
    console.warn(`[notifier] could not schedule ${reminder.id}`, error);
    return false;
  }
}

export async function cancelReminder(id: string): Promise<boolean> {
  const mod = loadNotifications();
  if (!mod) return false;
  try {
    await mod.cancelScheduledNotificationAsync(id);
    return true;
  } catch (error) {
    console.warn(`[notifier] could not cancel ${id}`, error);
    return false;
  }
}

/**
 * A pending `DATE` trigger's fire time, or null when it cannot be read.
 *
 * `getAllScheduledNotificationsAsync` types `trigger` as a union that includes
 * push, location and repeating triggers, and `date` itself as `Date | number`.
 * Rather than trust one platform's shape, this narrows defensively and hands null
 * to `diffReminders`, which treats unknown as stale and re-places the alarm.
 */
function readFireTime(trigger: unknown): Date | null {
  if (!trigger || typeof trigger !== 'object') return null;
  const t = trigger as { type?: unknown; date?: unknown; value?: unknown };
  if (t.type !== 'date') return null;
  const raw = t.date ?? t.value;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'number' || typeof raw === 'string') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Only OUR pending alarms — `isReminderId` keeps other features' out of the diff. */
export async function listScheduledReminders(): Promise<ScheduledReminder[]> {
  const mod = loadNotifications();
  if (!mod) return [];
  try {
    const all = await mod.getAllScheduledNotificationsAsync();
    return all
      .filter((request) => isReminderId(request.identifier))
      .map((request) => ({ id: request.identifier, fireAt: readFireTime(request.trigger) }));
  } catch (error) {
    console.warn('[notifier] could not read pending reminders', error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// The one call a screen makes
// ---------------------------------------------------------------------------

export interface SyncResult {
  status: NotifierStatus;
  scheduled: number;
  cancelled: number;
}

/**
 * Make the device's pending alarms match `planned`, and nothing else.
 *
 * This is the whole local half in one function, and it is deliberately a full
 * reconcile rather than an incremental "on confirm, schedule; on cancel, cancel".
 * Incremental bookkeeping has to survive a force quit between the RPC succeeding
 * and the alarm being placed, a session confirmed while this phone was offline,
 * and a reinstall — and it does not. Asking the OS what it holds does.
 *
 * Cancels run FIRST because a moved session appears in both lists (see
 * `diffReminders`), and the schedule must win.
 *
 * When permission is missing the pending alarms are left exactly as they are: a
 * student who has just turned notifications off has nothing to gain from us
 * quietly tearing down alarms they may re-enable in a minute, and the OS is not
 * going to fire them meanwhile anyway.
 */
export async function syncReminders(
  planned: readonly PlannedReminder[]
): Promise<SyncResult> {
  const status = await ensureNotifierReady();
  if (status !== 'ready') return { status, scheduled: 0, cancelled: 0 };

  const { toSchedule, toCancel } = diffReminders(planned, await listScheduledReminders());

  let cancelled = 0;
  for (const id of toCancel) {
    if (await cancelReminder(id)) cancelled += 1;
  }
  let scheduled = 0;
  for (const reminder of toSchedule) {
    if (await scheduleReminder(reminder)) scheduled += 1;
  }
  return { status, scheduled, cancelled };
}

/**
 * Drop every study reminder this device holds. For sign-out.
 *
 * Not `cancelAllScheduledNotificationsAsync` — that would take anything else the
 * app had scheduled with it. The alarms must go on sign-out because they name a
 * group and a time: leaving them behind means the next person to open this phone
 * is told about a stranger's study session.
 */
export async function cancelAllReminders(): Promise<number> {
  const pending = await listScheduledReminders();
  let cancelled = 0;
  for (const { id } of pending) {
    if (await cancelReminder(id)) cancelled += 1;
  }
  return cancelled;
}
