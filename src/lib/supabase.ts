import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

/**
 * Supabase client, configured for React Native.
 *
 * Three RN-specific details, each of which breaks something if omitted:
 *
 *   storage: AsyncStorage — the JS SDK defaults to localStorage, which does
 *     not exist in React Native. Without this the session is lost on every
 *     app restart and the student re-logs in constantly.
 *
 *   detectSessionInUrl: false — that flag is for OAuth redirects in a browser.
 *     There is no URL to parse in a native app.
 *
 *   react-native-url-polyfill — the SDK builds request URLs with the WHATWG
 *     URL API, which RN's Hermes engine does not fully implement. Imported
 *     first, before anything touches the network.
 */

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Fail loudly and early with a message that says what to do.
 *
 * A missing env var otherwise surfaces as an opaque network error on the
 * first query, several screens into the app, which is a miserable thing to
 * debug on a phone.
 */
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase config.\n\n' +
      'Copy .env.example to .env and fill in EXPO_PUBLIC_SUPABASE_URL and ' +
      'EXPO_PUBLIC_SUPABASE_ANON_KEY from your Supabase dashboard ' +
      '(Project Settings -> API), then restart the dev server with ' +
      '`npx expo start --clear`.\n\n' +
      'Expo only reads .env at startup, so a running server will not pick up ' +
      'a newly created file.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
  global: {
    headers: { 'x-application-name': 'studysync' },
  },
});

/**
 * Turn a Supabase/Postgres error into something a student can act on.
 *
 * Raw Postgres errors are the wrong register for a UI ("duplicate key value
 * violates unique constraint user_courses_unique"), and a bare network
 * failure needs to read as "you're offline" given the hostel-wifi context
 * this app is designed around.
 */
export function friendlyError(error: unknown): string {
  if (!error) return 'Something went wrong. Please try again.';

  const err = error as { message?: string; code?: string };
  const message = err.message ?? String(error);

  // Postgres error codes are more reliable than message text, which varies
  // between Postgres versions and PostgREST releases.
  switch (err.code) {
    case '23505': // unique_violation
      return "You've already added that.";
    case '23503': // foreign_key_violation
      return 'That item no longer exists. Pull down to refresh and try again.';
    case '42501': // insufficient_privilege — an RLS policy rejected the write
      return "You don't have permission to do that.";
    case 'PGRST301': // JWT expired
      return 'Your session expired. Please sign in again.';
  }

  if (/duplicate key|already exists/i.test(message)) {
    return "You've already added that.";
  }
  if (/network request failed|fetch failed|timeout/i.test(message)) {
    return "Can't reach the server. Check your connection — your changes are saved and will sync automatically.";
  }
  if (/invalid login credentials/i.test(message)) {
    return 'That email or password is incorrect.';
  }
  if (/email not confirmed/i.test(message)) {
    return 'Please confirm your email address first, then sign in.';
  }
  if (/user already registered/i.test(message)) {
    return 'An account with that email already exists. Try signing in.';
  }
  if (/password should be at least/i.test(message)) {
    return 'Password must be at least 6 characters.';
  }

  return message;
}

/** True for errors that mean "retry later", so the outbox knows to requeue. */
export function isNetworkError(error: unknown): boolean {
  if (!error) return false;
  const message = (error as { message?: string }).message ?? String(error);
  return /network request failed|fetch failed|timeout|socket|ECONN/i.test(message);
}
