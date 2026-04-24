// Metro config. Needed because the parsers now live in
// `Project/shared/parsers/` — outside the app's project root. Metro
// ignores anything outside the root by default, so we whitelist the
// shared folder via `watchFolders` and extend `nodeModulesPaths` so
// its relative imports resolve.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '../shared');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [...(config.watchFolders ?? []), sharedRoot];
config.resolver.nodeModulesPaths = [
    path.resolve(projectRoot, 'node_modules'),
    path.resolve(sharedRoot, 'node_modules'),
];

module.exports = config;
