'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output');

// BROWSER_PATH wins; otherwise the default Edge and Chrome install locations are tried in order.
function executable() {
  if (process.env.BROWSER_PATH) {
    if (!fs.existsSync(process.env.BROWSER_PATH)) throw new Error(`BROWSER_PATH does not exist: ${process.env.BROWSER_PATH}`);
    return process.env.BROWSER_PATH;
  }
  const choices = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ];
  const found = choices.find(p => fs.existsSync(p));
  if (!found) throw new Error('No Edge or Chrome found. Set BROWSER_PATH to the browser executable.');
  return found;
}

function launch() {
  return puppeteer.launch({
    executablePath: executable(), headless: true,
    args: ['--force-color-profile=srgb', '--disable-gpu-vsync', '--hide-scrollbars', '--disable-gpu', '--disable-skia-runtime-opts']
  });
}

async function openPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.error('[page]', e.message));
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function renderFrame(page, index, options = {}) {
  return page.evaluate(({ index, options }) => {
    const canvas = document.getElementById('film');
    const t0 = performance.now();
    const stats = StippleNight.frame(index, canvas.getContext('2d'), options);
    const png = canvas.toDataURL('image/png');
    return { png, stats, milliseconds: performance.now() - t0 };
  }, { index, options });
}

// Fraction of non-black pixels in each rectangle of whatever the canvas currently shows.
function coverage(page, rects) {
  return page.evaluate(list => {
    const ctx = document.getElementById('film').getContext('2d');
    return Object.fromEntries(Object.entries(list).map(([name, [x, y, w, h]]) => {
      const data = ctx.getImageData(x, y, w, h).data;
      // Counting only pixels above ~40% of a dot's brightness keeps antialiased rims from inflating the figure.
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) if (Math.max(data[i], data[i + 1], data[i + 2]) > 96) lit++;
      return [name, Number((lit / (w * h)).toFixed(3))];
    }));
  }, rects);
}

const COVERAGE_RECTS = Object.freeze({
  moon: [980, 250, 200, 200], leftHill: [150, 820, 200, 200], boulder: [1560, 860, 200, 160], glitter: [1024, 960, 160, 100]
});

const pngBuffer = url => Buffer.from(url.split(',')[1], 'base64');
module.exports = { root, out, launch, openPage, renderFrame, coverage, COVERAGE_RECTS, pngBuffer };
