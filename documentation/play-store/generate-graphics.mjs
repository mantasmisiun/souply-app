import { createRequire } from 'module';
const require = createRequire('/home/mantas/Documents/Projects/souply-api/');
const sharp = require('sharp');

const WEB = '/home/mantas/Documents/Projects/souply-web/node_modules/lucide-react/dist/esm/icons';
const OUT = '/home/mantas/Documents/Projects/souply-app/documentation/play-store';

const FEATURES = [
  { id: 'compare',     icon: 'store',     title: 'Visos parduotuvės vienoje vietoje', body: 'Maxima, Rimi, IKI, Norfa, Lidl — viena paieška, viena kaina.' },
  { id: 'scan',        icon: 'scan-line', title: 'Skenuok kvitą — gauk įžvalgas',     body: 'Pirmą kartą Lietuvoje — kvitas virsta įpročių žemėlapiu.' },
  { id: 'habits',      icon: 'sparkles',  title: 'Šablonas, kuris kuriasi pats',      body: 'Įkelk 3 kvitus iš 2 parduotuvių — Souply pasiūlys savaitės krepšelį.' },
  { id: 'discounts',   icon: 'bell',      title: 'Nuolaidos vienu žvilgsniu',         body: 'Visos akcijos visose parduotuvėse vienoje juostoje, atnaujinama kasdien.' },
  { id: 'history',     icon: 'history',   title: 'Kainų istorija',                    body: 'Matyk, kaip keičiasi kiekvienos prekės kaina laikui bėgant.' },
  { id: 'bestStore',   icon: 'gauge',     title: 'Pigiausia parduotuvė krepšeliui',   body: 'Per kelias sekundes rask, kur krepšelis kainuos mažiausiai.' },
  { id: 'perKg',       icon: 'chart-line',title: 'Mokėk už kilogramą',                body: 'Apskaičiuosim, kas pigiau: supakuota ar sveriama prekė.' },
  { id: 'quickRepeat', icon: 'repeat-2',  title: 'Pakartok pirkimą per 5 sek.',       body: 'Vienas mygtukas — šablonas tampa krepšeliu pigiausioje parduotuvėje.' },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const FONT = 'DejaVu Sans, sans-serif';

async function iconInner(name) {
  const mod = await import(`${WEB}/${name}.mjs`);
  return mod.__iconNode.map(([tag, attrs]) =>
    `<${tag} ${Object.entries(attrs).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');
}
function wrap(text, max) {
  const out = []; let cur = '';
  for (const w of text.split(' ')) {
    if ((cur + ' ' + w).trim().length > max) { if (cur) out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur); return out;
}
const DEFS = `<defs>
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#EB6784"/><stop offset="1" stop-color="#C9456A"/></linearGradient>
  <radialGradient id="spot" cx="0.3" cy="0.18" r="0.6"><stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
  <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.24"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.06"/></linearGradient>
</defs>`;

async function landscape(f) {
  const W = 1024, H = 500;
  const inner = await iconInner(f.icon);
  const titleLines = wrap(f.title, 17);
  const bodyLines = wrap(f.body, 42);
  // vertically centre the text block in the left column
  const blockH = titleLines.length * 58 + 16 + bodyLines.length * 36;
  let ty = (H - blockH) / 2 + 46;
  const titleSvg = titleLines.map((l) => { const s = `<text x="70" y="${ty}" font-family="${FONT}" font-size="50" font-weight="bold" fill="#ffffff">${esc(l)}</text>`; ty += 58; return s; }).join('');
  let by = ty + 6;
  const bodySvg = bodyLines.map((l) => { const s = `<text x="72" y="${by}" font-family="${FONT}" font-size="25" fill="#ffffff" fill-opacity="0.85">${esc(l)}</text>`; by += 36; return s; }).join('');
  const mx = 730, mw = 220, my = 70, mh = 360;
  const isz = 150, ix = mx + mw / 2 - isz / 2, iy = my + mh / 2 - isz / 2;
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${DEFS}
    <rect width="${W}" height="${H}" fill="url(#g)"/><rect width="${W}" height="${H}" fill="url(#spot)"/>
    <rect x="70" y="58" width="150" height="44" rx="22" fill="#F7CDD9"/>
    <circle cx="100" cy="80" r="5" fill="#C9456A"/>
    <text x="118" y="87" font-family="${FONT}" font-size="19" font-weight="bold" letter-spacing="2" fill="#A23E5A">SOUPLY</text>
    ${titleSvg}${bodySvg}
    <rect x="${mx}" y="${my}" width="${mw}" height="${mh}" rx="44" fill="url(#panel)" stroke="#ffffff" stroke-opacity="0.35" stroke-width="2"/>
    <rect x="${mx + mw / 2 - 34}" y="${my + 16}" width="68" height="12" rx="6" fill="#ffffff" fill-opacity="0.3"/>
    <svg x="${ix}" y="${iy}" width="${isz}" height="${isz}" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

(async () => {
  const fs = await import('fs/promises');
  await fs.mkdir(`${OUT}/feature-graphics`, { recursive: true });
  for (let i = 0; i < FEATURES.length; i++) {
    const f = FEATURES[i];
    const buf = await landscape(f);
    const name = `${String(i + 1).padStart(2, '0')}-${f.id}.png`;
    await fs.writeFile(`${OUT}/feature-graphics/${name}`, buf);
    if (i === 0) await fs.writeFile(`${OUT}/feature-graphic.png`, buf); // primary
    console.log(name);
  }
})();
