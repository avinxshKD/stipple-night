'use strict';
const fs = require('node:fs');
const { pngBuffer } = require('./browser.cjs');

// Lays out PNG files in a labeled grid inside the page and returns the sheet as a PNG buffer.
// Cells are drawn at cellW x cellH; pass cells at that size to keep native resolution.
async function gridSheet(page, spec) {
  const cells = spec.cells.map(row => row.map(file => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64')));
  const url = await page.evaluate(async ({ title, note, colLabels, rowLabels, cells, cellW, cellH }) => {
    const gap = 8, labelW = rowLabels ? 150 : 0, titleH = 46, headH = colLabels ? 30 : 0, noteH = note ? 28 : 0;
    const cols = cells[0].length, rows = cells.length;
    const c = document.createElement('canvas');
    c.width = labelW + cols * (cellW + gap) + gap;
    c.height = titleH + headH + rows * (cellH + gap) + gap + noteH;
    const g = c.getContext('2d');
    g.fillStyle = '#1A1A1A'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#FFFFFF'; g.textBaseline = 'middle';
    g.font = 'bold 22px Arial'; g.fillText(title, gap + 4, titleH / 2 + 2);
    g.font = '17px Arial';
    if (colLabels) colLabels.forEach((t, i) => g.fillText(t, labelW + gap + i * (cellW + gap) + 4, titleH + headH / 2));
    const load = src => new Promise((ok, fail) => { const im = new Image(); im.onload = () => ok(im); im.onerror = fail; im.src = src; });
    for (let r = 0; r < rows; r++) {
      const y = titleH + headH + gap + r * (cellH + gap);
      if (rowLabels) {
        g.fillStyle = '#FFFFFF';
        String(rowLabels[r]).split('\n').forEach((line, k, all) => g.fillText(line, gap + 4, y + cellH / 2 + (k - (all.length - 1) / 2) * 22));
      }
      for (let k = 0; k < cols; k++) {
        const im = await load(cells[r][k]);
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
        g.drawImage(im, labelW + gap + k * (cellW + gap), y, cellW, cellH);
      }
    }
    if (note) { g.fillStyle = '#BBBBBB'; g.font = '15px Arial'; g.fillText(note, gap + 4, c.height - noteH / 2 - 2); }
    return c.toDataURL('image/png');
  }, { ...spec, cells });
  return pngBuffer(url);
}

module.exports = { gridSheet };
