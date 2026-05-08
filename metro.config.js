// Metro config. The parsers live in `Project/shared/parsers/` —
// outside basket-app. We point at the IN-PROJECT `./shared/` copy
// (populated by `npm run sync-shared` from `../shared`) rather than
// `../shared` directly: EAS Build uploads only the basket-app tree,
// so a watchFolder pointing OUTSIDE the project root resolves to a
// nonexistent path on the EAS worker and Metro fails with
// `verifyRootExists ENOENT '/home/expo/workingdir/shared'` before
// bundling. Pointing at `./shared` keeps both local dev and EAS
// happy because the synced copy lives inside the upload tree.
//
// Cross-stack `.js` extension shim: the basket-api uses TypeScript
// with `module: Node16` which mandates explicit `.js` extensions on
// relative imports (TS spec for ESM). Metro doesn't recognize those
// — it can't find `maximaParser.js` because the source is
// `maximaParser.ts`. This resolveRequest hook strips a `.js`
// suffix when the request comes from a `.ts`/`.tsx` file, so the
// SAME shared file works under both runtimes without conditional
// imports or duplicate code.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, 'shared');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [...(config.watchFolders ?? []), sharedRoot];
config.resolver.nodeModulesPaths = [
    path.resolve(projectRoot, 'node_modules'),
    path.resolve(sharedRoot, 'node_modules'),
];

const baseResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
    // Relative `.js` import from a TS source: try the `.ts`/`.tsx`
    // sibling first. Falls through to default behaviour if neither
    // exists, so non-TS shared modules still resolve normally.
    if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
        const stripped = moduleName.replace(/\.js$/, '');
        try {
            return context.resolveRequest(context, stripped, platform);
        } catch {
            // fall through to default below
        }
    }
    return baseResolveRequest
        ? baseResolveRequest(context, moduleName, platform)
        : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
