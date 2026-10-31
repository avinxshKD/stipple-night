'use strict';
// Compares full re-scatter boil against the coherent 3-variant boil on the test layout:
// renders a 48-frame loop for each, encodes master / ~5 Mbps / ~2.5 Mbps, measures, and writes sheets.
const fs = require('node:fs');
const path = require('node:path');
const { root, out, launch, openPage, renderFrame, pngBuffer } = require('./browser.cjs');
const { sha256, encode, probe, decodeFrame, cropPng, compare } = require('./media.cjs');
const { gridSheet } = require('./sheet.cjs');

const DRAWINGS = 24, FRAMES = DRAWINGS * 2, SAMPLE_FRAME = 24, BASE = 8.5;
const CROP = Object.freeze({ x: 800, y: 600, w: 560, h: 315 });
const MODES = Object.freeze([
  { key: 'scatter', label: 'full re-scatter' },
  { key: 'coherent', label: 'coherent 3-variant boil' }
]);
const ENCODES = Object.freeze([
  { key: 'master', file: 'master-crf16', label: 'master CRF 16', mode: { crf: 16 } },
  { key: '5mbps', file: '5mbps', label: '~5 Mbps', mode: { bitrate: '5M', maxrate: '6M', buffer: '10M' } },
  { key: '2500kbps', file: '2500kbps', label: '~2.5 Mbps', mode: { bitrate: '2500k', maxrate: '3M', buffer: '5M' } }
]);

const dest = path.join(out, 'boil-test');
const work = path.join(out, 'work', 'boil-test');
const framesDir = m => path.join(work, 'frames', m);
const framePath = (m, i) => path.join(framesDir(m), `frame_${String(i).padStart(4, '0')}.png`);
const options = boil => ({ layout: 'test', boil, drawings: DRAWINGS, base: BASE });

async function renderClip(page, mode) {
  fs.mkdirSync(framesDir(mode), { recursive: true });
  let wall = 0, inPage = 0, dots = 0;
  for (let d = 0; d < DRAWINGS; d++) {
    const t0 = process.hrtime.bigint();
    const r = await renderFrame(page, 2 * d, options(mode));
    const png = pngBuffer(r.png);
    // On twos the odd frame repeats the drawing; frame(2d + 1) === frame(2d) is hash-checked below.
    fs.writeFileSync(framePath(mode, 2 * d), png);
    fs.writeFileSync(framePath(mode, 2 * d + 1), png);
    wall += Number(process.hrtime.bigint() - t0) / 1e6;
    inPage += r.milliseconds; dots += r.stats.dots;
  }
  const first = sha256(fs.readFileSync(framePath(mode, 0)));
  const odd = sha256(pngBuffer((await renderFrame(page, 1, options(mode))).png));
  const wrap = sha256(pngBuffer((await renderFrame(page, FRAMES, options(mode))).png));
  return {
    dotsPerDrawing: Math.round(dots / DRAWINGS),
    msPerDrawingInPage: Math.round(inPage / DRAWINGS), msPerDrawingWall: Math.round(wall / DRAWINGS),
    estimatedFullLoopSeconds: Math.round(wall / DRAWINGS * 144 / 1000),
    hashes: { frame0: first, frame1EqualsFrame0: odd === first, frame48: wrap, frame48EqualsFrame0: wrap === first }
  };
}

async function main() {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  const metrics = {};

  let browser = await launch();
  try {
    const page = await openPage(browser);
    for (const m of MODES) metrics[m.key] = await renderClip(page, m.key);
  } finally { await browser.close(); }

  browser = await launch();
  try {
    const page = await openPage(browser);
    for (const m of MODES) {
      const again = sha256(pngBuffer((await renderFrame(page, 0, options(m.key))).png));
      metrics[m.key].hashes.frame0FreshBrowser = again;
      metrics[m.key].hashes.deterministic = again === metrics[m.key].hashes.frame0;
    }
  } finally { await browser.close(); }

  const crops = {};
  for (const m of MODES) {
    const pattern = path.join(framesDir(m.key), 'frame_%04d.png');
    const lossless = framePath(m.key, SAMPLE_FRAME);
    crops[`${m.key}-lossless`] = path.join(work, `${m.key}-lossless-crop.png`);
    cropPng(lossless, crops[`${m.key}-lossless`], CROP);
    metrics[m.key].encodes = {};
    for (const e of ENCODES) {
      const video = path.join(dest, `${m.key}-${e.file}.mp4`);
      encode(pattern, video, e.mode);
      const info = probe(video);
      const decoded = path.join(work, `${m.key}-${e.key}-frame${SAMPLE_FRAME}.png`);
      decodeFrame(video, SAMPLE_FRAME, decoded);
      crops[`${m.key}-${e.key}`] = path.join(work, `${m.key}-${e.key}-crop.png`);
      cropPng(decoded, crops[`${m.key}-${e.key}`], CROP);
      metrics[m.key].encodes[e.key] = {
        file: path.basename(video), sizeMB: Number((info.bytes / 1048576).toFixed(2)), kbps: info.kbps, frames: info.frames,
        frame24: compare(decoded, lossless), clipAverage: compare(video, pattern, { video: true, sourceIsSequence: true })
      };
      console.log(`${m.key} ${e.key}: ${info.kbps} kbps`, JSON.stringify(metrics[m.key].encodes[e.key].frame24));
    }
  }
  fs.copyFileSync(framePath('coherent', 0), path.join(dest, 'coherent-drawing-000.png'));
  fs.copyFileSync(framePath('scatter', 0), path.join(dest, 'scatter-drawing-000.png'));

  browser = await launch();
  try {
    const page = await openPage(browser);
    const rows = [['lossless', 'lossless PNG'], ['5mbps', '~5 Mbps'], ['2500kbps', '~2.5 Mbps']];
    fs.writeFileSync(path.join(dest, 'crop-sheet-old-vs-new.png'), await gridSheet(page, {
      title: `Boil comparison at ${BASE} px base, frame ${SAMPLE_FRAME}, native 1:1 crop (x ${CROP.x}, y ${CROP.y})`,
      colLabels: MODES.map(m => m.label),
      rowLabels: rows.map(r => r[1]),
      cells: rows.map(([k]) => MODES.map(m => crops[`${m.key}-${k}`])),
      cellW: CROP.w, cellH: CROP.h,
      note: 'Actual kbps (master / 5M / 2.5M): ' + MODES.map(m => `${m.key} ${ENCODES.map(e => metrics[m.key].encodes[e.key].kbps).join(' / ')}`).join('   ·   ')
    }));
  } finally { await browser.close(); }

  fs.writeFileSync(path.join(dest, 'metrics.json'), JSON.stringify({ base: BASE, drawings: DRAWINGS, sampleFrame: SAMPLE_FRAME, crop: CROP, modes: metrics }, null, 2));
  for (const m of MODES) console.log(m.key, JSON.stringify({ ...metrics[m.key], encodes: undefined }));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
