import { LEVELS, getLevelData } from '../constants/levels';

describe('LEVELS array', () => {
    it('has exactly 40 entries', () => {
        expect(LEVELS.length).toBe(40);
    });

    it('every entry has a non-empty name and emoji', () => {
        for (const level of LEVELS) {
            expect(level.name.length).toBeGreaterThan(0);
            expect(level.emoji.length).toBeGreaterThan(0);
        }
    });

    it('starts with Svogūnas', () => {
        expect(LEVELS[0].name).toBe('Svogūnas');
    });

    it('ends with Grybas', () => {
        expect(LEVELS[LEVELS.length - 1].name).toBe('Grybas');
    });
});

describe('getLevelData', () => {
    it('returns level 1 data for level=1', () => {
        const data = getLevelData(1);
        expect(data.name).toBe('Svogūnas');
        expect(data.emoji).toBe('🧅');
    });

    it('returns level 40 data for level=40', () => {
        const data = getLevelData(40);
        expect(data.name).toBe('Grybas');
        expect(data.emoji).toBe('🍄');
    });

    it('clamps level below 1 to level 1', () => {
        expect(getLevelData(0)).toEqual(getLevelData(1));
        expect(getLevelData(-5)).toEqual(getLevelData(1));
    });

    it('clamps level above 40 to level 40', () => {
        expect(getLevelData(41)).toEqual(getLevelData(40));
        expect(getLevelData(999)).toEqual(getLevelData(40));
    });

    it('returns correct mid-range level', () => {
        const data = getLevelData(20);
        expect(data.name).toBe('Persikas');
        expect(data.emoji).toBe('🍑');
    });
});
