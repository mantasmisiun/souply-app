/**
 * Rimi Receipt Parser v2
 * 
 * Based on actual MLKit OCR output from Rimi receipts.
 * Key insight: OCR returns fragments sorted by Y. Price lines ("X,XX A")
 * are separate from product names. Product names are 1-3 lines BEFORE their price.
 */

export interface Region {
    yTop: number;
    yBottom: number;
    xLeft: number;   // usually 0 or near it
    xRight: number;  // usually image width
}

export interface RimiProduct {
    name: string;
    price: number;
    promoPrice: number | null;
    discount: number | null;
    quantity: number;
    unit: string;
    pricePerUnit: number | null;
    rawLines: string[];
}

export interface RimiHeader {
    chainName: string;
    storeCode: string;
    storeAddress: string;
    pvmCode: string;
    rawText: string;
}

export interface RimiFooter {
    total: number | null;
    date: string;
    time: string;
    receiptNo: string;
    totalSavings: number | null;
    rawText: string;
}

export interface RimiParseResult {
    header: RimiHeader;
    products: RimiProduct[];
    footer: RimiFooter;
}

function parseNum(str: string): number {
    return parseFloat(str.replace(',', '.').replace(/\s/g, ''));
}

export function isRimiReceipt(lines: string[]): boolean {
    const first15 = lines.slice(0, 15).join(' ').toUpperCase();
    return first15.includes('RIMI');
}

const PRICE_PATTERN = /^(\d+[.,]\s?\d{2})\s*[AB]\s*$/;
const WEIGHT_PATTERN = /(\d+[.,]\d{3})\s*kg\s*[xX×]\s*(\d+[.,]\s?\d{2})\s*(EUR|€)/i;
const DISCOUNT_PATTERN = /Nuo[li]\.\s*-(\d+[.,]\d{2})\s+Gal[uūü]t\.?\s*k?aina\s*(\d+[.,]\d{2})/i;
const MULTI_PATTERN = /(\d+)\s*vnt\.\s*[xX×]\s*(\d+[.,]\d{2})\s*(EUR)?/i;
const DEPOSIT_PATTERN = /[uūü]žstat/i;

export function parseRimiReceipt(lines: string[]): RimiParseResult {
    const headerEndIdx = findHeaderEnd(lines);
    const footerStartIdx = findFooterStart(lines, headerEndIdx);

    return {
        header: parseHeader(lines.slice(0, headerEndIdx)),
        products: parseProducts(lines.slice(headerEndIdx, footerStartIdx)),
        footer: parseFooter(lines.slice(footerStartIdx)),
    };
}

function findHeaderEnd(lines: string[]): number {
    for (let i = 0; i < Math.min(lines.length, 20); i++) {
        const text = lines[i].toUpperCase();
        if (/PIRK[EĖÈE]JAS/i.test(text)) {
            // Header ends at the PIRKĖJAS line itself
            return i + 1;
        }
    }
    // Fallback: find first price line, go back
    for (let i = 0; i < lines.length; i++) {
        if (PRICE_PATTERN.test(lines[i].trim())) {
            return Math.max(0, i - 2);
        }
    }
    return Math.min(8, lines.length);
}

function findFooterStart(lines: string[], afterIdx: number): number {
    for (let i = afterIdx; i < lines.length; i++) {
        const text = lines[i].toUpperCase().replace(/\s+/g, '');
        if (text.includes('SUTEIKTOSNUOLAI') || text.includes('SUTEIKTOSNUOLAIDOS')) return i;
        if (/J[UŪÜÚ]SSUTAUP/.test(text)) return i;
        if (/^MOK[ĖEÈ]JIMAS/i.test(lines[i].trim())) return i;
    }
    return lines.length;
}

function parseHeader(lines: string[]): RimiHeader {
    let storeCode = '';
    let storeAddress = '';
    let pvmCode = '';

    for (const line of lines) {
        const text = line.trim();
        const codeMatch = text.match(/\bT(\d{3,4})\b/);
        if (codeMatch && /RIMI|LIETUVA/i.test(text)) storeCode = 'T' + codeMatch[1];

        const pvmMatch = text.match(/(LT|IT)\d{9,12}/);
        if (pvmMatch) pvmCode = pvmMatch[0];

        if (/\b(g|pr|al|pl|a)\.\s/i.test(text) && !/UAB|RIMI|PVM|PIRK/i.test(text)) {
            storeAddress = text;
        }
    }

    return { chainName: 'RIMI', storeCode, storeAddress, pvmCode, rawText: lines.join('\n') };
}

function parseProducts(lines: string[]): RimiProduct[] {
    const products: RimiProduct[] = [];

    const priceIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (PRICE_PATTERN.test(lines[i].trim())) {
            priceIndices.push(i);
        }
    }

    const usedLines = new Set<number>();

    for (let pi = 0; pi < priceIndices.length; pi++) {
        const priceIdx = priceIndices[pi];
        const priceText = lines[priceIdx].trim();
        const priceMatch = priceText.match(PRICE_PATTERN)!;
        let price = parseNum(priceMatch[1]);
        const rawLines: string[] = [];

        usedLines.add(priceIdx);

        let quantity = 1;
        let unit = 'vnt';
        let pricePerUnit: number | null = null;
        let discount: number | null = null;
        let promoPrice: number | null = null;

        const prevPriceIdx = pi > 0 ? priceIndices[pi - 1] : -1;

        const nameLines: string[] = [];
        let lookback = priceIdx - 1;

        while (lookback > prevPriceIdx && nameLines.length < 4) {
            const prevText = lines[lookback].trim();

            if (!prevText || usedLines.has(lookback)) { lookback--; continue; }
            if (PRICE_PATTERN.test(prevText)) break;
            if (DISCOUNT_PATTERN.test(prevText)) { lookback--; continue; }

            const weightMatch = prevText.match(WEIGHT_PATTERN);
            if (weightMatch) {
                quantity = parseNum(weightMatch[1]);
                pricePerUnit = parseNum(weightMatch[2]);
                unit = 'kg';
                rawLines.push(prevText);
                usedLines.add(lookback);
                lookback--;
                continue;
            }

            const multiMatch = prevText.match(MULTI_PATTERN);
            if (multiMatch) {
                quantity = parseInt(multiMatch[1]);
                pricePerUnit = parseNum(multiMatch[2]);
                unit = 'vnt';
                rawLines.push(prevText);
                usedLines.add(lookback);
                lookback--;
                continue;
            }

            nameLines.unshift(prevText);
            usedLines.add(lookback);
            lookback--;
        }

        let name = nameLines.join(' ').trim();
        rawLines.unshift(...nameLines);
        rawLines.push(priceText);

        if (DEPOSIT_PATTERN.test(name)) continue;
        if (/^\d+[.,]?\d*$/.test(name)) continue;

        // Look forward for discount
        const nextPriceIdx = pi + 1 < priceIndices.length ? priceIndices[pi + 1] : lines.length;

        for (let j = priceIdx + 1; j < Math.min(priceIdx + 3, nextPriceIdx); j++) {
            const nextText = lines[j].trim();
            if (usedLines.has(j)) continue;

            const discountMatch = nextText.match(DISCOUNT_PATTERN);
            if (discountMatch) {
                discount = parseNum(discountMatch[1]);
                promoPrice = parseNum(discountMatch[2]);
                rawLines.push(nextText);
                usedLines.add(j);
                continue;
            }
        }

        // Use unit price when available (multi-buy or weighable)
        if (pricePerUnit !== null) price = pricePerUnit;

        name = cleanProductName(name);

        if (name) {
            products.push({ name, price, promoPrice, discount, quantity, unit, pricePerUnit, rawLines });
        }
    }

    return products;
}

function cleanProductName(name: string): string {
    let cleaned = name;
    // Remove trailing amount+unit
    cleaned = cleaned.replace(/,?\s*\d+[\.,]?\d*\s*(g|kg|ml|l|vnt\.?|rit\.?)\s*$/i, '').trim();
    // Remove standalone "1kg" at end
    cleaned = cleaned.replace(/\s+\d+(kg|g|ml|l)\s*$/i, '').trim();
    // Remove trailing comma
    cleaned = cleaned.replace(/,\s*$/, '').trim();
    return cleaned;
}

function parseFooter(lines: string[]): RimiFooter {
    let total: number | null = null;
    let date = '';
    let time = '';
    let receiptNo = '';
    let totalSavings: number | null = null;

    for (let i = 0; i < lines.length; i++) {
        const text = lines[i].trim();

        // Mokėti + amount (handles "22 77", "22,77", "11, 18")
        const moketiMatch = text.match(/Mok[eėèé]ti\s+(\d+)[.,\s]+(\d{2})/i);
        if (moketiMatch) total = parseFloat(moketiMatch[1] + '.' + moketiMatch[2]);
        
        // Mokėti on its own line, amount on next
        if (/^Mok[eėèé]ti$/i.test(text) && i + 1 < lines.length) {
            const m = lines[i + 1].trim().match(/(\d+)[.,\s]+(\d{2})/);
            if (m) total = parseFloat(m[1] + '.' + m[2]);
        }

        // LAIKAS (handles "14 :44:49" with spaces)
        const laikasMatch = text.match(/LAIKAS\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}\s?:\s?\d{2}\s?:\s?\d{2})/i);
        if (laikasMatch) {
            date = laikasMatch[1];
            time = laikasMatch[2].replace(/\s/g, '');
        }
        if (/^LAIKAS$/i.test(text) && i + 1 < lines.length) {
            const d = lines[i + 1].trim().match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}\s?:\s?\d{2}\s?:\s?\d{2})/);
            if (d) { date = d[1]; time = d[2].replace(/\s/g, ''); }
        }

        // Kvito Nr. (handles l instead of 1)
        const nrMatch = text.match(/Kvito\s+Nr\.?\s*(.+)/i);
        if (nrMatch) receiptNo = nrMatch[1].trim();

        const numMatch = text.match(/Kvito\s+numeris\s+(\d+)/i);
        if (numMatch && !receiptNo) receiptNo = numMatch[1];

        // Savings
        if (/sutaup[eėèé]te/i.test(text)) {
            const s = text.match(/(\d+[.,]\d{2})/);
            if (s) totalSavings = parseNum(s[1]);
            else if (i + 1 < lines.length) {
                const ns = lines[i + 1].trim().match(/(\d+[.,]\d{2})/);
                if (ns) totalSavings = parseNum(ns[1]);
            }
        }
    }

    return { total, date, time, receiptNo, totalSavings, rawText: lines.join('\n') };
}
/**
 * Lightweight header-only parse for progressive UI feedback.
 * Runs before full product parsing so the UI can show the chain and
 * kick off store matching while products are still being parsed.
 */
export function parseRimiHeaderOnly(lines: string[]): RimiHeader {
    const headerEndIdx = findHeaderEnd(lines);
    return parseHeader(lines.slice(0, headerEndIdx));
}