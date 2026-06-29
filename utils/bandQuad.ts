/** The region fields a band polygon needs — a structural subset of ReceiptRegion. */
export interface BandQuadRegion {
  xLeft: number;
  xRight: number;
  yTop: number;
  yBottom: number;
  xMid?: number | null;
  yLeftTop?: number | null;
  yRightTop?: number | null;
  yLeftBottom?: number | null;
  yRightBottom?: number | null;
  yMidTop?: number | null;
  yMidTopR?: number | null;
  yMidBottom?: number | null;
  yMidBottomR?: number | null;
}

/**
 * Build the SVG polygon `points` string for a receipt band, in display space. This is
 * the SINGLE source of truth shared by the Kvitas-tab overlay (ReceiptPhotoView's
 * `toQuadPoints`) and the Items-tab crop clip (BandCropImage's `clipPts`) so the two
 * can never drift — they previously did: the overlay drew an 8-point stepped polygon
 * for two-box (name + price) IKI products while the crop clipped a flat 4-point quad.
 *
 * Shapes: an 8-point stepped two-box polygon when the region carries the mid-column
 * step (xMid + both-column mid Y); a 6-point legacy step when only the left mid Y is
 * present; else a 4-point quad. The caller supplies `mapX`/`mapY` — each view's own
 * scale + offset + clamp from region(OCR)-space to its display surface.
 */
export function bandQuadPoints(
  r: BandQuadRegion,
  mapX: (x: number) => number,
  mapY: (y: number) => number,
): string {
  const xL = mapX(r.xLeft);
  const xR = mapX(r.xRight);
  const yTL = mapY(r.yLeftTop ?? r.yTop);
  const yTR = mapY(r.yRightTop ?? r.yTop);
  const yBR = mapY(r.yRightBottom ?? r.yBottom);
  const yBL = mapY(r.yLeftBottom ?? r.yBottom);
  // Two-box product band: name box [xLeft..xMid] + price/discount box [xMid..xRight],
  // joined by a VERTICAL step at xMid. 8-point when the RIGHT column's mid Y is given,
  // else the legacy 6-point (single mid Y).
  if (r.xMid != null && r.yMidTop != null && r.yMidBottom != null) {
    const xM = mapX(r.xMid);
    const yMTL = mapY(r.yMidTop);
    const yMBL = mapY(r.yMidBottom);
    if (r.yMidTopR != null && r.yMidBottomR != null) {
      const yMTR = mapY(r.yMidTopR);
      const yMBR = mapY(r.yMidBottomR);
      return `${xL},${yTL} ${xM},${yMTL} ${xM},${yMTR} ${xR},${yTR} ${xR},${yBR} ${xM},${yMBR} ${xM},${yMBL} ${xL},${yBL}`;
    }
    return `${xL},${yTL} ${xM},${yMTL} ${xR},${yTR} ${xR},${yBR} ${xM},${yMBL} ${xL},${yBL}`;
  }
  return `${xL},${yTL} ${xR},${yTR} ${xR},${yBR} ${xL},${yBL}`;
}
