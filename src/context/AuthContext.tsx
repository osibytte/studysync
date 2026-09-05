import type { Session } from '@supabase/supabase-js';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { CacheKeys, cacheClearAll, cacheReadData, cacheWrite } from '@/lib/cache';
import { outboxClearAll } from '@/lib/outbox';
import { forgetReminders } from '@/lib/reminders';
import { supabase } from '@/lib/supabase';
import type { AppUser } from '@/types/database';

/**
 * Auth session and the signed-in student's profile row.
 *
 * Two separate things that are easy to conflate: `session` is Supabase Auth
 * state (is someone signed in), `profile` is the `public.users` row (who they
 * are, and whether they finished onboarding). Routing needs both — a student
 * can be authenticated but not yet through profile setup, and that combination
 * must land them in the onboarding flow rather than the main app.
 */

interface AuthState {
  session: Session | null;
  profile: AppUser | null;
  /** True until the stored session has been checked. Gates the router. */
  initialising: boolean;
  signUp: (
    email: string,
    password: string,
    fullName: string
  ) => Promise<{ needsEmailConfirmation: boolean }>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-read the profile row, e.g. after onboarding completes. */
  refreshProfile: () => Promise<void>;
  /** Patch cached profile immediately for optimistic UI. */
  applyLocalProfilePatch: (patch: Partial<AppUser>) => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<AppUser | null>(null);
  const [initialising, setInitialising] = useState(true);

  /**
   * Load the profile row, falling back to cache.
   *
   * Cache-first is not just an optimisation: a student who opens the app with
   * no connection must still get past the router into the app they already
   * onboarded into. Without the fallback, `profile` would be null offline and
   * they'd be bounced back to profile setup every time.
   */
  const loadProfile = useCallback(async (userId: string) => {
    const cached = await cacheReadData<AppUser>(CacheKeys.profile(userId));
    if (cached) setProfile(cached);

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      // Offline or transient. Keep whatever the cache gave us.
      return;
    }
    if (data) {
      const fresh = data as AppUser;
      setProfile(fresh);
      await cacheWrite(CacheKeys.profile(userId), fresh);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Restore the persisted session before the first render decision.
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      setSession(data.session);
      if (data.session?.user) await loadProfile(data.session.user.id);
      if (!cancelled) setInitialising(false);
    })();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession?.user) {
        void loadProfile(nextSession.user.id);
      } else {
        setProfile(null);
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signUp = useCallback(
    async (email: string, password: string, fullName: string) => {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        // Read by the on_auth_user_created trigger to populate users.full_name,
        // so the name survives even if the app is killed before profile setup.
        options: { data: { full_name: fullName.trim() } },
      });
      if (error) throw error;

      /**
       * If email confirmation is on in the Supabase dashboard, signUp returns
       * a user but no session — the student cannot proceed until they confirm.
       * The caller needs to know which case happened to show the right screen.
       */
      const needsEmailConfirmation = !data.session && !!data.user;
      return { needsEmailConfirmation };
    },
    []
  );

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    if (error) throw error;
  }, []);

  /**
   * Sign out and clear all local state.
   *
   * Cache and outbox are both cleared. Leaving them would mean the next
   * student on a shared phone briefly sees the previous student's cached
   * profile, and worse, their queued writes would replay under the new
   * session. Phone-sharing is normal in this user population, so this is a
   * real scenario rather than a theoretical one.
   *
   * The pending study alarms go too, and they are the worst of the three to
   * forget: they sit in the OS rather than in this app's storage, so clearing the
   * cache does not touch them, and they would go on announcing a stranger's
   * group and meeting time on the lock screen for weeks.
   */
  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    await Promise.all([cacheClearAll(), outboxClearAll(), forgetReminders()]);
    setProfile(null);
    setSession(null);
  }, []);

  const refreshProfile = useCallback(async () => {
    if (session?.user) await loadProfile(session.user.id);
  }, [loadProfile, session]);

  const applyLocalProfilePatch = useCallback((patch: Partial<AppUser>) => {
    setProfile((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      void cacheWrite(CacheKeys.profile(next.user_id), next);
      return next;
    });
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      profile,
      initialising,
      signUp,
      signIn,
      signOut,
      refreshProfile,
      applyLocalProfilePatch,
    }),
    [
      session,
      profile,
      initialising,
      signUp,
      signIn,
      signOut,
      refreshProfile,
      applyLocalProfilePatch,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider');
  return ctx;
}
