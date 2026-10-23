import {
  redactReceiptText,
  wordCentreInMaskBand,
  looksLikePiiText,
  type MaskBand,
} from "@shared/parsers/cardMaskDetection";

/** Structural subset of an OCR line needed to emit wordsDump — matches both the
 *  scan pipeline's LineWithFrame and the queue's merged lines. */
export interface WordsDumpWord {
  text: string;
  xLeft: number;
  xRight: number;
  yTop: number;
  yBottom: number;
  cornerPoints?: { x: number; y: number }[];
}
export interface WordsDumpLine {
  text: string;
  xLeft: number;
  xRight: number;
  yTop: number;
  yBottom: number;
  yLeftTop?: number | null;
  yRightTop?: number | null;
  yLeftBottom?: number | null;
  yRightBottom?: number | null;
  words?: WordsDumpWord[];
}

/**
 * Capture the EXACT per-word lines the parser consumes, so a failing receipt can
 * be reproduced 1:1 off-device (the `receipts:reparse` harness) and in jest.
 * wordsDump ships in staging+prod, so it MUST be PII-safe: redact any word inside
 * a mask band (or that LOOKS like a card/loyalty number) to `[•••]`, and redact
 * the line text via `redactReceiptText`.
 *
 * SINGLE source of truth shared by the interactive scan (scanSessionService) and
 * the background queue (receiptProcessingService) so both store an identical,
 * reproducible dump — the queue path previously emitted none, which left
 * queue-uploaded receipts un-reparseable.
 */
export function buildWordsDump(lines: WordsDumpLine[], maskBands: MaskBand[]) {
  return lines.map((l) => ({
    t: redactReceiptText(l.text),
    x: [Math.round(l.xLeft), Math.round(l.xRight)],
    y: [Math.round(l.yTop), Math.round(l.yBottom)],
    c: l.yLeftTop != null
      ? [
          Math.round(l.yLeftTop),
          Math.round(l.yRightTop ?? l.yTop),
          Math.round(l.yLeftBottom ?? l.yBottom),
          Math.round(l.yRightBottom ?? l.yBottom),
        ]
      : undefined,
    w: l.words?.map((w) => {
      const pii = wordCentreInMaskBand(w as any, maskBands) || looksLikePiiText(w.text);
      return [
        pii ? "[•••]" : w.text,
        Math.round(w.xLeft),
        Math.round(w.xRight),
        Math.round(w.yTop),
        Math.round(w.yBottom),
        w.cornerPoints?.length
          ? w.cornerPoints.flatMap((pt) => [Math.round(pt.x), Math.round(pt.y)])
          : undefined,
      ];
    }),
  }));
}
