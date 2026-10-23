// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    // The SDK 57 upgrade moved eslint-config-expo 10 → 57, which switches ON the
    // React Compiler rule set. It reported 346 errors across 79 files — all in
    // code that predates the rules, none of them regressions.
    //
    // They stay ENABLED (the signal is worth having) but as warnings, so 346
    // pre-existing findings don't gate every commit through lint-staged. Burn
    // them down per area, then ratchet the cleaned rules back to 'error'.
    //
    // `react-hooks/refs` has a wide blast radius here: it taints a whole `props`
    // object once one field is a ref, so `<MapView ref={props.mapRef} …/>` makes
    // it flag props.children / props.initialRegion / props.onMapReady as "ref
    // access during render" (components/map/MapCanvas.tsx). Those are false
    // positives — don't "fix" them by restructuring working components.
    rules: {
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/globals': 'warn',
    },
  },
  {
    // Node scripts, not part of the app bundle — they legitimately use Buffer,
    // process, __dirname. Without this the flat config gives them only the RN
    // globals and flags those as undefined.
    files: ['documentation/**/*.mjs', 'scripts/**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
      },
    },
  },
]);
