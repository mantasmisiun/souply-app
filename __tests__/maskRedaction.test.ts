import {
    bandsForUploadedImage,
    maskBoxPercent,
    maskRenderSize,
} from '../utils/maskRedaction';

describe('bandsForUploadedImage', () => {
    const b = (yTop: number) => ({ yTop, yBottom: yTop + 20, xLeft: 0, xRight: 100 });

    it('keeps bands within the uploaded image height', () => {
        const bands = [b(10), b(500), b(2330)];
        expect(bandsForUploadedImage(bands, 2339)).toHaveLength(3);
    });

    it('drops bands that belong to later pages (yTop ≥ image height)', () => {
        const bands = [b(10), b(2400), b(5000)];
        const kept = bandsForUploadedImage(bands, 2339);
        expect(kept).toHaveLength(1);
        expect(kept[0].yTop).toBe(10);
    });

    it('drops negative-y bands', () => {
        expect(bandsForUploadedImage([{ yTop: -5 }], 2339)).toHaveLength(0);
    });
});

describe('maskBoxPercent', () => {
    it('maps pixel coords to percentages of the image', () => {
        const p = maskBoxPercent({ xLeft: 250, yTop: 1170, xRight: 750, yBottom: 1287 }, 1000, 2340);
        expect(p.left).toBeCloseTo(25);
        expect(p.top).toBeCloseTo(50);
        expect(p.width).toBeCloseTo(50);
        expect(p.height).toBeCloseTo(5);
    });

    it('clamps to 0..100 and never produces a zero-size box', () => {
        const p = maskBoxPercent({ xLeft: 0, yTop: 0, xRight: 0, yBottom: 0 }, 1000, 1000);
        expect(p.left).toBe(0);
        expect(p.width).toBeGreaterThan(0); // min 1px → tiny but positive
    });
});

describe('maskRenderSize', () => {
    it('divides the output dims by pixelRatio (capture native ≈ output, bounded memory)', () => {
        expect(maskRenderSize(1080, 5690, 3)).toEqual({ width: 360, height: 1897 });
    });

    it('is a no-op at pixelRatio 1', () => {
        expect(maskRenderSize(1080, 1500, 1)).toEqual({ width: 1080, height: 1500 });
    });

    it('guards against a bogus pixelRatio (< 1)', () => {
        expect(maskRenderSize(1000, 1000, 0)).toEqual({ width: 1000, height: 1000 });
    });
});
