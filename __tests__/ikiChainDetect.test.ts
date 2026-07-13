import { isIkiReceipt } from '../shared/parsers/ikiParser';

// A stained/cut-off IKI header used to sink chain recognition even though the receipt body is
// full of IKI-only markers. isIkiReceipt must fall back to those — without false-positiving on
// another chain whose receipt merely contains "iki" (Lithuanian for "until").
describe('IKI chain detection — stained-header fallback + false-positive resistance', () => {
  test('clean header still detected', () => {
    expect(isIkiReceipt(['IKI Lietuva, UAB', 'Gardino g. 2-2, Šiauliai'])).toBe(true);
  });

  test('stained header but "IK! KORTELES NR." present (receipt-27)', () => {
    const lines = [
      'Inius Saulet', '7219 PVN', '0.65 AKVILE GAZ', 'DEPOZITAS 0,10',
      'Term. 15001931 Kvitas 9353 Atsk 000',
      'IK! KORTELES NR. 99110000000008150419',
      'PVM sąska itos-fakt uros isr ašomos saskaitos, iki. lt',
    ];
    expect(isIkiReceipt(lines)).toBe(true);
  });

  test('detected from the iki.lt domain alone', () => {
    expect(isIkiReceipt(['garbage header', 'Daugiau informacijos www. iki. lt'])).toBe(true);
  });

  test('detected from an "IKI Taškai" points line alone', () => {
    expect(isIkiReceipt(['stained top', 'VISI IKI Taškai: 30'])).toBe(true);
    expect(isIkiReceipt(['stained top', 'Buve IKI Taskai: 5'])).toBe(true);
  });

  test('does NOT false-positive on a non-IKI receipt containing "iki" (until)', () => {
    const rimiLike = [
      'RIMI Lietuva, UAB', 'Akcija galioja iki 2026-12-31',
      'Pienas 2,5%  1,29 EUR', 'Daugiau www.rimi.lt', 'Ačiū, kad pirkote',
    ];
    expect(isIkiReceipt(rimiLike)).toBe(false);
  });
});
