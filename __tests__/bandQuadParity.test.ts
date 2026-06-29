import { bandQuadPoints } from '../utils/bandQuad';

// The Kvitas-tab overlay (ReceiptPhotoView.toQuadPoints) and the Items-tab crop clip
// (BandCropImage.clipPts) now build the band polygon from this ONE helper, so a two-box
// IKI product gets the SAME 8-point stepped outline in both — they previously drifted
// (8-point overlay vs flat 4-point crop). Each view supplies its own mapX/mapY.
const id = (n: number) => n;
const count = (s: string) => s.trim().split(/\s+/).length;

describe('bandQuadPoints — overlay and crop share one band shape', () => {
  const twoBox = {
    xLeft: 50, xRight: 800, yTop: 100, yBottom: 200, xMid: 380,
    yLeftTop: 100, yRightTop: 90, yLeftBottom: 200, yRightBottom: 190,
    yMidTop: 110, yMidTopR: 105, yMidBottom: 180, yMidBottomR: 185,
  };
  const quad = {
    xLeft: 50, xRight: 800, yTop: 100, yBottom: 200,
    yLeftTop: 100, yRightTop: 90, yLeftBottom: 200, yRightBottom: 190,
  };

  test('two-box region → 8-point stepped polygon', () => {
    expect(count(bandQuadPoints(twoBox, id, id))).toBe(8);
  });

  test('the mid-column step (xMid) appears at all 4 step corners', () => {
    const pts = bandQuadPoints(twoBox, id, id);
    expect(pts.split(/\s+/).filter((p) => p.startsWith('380,')).length).toBe(4);
  });

  test('plain region (no xMid) → 4-point quad', () => {
    expect(count(bandQuadPoints(quad, id, id))).toBe(4);
  });

  test('overlay scale and crop scale yield the SAME point count + step (no drift)', () => {
    const overlay = bandQuadPoints(twoBox, (x) => x * 0.5, (y) => y * 0.5 - 10);   // full-receipt scale + crop offset
    const crop = bandQuadPoints(twoBox, (x) => (x - 50) * 0.6, (y) => (y - 90) * 0.6); // tighter, from the band's own left/top
    expect(count(overlay)).toBe(8);
    expect(count(crop)).toBe(8);
    expect(overlay.split(/\s+/).filter((p) => p.startsWith(`${380 * 0.5},`)).length).toBe(4);
    expect(crop.split(/\s+/).filter((p) => p.startsWith(`${(380 - 50) * 0.6},`)).length).toBe(4);
  });
});
