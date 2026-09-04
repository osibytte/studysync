import NetInfo from '@react-native-community/netinfo';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { drainOutbox, pendingCount } from '@/lib/outbox';

/**
 * Connectivity state plus automatic outbox draining.
 *
 * Every screen reads `isOnline` from here to decide whether to show the
 * offline banner and whether a Save should go straight to Supabase or into the
 * queue. Draining lives here rather than in a screen because it must keep
 * working when the student is looking at any screen, or none.
 */

interface NetworkState {
  isOnline: boolean;
  /** Queued writes waiting to sync. Drives the "N changes pending" badge. */
  pending: number;
  syncing: boolean;
  /** Force a drain — used by the pending badge's tap-to-retry. */
  syncNow: () => Promise<void>;
  refreshPending: () => Promise<void>;
}

const NetworkContext = createContext<NetworkState | undefined>(undefined);

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  // Assume online until told otherwise. Assuming offline would make the first
  // render of every screen show an offline banner that immediately vanishes.
  const [isOnline, setIsOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);

  // Ref mirror so the NetInfo callback can compare against current state
  // without being re-subscribed on every change.
  const onlineRef = useRef(true);

  const refreshPending = useCallback(async () => {
    setPending(await pendingCount());
  }, []);

  const runDrain = useCallback(async () => {
    setSyncing(true);
    try {
      await drainOutbox();
    } finally {
      setSyncing(false);
      await refreshPending();
    }
  }, [refreshPending]);

  useEffect(() => {
    void refreshPending();

    const unsubscribe = NetInfo.addEventListener((state) => {
      /**
       * `isInternetReachable` is null while NetInfo is still probing. Treating
       * null as offline causes a spurious banner flash on launch, so only a
       * definite `false` counts as unreachable.
       *
       * This matters more than usual here: hostel wifi frequently associates
       * successfully but has no working uplink, which is exactly the case
       * `isInternetReachable` catches and `isConnected` misses.
       */
      const reachable =
        state.isConnected === true && state.isInternetReachable !== false;

      const wasOnline = onlineRef.current;
      onlineRef.current = reachable;
      setIsOnline(reachable);

      // Drain on the offline -> online edge only, not on every NetInfo event.
      if (!wasOnline && reachable) void runDrain();
    });

    return unsubscribe;
  }, [refreshPending, runDrain]);

  const syncNow = useCallback(async () => {
    if (!onlineRef.current) {
      await refreshPending();
      return;
    }
    await runDrain();
  }, [refreshPending, runDrain]);

  return (
    <NetworkContext.Provider
      value={{ isOnline, pending, syncing, syncNow, refreshPending }}
    >
      {children}
    </NetworkContext.Provider>
  );
}

export function useNetwork(): NetworkState {
  const ctx = useContext(NetworkContext);
  if (!ctx) throw new Error('useNetwork must be used inside a NetworkProvider');
  return ctx;
}
