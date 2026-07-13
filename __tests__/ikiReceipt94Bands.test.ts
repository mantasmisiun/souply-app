import { parseIkiColumnar, type IkiLine, type IkiWord } from '../shared/parsers/ikiParser';

// Real receipt-94/95 word boxes for the CHAINED two-box region: salmon → NAMINĮS →
// ZEMAITIJOS, where each product's name was fused (by MLKit) onto the PRIOR product's
// discount row, so multiple two-box bands chain. Two requirements, BOTH must hold:
//  (1) no adjacent band polygons overlap (the receipt-94 cascade), and
//  (2) every band edge rides the receipt tilt g — clean consistent sloping (receipt-95),
//      i.e. each column (name / price) is a clean parallelogram joined by a vertical step.
const W = (text: string, xL: number, xR: number, yT: number, yB: number): IkiWord =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: IkiWord[]): IkiLine =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

const LINES: IkiLine[] = [
  L('SKANĖ JA RYŽA. BSMAll, 8', 95, 545, 312, 362, [W('SKANĖ', 95, 178, 312, 355), W('JA', 192, 218, 317, 356), W('RYŽA.', 251, 354, 319, 363), W('BSMAll,', 362, 505, 324, 370), W('8', 532, 544, 332, 371)]),
  L('3, 29 A', 757, 864, 339, 377, [W('3,', 757, 780, 339, 373), W('29', 793, 828, 339, 373), W('A', 847, 864, 339, 373)]),
  L('ATL AI INĖS LASIS0S BE GAL', 88, 546, 353, 406, [W('ATL', 88, 134, 353, 392), W('AI', 145, 210, 355, 394), W('INĖS', 212, 281, 357, 397), W('LASIS0S', 291, 420, 359, 401), W('BE', 440, 475, 364, 402), W('GAL', 495, 546, 366, 405)]),
  L('1,068 kg Y 16 99 EUR/ kg', 120, 584, 392, 447, [W('1,068', 120, 203, 392, 434), W('kg', 237, 272, 396, 435), W('Y', 308, 327, 398, 437), W('16', 353, 383, 399, 439), W('99', 403, 438, 400, 440), W('EUR/', 459, 530, 402, 443), W('kg', 551, 584, 405, 444)]),
  L('UOLAI DA ŠU KORTELE', 88, 439, 423, 467, [W('UOLAI', 88, 194, 423, 467), W('DA', 199, 236, 427, 468), W('ŠU', 254, 291, 430, 470), W('KORTELE', 311, 439, 432, 476)]),
  L('18, 15 A', 741, 864, 408, 448, [W('18,', 741, 781, 411, 448), W('15', 795, 828, 409, 446), W('A', 846, 864, 408, 444)]),
  L('-7, 48 A NAMINĮS 2,5 PIENAS', 99, 866, 444, 506, [W('-7,', 739, 782, 444, 481), W('48', 794, 830, 444, 481), W('A', 849, 866, 444, 481)]),
  L('NUCLAIDA SU KOE', 94, 462, 495, 544, [W('NUCLAIDA', 94, 236, 495, 541), W('SU', 263, 298, 501, 543), W('KOE', 317, 462, 503, 548)]),
  L('1, 49 A', 760, 865, 477, 521, [W('1,', 760, 782, 480, 521), W('49', 793, 828, 478, 519), W('A', 847, 865, 477, 517)]),
  L('-0, 30 A ZEMAITIJOS TEPAMAS SU', 88, 866, 513, 574, [W('-0,', 741, 782, 514, 555), W('30', 797, 842, 514, 554), W('A', 847, 866, 514, 553)]),
  L('LYDYTAS TEPAMAS SJ1S SU', 94, 531, 566, 610, [W('LYDYTAS', 94, 226, 566, 611), W('TEPAMAS', 238, 365, 570, 616), W('SJ1S', 381, 477, 575, 618), W('SU', 497, 531, 579, 620)]),
  L('1,99 A', 760, 866, 554, 590, [W('1,99', 760, 829, 554, 587), W('A', 849, 866, 554, 586)]),
  L('1,99 A', 761, 866, 585, 624, [W('1,99', 761, 828, 585, 622), W('A', 849, 866, 585, 620)]),
  L('LIETUVISKI POMIDURAI', 97, 452, 603, 653, [W('LIETUVISKI', 97, 284, 603, 646), W('POMIDÜRAI', 291, 452, 608, 650)]),
];

// y of a band edge at x, honouring the 8-point step (left column [xLeft..xMid] then right
// column [xMid..xRight], each a straight segment).
const edgeAt = (xL: number, yL: number, xM: number | undefined, yMidL: number | undefined, yMidR: number | undefined, xR: number, yR: number, x: number): number => {
  if (xM != null && yMidL != null) {
    const yR2 = yMidR ?? yMidL;
    return x < xM
      ? yL + (yMidL - yL) * ((x - xL) / (xM - xL))
      : yR2 + (yR - yR2) * ((x - xM) / (xR - xM));
  }
  return yL + (yR - yL) * ((x - xL) / (xR - xL));
};
const topAt = (r: any, x: number) => edgeAt(r.xLeft, r.yLeftTop, r.xMid, r.yMidTop, r.yMidTopR, r.xRight, r.yRightTop, x);
const botAt = (r: any, x: number) => edgeAt(r.xLeft, r.yLeftBottom, r.xMid, r.yMidBottom, r.yMidBottomR, r.xRight, r.yRightBottom, x);

describe('IKI receipt-94/95 chained two-box — clean sloping + no overlap', () => {
  const products = parseIkiColumnar(LINES, 0, LINES.length);
  const sorted = [...products].sort((a, b) => a.region.yTop - b.region.yTop);
  // receipt tilt g, measured from a plain quad band (no xMid) — its top edge IS the tilt.
  const quad = products.find((p) => p.region.xMid == null && p.region.yRightTop != null)!.region;
  const g = (quad.yRightTop! - quad.yLeftTop!) / (quad.xRight - quad.xLeft);

  test('every band is a single FLAT quad (no two-box step) and the tilt is a real downward slope', () => {
    expect(products.every((p) => p.region.xMid == null)).toBe(true); // collapsed to straight bands
    expect(g).toBeGreaterThan(0.02); // text slopes down-right (~0.045 on this receipt)
  });

  test('every band edge rides the receipt tilt g (clean consistent sloping)', () => {
    const slope = (x0: number, y0: number, x1: number, y1: number) => (y1 - y0) / (x1 - x0);
    for (const p of products) {
      const r: any = p.region;
      if (r.xMid != null) {
        // each COLUMN's top and bottom edge must slope by ~g (not a lopsided trapezoid)
        expect(slope(r.xLeft, r.yLeftTop, r.xMid, r.yMidTop)).toBeCloseTo(g, 2);       // left top
        expect(slope(r.xMid, r.yMidTopR, r.xRight, r.yRightTop)).toBeCloseTo(g, 2);    // right top
        expect(slope(r.xLeft, r.yLeftBottom, r.xMid, r.yMidBottom)).toBeCloseTo(g, 2); // left bottom
        expect(slope(r.xMid, r.yMidBottomR, r.xRight, r.yRightBottom)).toBeCloseTo(g, 2); // right bottom
      } else if (r.yLeftTop != null) {
        expect(slope(r.xLeft, r.yLeftTop, r.xRight, r.yRightTop)).toBeCloseTo(g, 2);
        expect(slope(r.xLeft, r.yLeftBottom, r.xRight, r.yRightBottom)).toBeCloseTo(g, 2);
      }
    }
  });

  test('adjacent band polygons TILE exactly at every x (A bottom == B top — no overlap, no gap)', () => {
    const X0 = Math.min(...products.map((p) => p.region.xLeft));
    const X1 = Math.max(...products.map((p) => p.region.xRight));
    for (let i = 0; i + 1 < sorted.length; i++) {
      const A = sorted[i].region, B = sorted[i + 1].region;
      for (let s = 0; s <= 10; s++) {
        const x = X0 + ((X1 - X0) * s) / 10;
        expect(Math.abs(botAt(A, x) - topAt(B, x))).toBeLessThan(1.0);
      }
    }
  });
});
