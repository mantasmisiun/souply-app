import * as fs from 'fs';
import * as path from 'path';

/**
 * Guard: the app's ./shared is a CP-COPY of the root ../shared (npm run sync-shared).
 * Nothing else detects divergence — an edit to the root without a re-sync ships stale
 * parser/config code to the app (and Metro caches make it worse), while an edit to the
 * COPY is silently lost on the next sync. This test fails loudly on any drift.
 *
 * Skips when the root checkout isn't present (CI checks out souply-app standalone).
 */
const ROOT_SHARED = path.resolve(__dirname, '../../shared');
const APP_SHARED = path.resolve(__dirname, '../shared');

const listFiles = (dir: string, base = dir): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.name === '.git' || e.name === 'node_modules') return [];
        const full = path.join(dir, e.name);
        return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
    });

const rootExists = fs.existsSync(ROOT_SHARED) && fs.existsSync(APP_SHARED);
const maybeDescribe = rootExists ? describe : describe.skip;

maybeDescribe('shared/ copy is in sync with the root shared/ (run npm run sync-shared)', () => {
    test('every root source file exists in the copy with identical content', () => {
        const rootFiles = listFiles(ROOT_SHARED).filter((f) => /\.(ts|tsx|js|json)$/.test(f));
        const diverged: string[] = [];
        for (const rel of rootFiles) {
            const appPath = path.join(APP_SHARED, rel);
            if (!fs.existsSync(appPath)) {
                diverged.push(`${rel} (missing in app copy)`);
                continue;
            }
            if (fs.readFileSync(path.join(ROOT_SHARED, rel), 'utf8') !== fs.readFileSync(appPath, 'utf8')) {
                diverged.push(rel);
            }
        }
        if (diverged.length > 0) {
            throw new Error(
                `shared/ copy diverged from the root shared/ — run \`npm run sync-shared\` ` +
                `(or port app-side edits back to the root FIRST, they are lost on sync):\n  ` +
                diverged.join('\n  '),
            );
        }
    });
});
