(function (root) {
  'use strict';
  const TAU = Math.PI * 2;
  const { mulberry32 } = root.NightRandom;
  const BOIL_VARIANTS = 3;

  class DotBatch {
    constructor() {
      this.paths = new Map();
      this.count = 0;
      this.layers = {};
    }
    path(color, layer) {
      let path = this.paths.get(color);
      if (!path) { path = new Path2D(); this.paths.set(color, path); }
      this.count++;
      this.layers[layer] = (this.layers[layer] || 0) + 1;
      return path;
    }
    dot(x, y, radius, color, layer) {
      const path = this.path(color, layer);
      path.moveTo(x + radius, y);
      path.arc(x, y, radius, 0, TAU);
    }
    dash(x, y, length, thickness, color, layer) {
      const path = this.path(color, layer);
      path.moveTo(x + length / 2, y);
      path.ellipse(x, y, length / 2, thickness / 2, 0, 0, TAU);
    }
    paint(ctx) {
      for (const [color, path] of this.paths) {
        ctx.fillStyle = color;
        ctx.fill(path);
      }
      this.paths.clear();
    }
  }

  function pick(weights, u) {
    let total = 0;
    for (const w of weights) total += w;
    let s = 0;
    for (let i = 0; i < weights.length; i++) {
      s += weights[i] / total;
      if (u < s) return i;
    }
    return weights.length - 1;
  }

  // Per-dot boil: for each of the cycle's variants, a small offset from home, a radius scale,
  // and whether the dot swaps to its alternate color.
  function boilFor(random, nudge, toggleRate) {
    const out = [];
    for (let v = 0; v < BOIL_VARIANTS; v++) {
      const a = random() * TAU, m = nudge * (0.55 + random() * 0.45);
      out.push(m * Math.cos(a), m * Math.sin(a), 1 + (random() - 0.5) * 0.2, random() < toggleRate ? 1 : 0);
    }
    return out;
  }

  // Generates a stipple field once. sample(x, y) returns null outside the shape, or
  // { density, size?, weights? }. diameterAt(y) lets dots grow toward the viewer.
  // Every lattice cell draws the same number of random values whether or not it is kept,
  // so one region's density never shifts another region's dots.
  function generateField(options) {
    const { bounds, diameterAt, seed, sample, palette, nudge = 1.1, toggleRate = 0.05 } = options;
    const random = mulberry32(seed);
    const [left, top, right, bottom] = bounds;
    const dots = [];
    let y = top - random() * 4, row = 0;
    while (y < bottom + 8) {
      const diameter = diameterAt(y);
      // A jittered hex lattice keeps packing even; pure random placement clumps and leaves holes.
      const pitch = diameter * 0.8, rowStep = pitch * Math.sqrt(3) / 2;
      const offset = (row % 2) * pitch / 2 + random() * pitch * 0.2;
      for (let x = left - pitch + offset; x < right + pitch; x += pitch) {
        const px = x + (random() - 0.5) * pitch * 0.6;
        const py = y + (random() - 0.5) * rowStep * 0.6;
        const size = diameter * (0.75 + random() * 0.5);
        const accept = random(), colorPick = random(), altPick = random();
        const boil = boilFor(random, nudge, toggleRate);
        const surface = sample(px, py);
        if (!surface || accept > surface.density) continue;
        const weights = surface.weights || [0.78, 0.1, 0.08, 0.04];
        const color = pick(weights, colorPick);
        const accents = weights.map((w, i) => i === 0 ? 0 : w);
        const alt = color === 0 ? pick(accents, altPick) : 0;
        dots.push({ x: px, y: py, r: size * 0.5 * (surface.size || 1), color: palette[color], alt: palette[alt], boil });
      }
      y += rowStep; row++;
    }
    return dots;
  }

  // variant < 0 draws dots at home with no boil.
  function drawField(batch, dots, variant, layer) {
    for (const d of dots) {
      if (variant < 0) { batch.dot(d.x, d.y, d.r, d.color, layer); continue; }
      const b = d.boil, k = variant * 4;
      batch.dot(d.x + b[k], d.y + b[k + 1], d.r * b[k + 2], b[k + 3] ? d.alt : d.color, layer);
    }
  }

  root.NightStipple = Object.freeze({ DotBatch, BOIL_VARIANTS, pick, boilFor, generateField, drawField });
})(window);
