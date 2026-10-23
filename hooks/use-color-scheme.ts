import { useColorScheme as useRNColorScheme } from 'react-native';

/**
 * Normalized color scheme: RN 0.86's `useColorScheme()` returns
 * 'light' | 'dark' | 'unspecified' (the "no preference" case is now the
 * string 'unspecified' instead of null). Consumers of this hook only
 * understand 'light' | 'dark', so map everything non-dark to 'light' —
 * the same default the old `?? 'light'` fallbacks produced.
 */
export function useColorScheme(): 'light' | 'dark' {
  const scheme = useRNColorScheme();
  return scheme === 'dark' ? 'dark' : 'light';
}
