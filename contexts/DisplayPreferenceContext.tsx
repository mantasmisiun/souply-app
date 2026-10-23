/**
 * Global "detalumas" preference. Controls whether the app browses and
 * baskets at BaseProduct granularity ("mažiau" = cluster-head rows, cheapest
 * variant per store) or Product granularity ("daugiau" = individual SKUs).
 *
 * Persisted to AsyncStorage so it survives app restart. Default is 'sku'
 * (individual products) — the toggle is opt-in.
 *
 * Usage:
 *   const { mode, setMode, ready } = useDisplayMode();
 *   // `ready` is false on cold start until AsyncStorage has been read.
 *   // Defer preference-dependent fetches until `ready === true` to avoid
 *   // a flash of the default mode before the stored value loads.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type DisplayMode = 'base' | 'sku';

const STORAGE_KEY = 'displayMode';
const DEFAULT_MODE: DisplayMode = 'sku';

interface DisplayPreferenceValue {
  mode: DisplayMode;
  setMode: (m: DisplayMode) => void;
  ready: boolean;
}

const DisplayPreferenceContext = createContext<DisplayPreferenceValue | null>(null);

export function DisplayPreferenceProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<DisplayMode>(DEFAULT_MODE);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (stored === 'base' || stored === 'sku') {
          setModeState(stored);
        }
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const setMode = useCallback((m: DisplayMode) => {
    setModeState(m);
    // Fire-and-forget write — UI reacts to state instantly, persistence
    // catches up async. A failed write means the preference resets on
    // next cold start; acceptable.
    AsyncStorage.setItem(STORAGE_KEY, m).catch(() => {});
  }, []);

  // Memoised — this provider sits inside RootLayout, so a fresh value object
  // per render would re-render every consumer (the big list screens) on any
  // root re-render even when mode/ready are unchanged.
  const value = useMemo(() => ({ mode, setMode, ready }), [mode, setMode, ready]);

  return (
    <DisplayPreferenceContext.Provider value={value}>
      {children}
    </DisplayPreferenceContext.Provider>
  );
}

export function useDisplayMode(): DisplayPreferenceValue {
  const ctx = useContext(DisplayPreferenceContext);
  if (!ctx) {
    throw new Error('useDisplayMode must be used inside <DisplayPreferenceProvider>');
  }
  return ctx;
}
