import * as ImageManipulator from 'expo-image-manipulator';
import { Platform } from 'react-native';
import { ocrImageTiled, type OcrLine, type OcrWord } from './mlkitOcr';
import { devLog } from './devLog';
import type { LabeledRegion, RegionKind } from '@shared/parsers/rimiParser';

/**
 * Option A — targeted footer-band re-OCR.
 *
 * The IKI band geometry is built from per-word OCR boxes, but MLKit on Android
 * DROPS ~half of them and returns text in a scrambled reading order, so a footer
 * value whose box dropped (time / receipt-no / a missing half of date+time) gets a
 * GUESSED band — the unstable, non-indicative footer bands. We can't compute the
 * value's position from the scrambled whole-receipt OCR.
 *
 * So instead of guessing geometry, we fix the DATA: crop the thin strip of the
 * receipt image around each footer band, upscale it, and re-OCR it IN ISOLATION.
 * On a small isolated crop MLKit returns clean, complete, correctly-ordered boxes,
 * so we can rebuild the band from REAL pixels and map it back to source space.
 *
 * FAIL-SAFE: if the re-OCR errors, or doesn't find the value, the ORIGINAL band is
 * kept — this can only tighten a band, never regress one. Android/ML Kit only
 * (iOS Apple Vision interpolates its boxes, so its bands are already on the text).
 */

const clean = (s: string): string => s.replace(/[^0-9A-Za-z]/g, '').toLowerCase();

export interface FooterValues {
    date?: string | null;
    time?: string | null;
    receiptNo?: string | null;
    total?: number | null;
}

function valuesForKind(kind: RegionKind, v: FooterValues): string[] {
    switch (kind) {
        case 'date': return v.date ? [v.date] : [];
        case 'time': return v.time ? [v.time] : [];
        case 'dateTime': return [v.date, v.time].filter((x): x is string => !!x);
        case 'receiptNo': return v.receiptNo ? [v.receiptNo] : [];
        case 'total': return v.total != null ? [v.total.toFixed(2)] : [];
        default: return [];
    }
}

/** Find the contiguous run of words (x-sorted) whose cleaned text contains the value
 *  within ≤3 extra chars — the same guard footBand uses, so a longer id sharing the
 *  value's digits never matches. Returns the matched words or null. */
function locateValueWords(lines: OcrLine[], value: string): OcrWord[] | null {
    const vKey = clean(value);
    if (vKey.length < 2) return null;
    for (const line of lines) {
        const ws = [...(line.words ?? [])].sort((a, b) => a.xLeft - b.xLeft);
        for (let i = 0; i < ws.length; i++) {
            let run = '';
            const group: OcrWord[] = [];
            for (let j = i; j < ws.length && run.length <= vKey.length + 3; j++) {
                run += clean(ws[j].text);
                group.push(ws[j]);
                if (run.includes(vKey) && run.length - vKey.length <= 3) return group;
            }
        }
    }
    return null;
}

async function refineOne(
    pageUri: string,
    region: LabeledRegion,
    values: FooterValues,
    pageWidth: number,
    pageHeight: number,
): Promise<LabeledRegion | null> {
    const targets = valuesForKind(region.kind, values);
    if (!targets.length) return null;

    // Thin strip around the band (generous Y pad so the row is fully inside the crop).
    const padY = Math.max(10, (region.yBottom - region.yTop) * 0.6);
    const cropY0 = Math.max(0, Math.floor(region.yTop - padY));
    const cropH = Math.min(pageHeight, Math.ceil(region.yBottom + padY)) - cropY0;
    if (cropH < 6 || pageWidth < 4) return null;

    // Upscale the strip ~3× (capped) so each glyph clears ML Kit's size floor.
    const targetW = Math.min(Math.round(pageWidth * 3), 2600);
    const f = targetW / pageWidth;

    try {
        const crop = await ImageManipulator.manipulateAsync(
            pageUri,
            [
                { crop: { originX: 0, originY: cropY0, width: pageWidth, height: cropH } },
                { resize: { width: targetW } },
            ],
            { compress: 0.95, format: ImageManipulator.SaveFormat.JPEG },
        );
        const ocr = await ocrImageTiled(crop.uri);

        // Gather every target value's words from the isolated re-OCR (date+time both,
        // for a dateTime band) and span them into one tight, tilt-aware band.
        const words: OcrWord[] = [];
        for (const t of targets) {
            const ws = locateValueWords(ocr.lines, t);
            if (ws) words.push(...ws);
        }
        if (!words.length) return null; // re-OCR didn't find it either → keep original

        const L = words.reduce((a, b) => (b.xLeft < a.xLeft ? b : a));
        const R = words.reduce((a, b) => (b.xRight > a.xRight ? b : a));
        // Map crop-space → source space: x ÷ f ; y ÷ f + cropY0. Small pad for the glyph.
        const mx = (x: number) => x / f;
        const my = (y: number) => y / f + cropY0;
        const xL = mx(Math.min(...words.map((w) => w.xLeft)));
        const xR = mx(Math.max(...words.map((w) => w.xRight)));
        const pad = Math.max(2, (R.yBottom - R.yTop) / f * 0.12);
        devLog('footerRefine.hit', { kind: region.kind, targets });
        return {
            kind: region.kind,
            xLeft: xL - pad, xRight: xR + pad,
            yLeftTop: my(L.yTop) - pad, yRightTop: my(R.yTop) - pad,
            yLeftBottom: my(L.yBottom) + pad, yRightBottom: my(R.yBottom) + pad,
            yTop: my(Math.min(L.yTop, R.yTop)) - pad,
            yBottom: my(Math.max(L.yBottom, R.yBottom)) + pad,
        };
    } catch {
        return null;
    }
}

/**
 * Rebuild each footer field band (date/time/dateTime/receiptNo/total) from a fresh
 * isolated re-OCR of its image strip. Returns a new lineRegions array; any band that
 * can't be re-located is kept unchanged. No-op on iOS / when dims are missing.
 */
export async function refineFooterBands(
    pageUri: string,
    regions: LabeledRegion[],
    values: FooterValues,
    pageWidth: number,
    pageHeight: number,
): Promise<LabeledRegion[]> {
    if (Platform.OS !== 'android' || !pageUri || !(pageWidth > 0) || !(pageHeight > 0)) return regions;
    const out: LabeledRegion[] = [];
    for (const r of regions) {
        out.push((await refineOne(pageUri, r, values, pageWidth, pageHeight)) ?? r);
    }
    return out;
}
