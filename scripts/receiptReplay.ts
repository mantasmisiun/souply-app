/**
 * Off-device parser replay against logged batch OCR.
 *
 * The dev batch harness persists every receipt's raw OCR geometry to
 * souply-api/receipts/_logs/<chain>/<file>/rawLines.json (plus per-platform
 * copies rawLines.<ios|android>.json — the two OCR combos no longer clobber
 * each other). This script re-parses those frozen lines with the CURRENT
 * parser code, so parser changes iterate in seconds without a phone. Replay
 * covers PARSING only — OCR-level changes (mlkitOcr, receiptOcrPipeline)
 * still need a device batch rerun.
 *
 *   npx tsx scripts/receiptReplay.ts <chain> <file-fragment> [trace|extract]
 *   npx tsx scripts/receiptReplay.ts <chain> --sweep [--platform ios|android]
 *   npx tsx scripts/receiptReplay.ts <chain> --score [--platform ios|android]
 *
 * --platform prefers rawLines.<platform>.json (falls back to rawLines.json)
 * and, for --score, the matching truth flavor (.truth.android.json for
 * android; the base .truth.json for ios).
 *
 * --score compares every replayed receipt against its item-truth file via
 * the SAME comparator the phone uses (utils/itemTruth): per receipt a
 * summary line, then a chain scoreboard:
 *   exact — asserted products matching every field
 *   near  — name-only diffs within the cross-OCR-engine similarity band
 *   differ / lost — real regressions to look at
 *
 * Sweep flags per receipt (vs the stored device parse in parsedData.json):
 *   JUNK   — nameless/priceless products in the replay
 *   DRIFT  — |sum(line totals) − footer total| > €0.90
 *   COUNT  — product count changed vs the stored parse (regression OR fix — look)
 *
 * IKI is NOT supported: it parses row-MERGED lines built inside the React Native
 * OCR pipeline; its logs can't be replayed faithfully here.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseRimiReceipt, traceReceiptBandsRimi, traceRimiExtract } from '../shared/parsers/rimiParser';
import { parseMaximaReceipt, traceProductBands, traceMaximaExtract } from '../shared/parsers/maximaParser';
import { parseNorfaReceipt, traceReceiptBandsNorfa, traceNorfaExtract } from '../shared/parsers/norfaParser';
import { parseLidlReceipt, traceReceiptBandsLidl, traceLidlExtract } from '../shared/parsers/lidlParser';
import { compareItemTruth, isItemTruthFile } from '../utils/itemTruth';

const LOGS_ROOT = path.resolve(__dirname, '../../souply-api/receipts/_logs');
const TRUTH_ROOT = path.resolve(__dirname, '../../shared/receipts');
// The fragment merger runs on BOTH platforms' OCR (Android's tiled+fused
// document mode fragments rows the same way iOS MLKit does).
const OPTS = { iosOcr: true };

type Entry = { parse: (rl: any[]) => any; trace?: (rl: any[]) => string; extract?: (rl: any[]) => string };
const CHAINS: Record<string, Entry> = {
    rimi: { parse: (rl) => parseRimiReceipt(rl), trace: (rl) => traceReceiptBandsRimi(rl), extract: (rl) => traceRimiExtract(rl) },
    maxima: { parse: (rl) => parseMaximaReceipt(rl, OPTS), trace: (rl) => traceProductBands(rl, OPTS), extract: (rl) => traceMaximaExtract(rl) },
    norfa: { parse: (rl) => parseNorfaReceipt(rl), trace: (rl) => traceReceiptBandsNorfa(rl), extract: (rl) => traceNorfaExtract(rl) },
    lidl: { parse: (rl) => parseLidlReceipt(rl, OPTS), trace: (rl) => traceReceiptBandsLidl(rl), extract: (rl) => traceLidlExtract(rl) },
};

const argv = process.argv.slice(2);
const platIdx = argv.indexOf('--platform');
const platform = platIdx >= 0 ? argv.splice(platIdx, 2)[1] : null;
if (platform && platform !== 'ios' && platform !== 'android') {
    console.log('--platform must be ios or android');
    process.exit(1);
}
const [chain, target, mode] = argv;
const entry = chain ? CHAINS[chain] : undefined;
if (!entry || !target) {
    console.log('usage: npx tsx scripts/receiptReplay.ts <rimi|maxima|norfa|lidl> <file-fragment|--sweep|--score> [trace|extract] [--platform ios|android]');
    process.exit(1);
}
const root = path.join(LOGS_ROOT, chain);
if (!fs.existsSync(root)) { console.log(`no logs at ${root}`); process.exit(1); }

/** Platform-preferred rawLines path for a receipt dir (null = none). */
const rawLinesPath = (dir: string): string | null => {
    const cands = platform
        ? [`rawLines.${platform}.json`, 'rawLines.json']
        : ['rawLines.json'];
    for (const c of cands) {
        const p = path.join(root, dir, c);
        if (fs.existsSync(p)) return p;
    }
    return null;
};
const dirs = fs.readdirSync(root).sort().filter((d) => rawLinesPath(d) !== null);

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const printProducts = (r: any) => {
    r.products.forEach((p: any, i: number) => console.log(
        `${String(i + 1).padStart(2)}.`, (p.name ?? '?').slice(0, 48).padEnd(48),
        'p', p.price, 'promo', p.promoPrice ?? null, 'q', p.quantity, p.unit ?? '',
        'amt', p.parsedAmount ?? p.amount ?? null,
    ));
    console.log('total', r.footer.total, '| date', r.footer.date ?? '?');
};

/** Truth file for a receipt dir, honoring the platform flavor. */
const loadTruth = (dir: string): any | null => {
    const base = dir.replace(/\.(pdf|png|jpg|jpeg)$/i, '');
    const cands = platform === 'android'
        ? [`${base}.truth.android.json`, `${base}.truth.json`]
        : [`${base}.truth.json`];
    for (const c of cands) {
        const p = path.join(TRUTH_ROOT, chain, c);
        if (fs.existsSync(p)) {
            const j = readJson(p);
            if (isItemTruthFile(j)) return j;
        }
    }
    return null;
};

if (target === '--score') {
    // Per-combo scoreboard vs item-truth — the performance tracker.
    let exact = 0, near = 0, differ = 0, lost = 0, unchecked = 0;
    let footOk = 0, footBad = 0, footNone = 0;
    let receipts = 0, noTruth = 0;
    for (const dir of dirs) {
        const truth = loadTruth(dir);
        if (!truth) { noTruth++; continue; }
        let r: any;
        try { r = entry.parse(readJson(rawLinesPath(dir)!)); }
        catch (e) { console.log(`${dir.padEnd(44)} ERR ${(e as Error).message.slice(0, 50)}`); continue; }
        const cmp = compareItemTruth(truth, r.products, r.footer);
        receipts++;
        const counts = { match: 0, near: 0, differ: 0, unchecked: 0 } as Record<string, number>;
        for (const p of cmp.perProduct) counts[p.state]++;
        exact += counts.match; near += counts.near; differ += counts.differ; unchecked += counts.unchecked;
        lost += cmp.missing.length;
        if (cmp.footer === 'match') footOk++;
        else if (cmp.footer === 'differ') footBad++;
        else footNone++;
        const flags =
            (counts.differ ? ` differ=${counts.differ}` : '') +
            (cmp.missing.length ? ` lost=${cmp.missing.map((m: any) => m.name).join('|').slice(0, 40)}` : '') +
            (cmp.footer === 'differ' ? ` FOOTER ${cmp.footerDiffs.join(',').slice(0, 50)}` : '');
        console.log(`${dir.padEnd(44)} ${cmp.summary.padEnd(9)} ✓${counts.match} ≈${counts.near} ✗${counts.differ} ?${counts.unchecked}${flags}`);
        if (counts.differ) {
            for (const p of cmp.perProduct) if (p.state === 'differ') console.log(`    ✗ ${p.diffs.join(' ; ').slice(0, 110)}`);
        }
    }
    const asserted = exact + near + differ + lost;
    const pct = (n: number) => asserted ? `${Math.round((n / asserted) * 100)}%` : '—';
    console.log(`\n${chain}${platform ? ` [${platform}]` : ''}: receipts=${receipts} (noTruth=${noTruth})`);
    console.log(`  products asserted=${asserted}: exact ${exact} (${pct(exact)}) · near ${near} (${pct(near)}) · differ ${differ} (${pct(differ)}) · lost ${lost} (${pct(lost)})`);
    console.log(`  unchecked parsed=${unchecked} · footer: ok ${footOk} / differ ${footBad} / unchecked ${footNone}`);
    process.exit(0);
}

if (target === '--sweep') {
    for (const dir of dirs) {
        try {
            const r = entry.parse(readJson(rawLinesPath(dir)!));
            const storedPath = path.join(root, dir, 'parsedData.json');
            const stored = fs.existsSync(storedPath) ? readJson(storedPath) : null;
            const paid = r.products.reduce(
                (s: number, p: any) => s + ((p.promoPrice ?? p.price) ?? 0) * (p.quantity > 0 ? p.quantity : 1), 0);
            const junk = r.products.filter((p: any) => !p.name || p.name === '?' || !(p.price > 0)).length;
            const drift = Math.round((paid - (r.footer.total ?? 0)) * 100) / 100;
            const amts = r.products.filter((p: any) => p.parsedAmount != null || p.unit === 'kg').length;
            const oldN = stored ? (stored.products ?? []).length : r.products.length;
            const recon = r.footer.reconciled === true ? '✓'
                : r.footer.reconDelta != null ? `✗Δ${r.footer.reconDelta}` : '—';
            const flag = (junk ? ' JUNK' : '')
                + (Math.abs(drift) > 0.9 ? ` DRIFT=${drift}` : '')
                + (r.products.length !== oldN ? ` COUNT ${oldN}→${r.products.length}` : '');
            console.log(`${dir.padEnd(44)} n=${String(r.products.length).padStart(2)} amt=${String(amts).padStart(2)} total=${r.footer.total} recon=${recon}${flag}`);
        } catch (e) {
            console.log(`${dir.padEnd(44)} ERR ${(e as Error).message.slice(0, 60)}`);
        }
    }
    process.exit(0);
}

const matches = dirs.filter((d) => d.toLowerCase().includes(target.toLowerCase()));
if (matches.length !== 1) {
    console.log(matches.length === 0 ? `no log dir matching "${target}"` : `ambiguous "${target}":`);
    matches.forEach((m) => console.log(' ', m));
    process.exit(1);
}
const rl = readJson(rawLinesPath(matches[0])!);
console.log(`— ${chain}/${matches[0]} (${rl.length} lines${platform ? `, ${platform}` : ''}) —`);
if (mode === 'trace' && entry.trace) console.log(entry.trace(rl));
else if (mode === 'extract' && entry.extract) console.log(entry.extract(rl));
else printProducts(entry.parse(rl));
