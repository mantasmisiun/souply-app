// Explicit babel config (perf audit finding 18). This is exactly the config
// `npx expo customize babel.config.js` generates — `babel-preset-expo` alone —
// plus a PRODUCTION-ONLY plugin that strips console.* calls (207 call sites
// otherwise ship in release bundles). `console.error` is kept: it is the only
// signal some catch paths emit.
//
// IMPORTANT: babel-preset-expo auto-wires `react-native-worklets/plugin`
// (Reanimated 4) in the correct order — see node_modules/babel-preset-expo/
// build/index.js (hasModule('react-native-worklets') → appends the plugin
// last). Do NOT add the worklets/reanimated plugin here manually, and do not
// replace the preset: a hand-rolled preset list is the classic way to break
// worklet compilation. The React Compiler (app.config.js experiments) is also
// enabled through this same preset.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    env: {
      production: {
        plugins: [['transform-remove-console', { exclude: ['error'] }]],
      },
    },
  };
};
