'use strict';
// Quick look: node scripts/preview.cjs [layout] [boil] [frame...] writes output/preview/*.png.
const fs = require('node:fs');
const path = require('node:path');
const { out, launch, openPage, renderFrame, pngBuffer } = require('./browser.cjs');

async function main() {
  const [layout = 'night', boil = 'coherent', ...frames] = process.argv.slice(2);
  const dir = path.join(out, 'preview');
  fs.mkdirSync(dir, { recursive: true });
  const browser = await launch();
  try {
    const page = await openPage(browser);
    for (const i of (frames.length ? frames : ['0']).map(Number)) {
      const r = await renderFrame(page, i, { layout, boil });
      const file = path.join(dir, `${layout}-${boil}-${String(i).padStart(4, '0')}.png`);
      fs.writeFileSync(file, pngBuffer(r.png));
      console.log(JSON.stringify({ file: path.basename(file), ms: Math.round(r.milliseconds), dots: r.stats.dots, layers: r.stats.layers }));
    }
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
