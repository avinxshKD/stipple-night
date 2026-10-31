'use strict';
// Renders one frame at full size, a 1080-wide phone preview and a native hero crop, and checks
// that two separate browser launches produce the same PNG.
// Usage: node scripts/still.cjs [frame] [outDir]   (default: frame 0, output/stills)
const fs = require('node:fs');
const path = require('node:path');
const { out, launch, openPage, renderFrame, pngBuffer } = require('./browser.cjs');
const { sha256, ffmpeg, cropPng } = require('./media.cjs');

async function main() {
  const frame = Number(process.argv[2] || 0);
  if (!Number.isInteger(frame)) throw new Error('Frame must be an integer.');
  const dir = path.resolve(process.argv[3] || path.join(out, 'stills'));
  fs.mkdirSync(dir, { recursive: true });
  const name = `night-frame-${String(frame).padStart(4, '0')}`;
  const full = path.join(dir, `${name}.png`);
  const hashes = [];
  for (let run = 0; run < 2; run++) {
    const browser = await launch();
    try {
      const page = await openPage(browser);
      const r = await renderFrame(page, frame, { layout: 'night' });
      const png = pngBuffer(r.png);
      hashes.push(sha256(png));
      if (run === 0) {
        fs.writeFileSync(full, png);
        console.log(JSON.stringify({ ms: Math.round(r.milliseconds), dots: r.stats.dots, layers: r.stats.layers }));
      }
    } finally { await browser.close(); }
  }
  ffmpeg(['-i', full, '-vf', 'scale=1080:-2:flags=lanczos', '-frames:v', '1', path.join(dir, `${name}-phone-1080w.png`)]);
  cropPng(full, path.join(dir, `${name}-hero-crop.png`), { x: 680, y: 430, w: 560, h: 315 });
  console.log(JSON.stringify({ file: full, sha256: hashes[0], deterministic: hashes[0] === hashes[1] }));
  if (hashes[0] !== hashes[1]) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
