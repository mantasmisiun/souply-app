/**
 * Off-device parser replay against logged batch OCR.
 *
 * The dev batch harness persists every receipt's raw OCR geometry to
 * souply-api/receipts/_logs/<chain>/<file>/rawLines.json. This script re-parses
 * those frozen lines with the CURRENT parser code, so parser changes iterate in
 * seconds without a phone. Replay covers PARSING only — OCR-level changes
 * (mlkitOcr, receiptOcrPipeline) still need a device batch rerun.
 *
 *   npx tsx scripts/receiptReplay.ts <chain> <file-fragment> [trace|extract]
 *   npx tsx scripts/receiptReplay.ts <chain> --sweep
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

const LOGS_ROOT = path.resolve(__dirname, '../../souply-api/receipts/_logs');
// Batch logs come from the iOS dev device — match its parser options.
const OPTS = { iosOcr: true };

type Entry = { parse: (rl: any[]) => any; trace?: (rl: any[]) => string; extract?: (rl: any[]) => string };
const CHAINS: Record<string, Entry> = {
    rimi: { parse: (rl) => parseRimiReceipt(rl), trace: (rl) => traceReceiptBandsRimi(rl), extract: (rl) => traceRimiExtract(rl) },
    maxima: { parse: (rl) => parseMaximaReceipt(rl, OPTS), trace: (rl) => traceProductBands(rl, OPTS), extract: (rl) => traceMaximaExtract(rl) },
    norfa: { parse: (rl) => parseNorfaReceipt(rl), trace: (rl) => traceReceiptBandsNorfa(rl), extract: (rl) => traceNorfaExtract(rl) },
    lidl: { parse: (rl) => parseLidlReceipt(rl, OPTS), trace: (rl) => traceReceiptBandsLidl(rl), extract: (rl) => traceLidlExtract(rl) },
};

const [chain, target, mode] = process.argv.slice(2);
const entry = chain ? CHAINS[chain] : undefined;
if (!entry || !target) {
    console.log('usage: npx tsx scripts/receiptReplay.ts <rimi|maxima|norfa|lidl> <file-fragment|--sweep> [trace|extract]');
    process.exit(1);
}
const root = path.join(LOGS_ROOT, chain);
if (!fs.existsSync(root)) { console.log(`no logs at ${root}`); process.exit(1); }
const dirs = fs.readdirSync(root).sort().filter((d) => fs.existsSync(path.join(root, d, 'rawLines.json')));

const readJson = (...p: string[]) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));
const printProducts = (r: any) => {
    r.products.forEach((p: any, i: number) => console.log(
        `${String(i + 1).padStart(2)}.`, (p.name ?? '?').slice(0, 48).padEnd(48),
        'p', p.price, 'promo', p.promoPrice ?? null, 'q', p.quantity, p.unit ?? '',
        'amt', p.parsedAmount ?? p.amount ?? null,
    ));
    console.log('total', r.footer.total, '| date', r.footer.date ?? '?');
};

if (target === '--sweep') {
    for (const dir of dirs) {
        try {
            const r = entry.parse(readJson(root, dir, 'rawLines.json'));
            const stored = fs.existsSync(path.join(root, dir, 'parsedData.json'))
                ? readJson(root, dir, 'parsedData.json') : null;
            const paid = r.products.reduce(
                (s: number, p: any) => s + ((p.promoPrice ?? p.price) ?? 0) * (p.quantity > 0 ? p.quantity : 1), 0);
            const junk = r.products.filter((p: any) => !p.name || p.name === '?' || !(p.price > 0)).length;
            const drift = Math.round((paid - (r.footer.total ?? 0)) * 100) / 100;
            const amts = r.products.filter((p: any) => p.parsedAmount != null || p.unit === 'kg').length;
            const oldN = stored ? (stored.products ?? []).length : r.products.length;
            const flag = (junk ? ' JUNK' : '')
                + (Math.abs(drift) > 0.9 ? ` DRIFT=${drift}` : '')
                + (r.products.length !== oldN ? ` COUNT ${oldN}→${r.products.length}` : '');
            console.log(`${dir.padEnd(44)} n=${String(r.products.length).padStart(2)} amt=${String(amts).padStart(2)} total=${r.footer.total}${flag}`);
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
const rl = readJson(root, matches[0], 'rawLines.json');
console.log(`— ${chain}/${matches[0]} (${rl.length} lines) —`);
if (mode === 'trace' && entry.trace) console.log(entry.trace(rl));
else if (mode === 'extract' && entry.extract) console.log(entry.extract(rl));
else printProducts(entry.parse(rl));
