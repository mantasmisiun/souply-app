/**
 * Sheet-surface invariants — pins the "one glass, one inset, one title" rules
 * so the next sheet cannot silently reintroduce the drift this refactor
 * removed ("content padding doesn't match", "shadow is clipped", "title sits
 * too low"):
 *
 *   1. SheetContent applies EXACTLY the shared tokens (peek inset + card-halo
 *      clearance) — the numbers live in ONE place.
 *   2. All three sheet components route their content through SheetContent —
 *      a sheet host composes the primitive and specifies nothing about padding.
 *   3. The tokens are defined ONLY in components/dock/sheetTokens.ts.
 *   4. GlassStageSheet no longer hand-rolls its own blur — every sheet's glass
 *      comes from the shared GlassFill recipe (expo-blur is imported by the
 *      recipe's home alone).
 *   5. The 22/700 sheet-title literal exists only in dock/SheetTitle.tsx —
 *      sheet content uses the component, never a copied style.
 */
import * as fs from 'fs';
import * as path from 'path';
import { StyleSheet, Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { SheetContent } from '../components/dock/SheetContent';
import { SHEET_PEEK, SHEET_CARD_SHADOW_RADIUS } from '../components/dock/sheetTokens';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('sheet surface invariants', () => {
    it('SheetContent applies exactly the shared inset tokens', () => {
        const { getByTestId } = render(
            <SheetContent><Text>x</Text></SheetContent>,
        );
        const style = StyleSheet.flatten(getByTestId('sheet-content').props.style);
        expect(style.paddingHorizontal).toBe(SHEET_PEEK);
        expect(style.paddingTop).toBe(SHEET_CARD_SHADOW_RADIUS);
        expect(style.paddingBottom).toBe(SHEET_CARD_SHADOW_RADIUS);
    });

    it('all three sheet components route content through SheetContent', () => {
        for (const rel of [
            'components/DockedGlassSheet.tsx',
            'components/GlassSheet.tsx',
            'components/GlassStageSheet.tsx',
        ]) {
            const src = read(rel);
            expect(src).toMatch(/<SheetContent[\s>]/);
        }
    });

    it('the sheet tokens have exactly one definition site', () => {
        // Walk the app's source (app/ + components/ + constants/) and assert
        // the token names are only ASSIGNED in sheetTokens.ts. Imports and
        // reads are fine everywhere; a second `= <number>` is the drift.
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(p); continue; }
                if (!/\.(ts|tsx)$/.test(entry.name)) continue;
                const rel = path.relative(root, p);
                if (rel === path.join('components', 'dock', 'sheetTokens.ts')) continue;
                const src = fs.readFileSync(p, 'utf8');
                if (/(SHEET_PEEK|SHEET_CARD_SHADOW_RADIUS|DOCK_PEEK)\s*=\s*\d/.test(src)) {
                    offenders.push(rel);
                }
            }
        };
        for (const d of ['app', 'components', 'constants']) walk(path.join(root, d));
        expect(offenders).toEqual([]);
    });

    it('GlassStageSheet does not hand-roll its own blur (one glass recipe)', () => {
        const src = read('components/GlassStageSheet.tsx');
        expect(src).not.toMatch(/expo-blur/);
        expect(src).toMatch(/GlassFill/);
        expect(src).toMatch(/makeGlassLayerStyles/);
    });

    it('the 22/700 sheet-title literal lives only in dock/SheetTitle', () => {
        // Sheet-content homes must use <SheetTitle>, never a copied literal.
        // ScreenHeading (a SCREEN title) and bespoke display figures live
        // outside these directories and are exempt by scope.
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(p); continue; }
                if (!/\.tsx$/.test(entry.name)) continue;
                const rel = path.relative(root, p);
                if (rel === path.join('components', 'dock', 'SheetTitle.tsx')) continue;
                if (rel === path.join('components', 'ScreenHeading.tsx')) continue;
                const src = fs.readFileSync(p, 'utf8');
                if (/fontSize:\s*22,\s*fontWeight:\s*'700'/.test(src)) offenders.push(rel);
            }
        };
        for (const d of [
            path.join('components', 'basket'),
            path.join('components', 'receipt'),
            path.join('components', 'recipe'),
            path.join('components', 'results'),
            path.join('components', 'dock'),
        ]) walk(path.join(root, d));
        expect(offenders).toEqual([]);
    });
});
