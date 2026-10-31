'use strict';
// Renders the full loop to PNG frames, verifies it is seamless and deterministic, encodes a master
// and a delivery-rate copy, and builds a contact sheet, a walk strip, a ripple strip and phone previews.
// Usage: node scripts/render-loop.cjs [outDir] [--tag=name] [--stride]
//   outDir    defaults to output/render
//   --tag     adds -name to every file name, so several renders can share one folder
//   --stride  renders only drawings 0-17 and writes the walk and ripple strips (no encode, no checks)
const fs = require('node:fs');
const path = require('node:path');
const { out, launch, openPage, renderFrame, pngBuffer } = require('./browser.cjs');
const { sha256, fileHash, encode, probe, compare, cropPng, ffmpeg } = require('./media.cjs');
const { gridSheet } = require('./sheet.cjs');

const FRAMES = 288, DRAWINGS = 144, STRIDE = 18, STEP = 9;
const FIGURE_CROP = Object.freeze({ x: 840, y: 560, w: 240, h: 380 });
const RIPPLE_CROP = Object.freeze({ x: 790, y: 730, w: 340, h: 180 });
const PHONE_DRAWINGS = [0, 4];
const name = i => `f${String(i).padStart(4, '0')}.png`;

async function main() {
  const args = process.argv.slice(2), strideOnly = args.includes('--stride');
  const version = (args.find(a => a.startsWith('--tag=')) || '').slice('--tag='.length);
  const [dirArg] = args.filter(a => !a.startsWith('--'));
  const tag = version ? `-${version}` : '';
  const dir = path.resolve(dirArg || path.join(out, 'render'));
  const framesDir = path.join(dir, `frames${tag}`), work = path.join(out, 'work', `strips${tag}`);
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const report = { frames: strideOnly ? 2 * STRIDE : FRAMES };

  // One page for the whole pass: every frame comes from the same renderer state.
  const hashes = [];
  let browser = await launch();
  try {
    const page = await openPage(browser);
    const t0 = Date.now();
    for (let i = 0; i <= report.frames; i++) {
      if (strideOnly && i % 2) continue;
      const png = pngBuffer((await renderFrame(page, i, { layout: 'night' })).png);
      hashes[i] = sha256(png);
      if (i < report.frames) fs.writeFileSync(path.join(framesDir, name(i)), png);
      if (i % 48 === 0) console.log(`frame ${i} (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
    report.renderSeconds = Math.round((Date.now() - t0) / 1000);
  } finally { await browser.close(); }

  if (!strideOnly) {
    const pairs = Array.from({ length: DRAWINGS }, (_, d) => hashes[2 * d] === hashes[2 * d + 1]);
    report.onTwosPairsMatch = pairs.filter(Boolean).length + '/' + DRAWINGS;
    report.loopFrame288EqualsFrame0 = hashes[FRAMES] === hashes[0];
    report.frame287DiffersFromFrame0 = hashes[FRAMES - 1] !== hashes[0];
    report.uniqueDrawings = new Set(hashes.slice(0, FRAMES)).size;
    report.filesMatchRender = hashes.slice(0, FRAMES).every((h, i) => fileHash(path.join(framesDir, name(i))) === h);

    const sample = [...new Set([0, 1, 17, 18, 35, 36, 143, 144, 269, 270, 286, 287, 288,
      ...Array.from({ length: 12 }, (_, k) => 24 * k + 11)])].sort((a, b) => a - b);
    browser = await launch();
    try {
      const page = await openPage(browser);
      const second = [];
      for (const i of sample) second.push(sha256(pngBuffer((await renderFrame(page, i, { layout: 'night' })).png)));
      report.secondLaunch = { sampled: sample.length, mismatched: sample.filter((i, k) => second[k] !== hashes[i]) };
    } finally { await browser.close(); }

    const pattern = path.join(framesDir, 'f%04d.png');
    const master = path.join(dir, `night-loop${tag}-master-crf16.mp4`);
    const x = path.join(dir, `night-loop${tag}-5mbps.mp4`);
    encode(pattern, master, { crf: 16 });
    encode(pattern, x, { bitrate: '5M', maxrate: '6M', buffer: '10M' });
    report.master = { ...probe(master), ...compare(master, pattern, { video: true, sourceIsSequence: true }) };
    report.x5mbps = { ...probe(x), ...compare(x, pattern, { video: true, sourceIsSequence: true }) };
  }

  const strideCrops = (crop, label) => Array.from({ length: STRIDE }, (_, d) => {
    const file = path.join(work, `${label}-${String(d).padStart(2, '0')}.png`);
    cropPng(path.join(framesDir, name(2 * d)), file, crop);
    return file;
  });
  const contact = d => `${(d / STEP) % 2 ? 'right' : 'left'} contact`;

  browser = await launch();
  try {
    const page = await openPage(browser);
    if (!strideOnly) {
      const picks = Array.from({ length: 12 }, (_, k) => path.join(framesDir, name(24 * k)));
      const rows = [0, 1, 2].map(r => picks.slice(4 * r, 4 * r + 4));
      fs.writeFileSync(path.join(dir, `contact-sheet${tag}.png`), await gridSheet(page, {
        title: 'Night loop: every 12th drawing (0.5 s apart)', cellW: 480, cellH: 270, cells: rows,
        colLabels: [0, 1, 2, 3].map(k => `+${12 * k} drawings`),
        rowLabels: rows.map((_, r) => `d ${48 * r}-${48 * r + 36}`),
        note: 'Drawing d is shown on frames 2d and 2d+1. Footstep contacts every 9 drawings.'
      }));
    }

    const walk = strideCrops(FIGURE_CROP, 'walk');
    fs.writeFileSync(path.join(dir, `walk-strip${tag}.png`), await gridSheet(page, {
      title: 'One stride, drawings 0-17, native resolution', cellW: FIGURE_CROP.w, cellH: FIGURE_CROP.h,
      cells: [walk.slice(0, 9), walk.slice(9)],
      colLabels: Array.from({ length: 9 }, (_, k) => `+${k}`),
      rowLabels: [0, STEP].map(d => `d ${d}-${d + STEP - 1}\n${contact(d)}`),
      note: `Crop ${FIGURE_CROP.w}x${FIGURE_CROP.h} at (${FIGURE_CROP.x}, ${FIGURE_CROP.y}). Each row starts on a footstep contact.`
    }));

    const ripple = strideCrops(RIPPLE_CROP, 'ripple');
    fs.writeFileSync(path.join(dir, `ripple-strip${tag}.png`), await gridSheet(page, {
      title: 'Footstep ripples, drawings 0-17, native resolution', cellW: RIPPLE_CROP.w, cellH: RIPPLE_CROP.h,
      cells: [ripple.slice(0, 6), ripple.slice(6, 12), ripple.slice(12)],
      colLabels: Array.from({ length: 6 }, (_, k) => `+${k}`),
      rowLabels: [0, 6, 12].map(d => `d ${d}-${d + 5}`),
      note: `Crop ${RIPPLE_CROP.w}x${RIPPLE_CROP.h} at (${RIPPLE_CROP.x}, ${RIPPLE_CROP.y}). Left contact at d 0, right at d 9.`
    }));
  } finally { await browser.close(); }

  for (const d of PHONE_DRAWINGS) {
    ffmpeg(['-i', path.join(framesDir, name(2 * d)), '-vf', 'scale=1080:-2:flags=lanczos', '-frames:v', '1',
      path.join(dir, `night${tag}-d${String(d).padStart(3, '0')}-phone-1080w.png`)]);
  }

  if (!strideOnly) fs.writeFileSync(path.join(dir, `frame-hashes${tag}.json`), JSON.stringify({ report, hashes }, null, 1));
  console.log(JSON.stringify(report, null, 1));
  const passed = strideOnly || (report.onTwosPairsMatch === `${DRAWINGS}/${DRAWINGS}` && report.loopFrame288EqualsFrame0 &&
    report.frame287DiffersFromFrame0 && report.filesMatchRender && report.secondLaunch.mismatched.length === 0);
  if (!passed) { console.error('Loop checks failed.'); process.exitCode = 1; }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
