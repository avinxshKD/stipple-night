(function (root) {
  'use strict';
  const { mulberry32, modulo } = root.NightRandom;
  const { pick, boilFor } = root.NightStipple;
  const H = 1080, W = 1920;
  // u is log-depth: q = exp(-u) runs from 1 at the bottom of the frame to 0 at the horizon,
  // and screen y = horizon + (H - horizon) * q. Flowing at a constant rate in u is self-similar,
  // so one tile of dashes repeated along u loops seamlessly and still compresses toward the horizon.
  const U_NEAR = -0.08;
  const TWINKLE_PERIODS = Object.freeze([6, 8, 12, 24]);
  const RIPPLE = Object.freeze({ colors: ['#15255A', '#1E3B78', '#2F2864'], weights: [0.5, 0.32, 0.18] });
  const GLINT = Object.freeze({
    colors: ['#F4E4C1', '#EAD39B', '#B9A3F2', '#E879B8'],
    dim: ['#8C8170', '#6A5E9C']
  });
  // Footstep ripples: two concentric rings per step, each a dark trough of missing glitter with a
  // crest of bright glints just outside it. reach is the outer ring's final long radius (px).
  const RIPPLE_RING = Object.freeze({ life: 18, reach: 150, start: 8, aspect: 4, inner: 0.58, crestDashes: 64 });
  const CREST = '#FFF8EA';

  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const shade = (hex, k) => '#' + [1, 3, 5].map(i => Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * k)).toString(16).padStart(2, '0')).join('');
  const depthScale = q => 0.5 + q;
  // The reflection is brightest from the horizon to the figure, then dims and thins toward the viewer.
  const glintFade = q => smooth(0.42, 1.05, q);

  function generateWater(cfg, seed, tile) {
    const random = mulberry32(seed);
    const ripples = [], glints = [];
    const rippleCount = Math.round(cfg.rippleRate * tile), glintCount = Math.round(cfg.glintRate * tile);
    for (let i = 0; i < rippleCount; i++) {
      const s = random() * 2 - 1, colorPick = random();
      // Ripples only move down the screen, so their distance from the moonlight is fixed.
      const near = Math.exp(-(((s * W * 0.56) / 560) ** 2));
      ripples.push({
        u: random() * tile, s, len: 1.2 + random() * 2.4, th: 0.3 + random() * 0.18,
        color: shade(RIPPLE.colors[pick(RIPPLE.weights, colorPick)], 0.78 + 0.6 * near), keep: random(), boil: boilFor(random, 0, 0)
      });
    }
    for (let i = 0; i < glintCount; i++) {
      const xn = (random() + random() + random() - 1.5) * 1.3;
      const center = Math.exp(-4 * xn * xn), colorPick = random(), dimPick = random();
      const color = Math.abs(xn) > 1.05 && dimPick < 0.6
        ? GLINT.dim[dimPick < 0.3 ? 0 : 1]
        : GLINT.colors[pick([0.58 + 0.2 * center, 0.22 + 0.04 * center, 0.17 - 0.12 * center, 0.03 - 0.02 * center], colorPick)];
      const period = TWINKLE_PERIODS[Math.floor(random() * TWINKLE_PERIODS.length)];
      const th = 0.3 + random() * 0.16;
      glints.push({
        u: random() * tile, xn, th, len: th * (2.8 + random() * 2.4), color, dimColor: shade(color, 0.55),
        keep: random(), fadePick: random(),
        period, phase: Math.floor(random() * period), on: Math.round(period * (0.5 + random() * 0.35)),
        boil: boilFor(random, 0.8, 0)
      });
    }
    return { tile, ripples, glints };
  }

  // The rings alive at this drawing. Ages wrap across the loop, so steps late in the loop still
  // ripple at its start. Each ring rides the flow: its center and size grow with depth.
  function rippleRings(contacts, cfg, drawing, drawings, speedU) {
    const K = H - cfg.horizon, R = RIPPLE_RING, rings = [];
    for (const c of contacts) {
      const age = modulo(drawing - c.drawing, drawings);
      if (age >= R.life) continue;
      const t = age / R.life, grow = Math.exp(speedU * age);
      const q = (c.point[1] - cfg.horizon) / K * grow;
      // Sized so the outer ring reaches its full radius, perspective growth included, at the end of its life.
      const radius = (R.start + (R.reach / Math.exp(speedU * (R.life - 1)) - R.start) * (1 - Math.pow(1 - t, 1.7))) * grow;
      const strength = Math.pow(1 - t, 0.85);
      [[radius, strength], [radius * R.inner, strength * 0.8]].forEach(([rx, s], k) => {
        const ry = rx / R.aspect;
        // Thin, but never thinner than about a dash's height, or the trough disappears top and bottom.
        const band = Math.min(0.6, Math.max(0.16, 12 / rx, 5 / ry));
        rings.push({ x: c.point[0], y: cfg.horizon + K * q, rx, ry, band, strength: s, q, key: c.drawing * 2 + k });
      });
    }
    return rings;
  }

  // In ring space e = 1 is the ring line; the trough is the band just inside it, the crest the band
  // just outside. A dash (half-size hl x hh) that overlaps the trough at all is in it, so the trough
  // reads as a clean dark line rather than a gap that neighbouring dashes poke into.
  function rippleAt(rings, x, y, hl, hh) {
    let trough = 0, crest = 0;
    for (const r of rings) {
      const dx = (x - r.x) / r.rx, dy = (y - r.y) / r.ry;
      if (Math.abs(dx) > 1.8 || Math.abs(dy) > 1.8) continue;
      const e = Math.hypot(dx, dy) || 1e-6;
      const m = (Math.abs(dx) * hl / r.rx + Math.abs(dy) * hh / r.ry) / e;
      if (e - m < 1 && e + m > 1 - r.band) trough = Math.max(trough, r.strength);
      else if (e - m >= 1 && e - m < 1 + r.band) crest = Math.max(crest, r.strength);
    }
    return { trough, crest };
  }

  // flowU is how far the pattern has moved toward the viewer; variant < 0 disables boil and twinkle.
  // pick01 is a fixed per-dash value, so a fading trough thins the same dashes from one drawing to the next.
  function drawWater(batch, water, cfg, drawing, variant, flowU, rings = []) {
    const K = H - cfg.horizon, uFar = Math.log(K / 1.2), base = cfg.base;
    const k = Math.max(0, variant) * 4;
    const touched = (x, y, len, th, pick01) => {
      if (!rings.length) return 0;
      const { trough, crest } = rippleAt(rings, x, y, len / 2, th / 2);
      if (trough && pick01 < 0.1 + 0.9 * trough) return -1;
      return crest && pick01 < 0.2 + 0.8 * crest ? crest : 0;
    };
    for (const r of water.ripples) {
      for (let u = U_NEAR + modulo(r.u - flowU, water.tile); u < uFar; u += water.tile) {
        const q = Math.exp(-u);
        if (r.keep > Math.min(1, 0.22 + 4 * q)) continue;
        const ds = depthScale(q), scale = variant < 0 ? 1 : r.boil[k + 2];
        const x = cfg.cx + r.s * W * 0.56, y = cfg.horizon + K * q;
        const len = base * ds * r.len * scale, th = Math.max(1, base * ds * r.th * scale);
        if (touched(x, y, len, th, r.keep) < 0) continue;
        batch.dash(x, y, len, th, r.color, 'ripples');
      }
    }
    for (const g of water.glints) {
      if (variant >= 0 && modulo(drawing + g.phase, g.period) >= g.on) continue;
      for (let u = U_NEAR + modulo(g.u - flowU, water.tile); u < uFar; u += water.tile) {
        const q = Math.exp(-u), fade = glintFade(q);
        if (g.keep > Math.min(1, 0.18 + q / 0.22) * (1 - 0.55 * fade)) continue;
        const half = cfg.farHalf + (cfg.nearHalf - cfg.farHalf) * Math.min(q, 1.1);
        const ds = depthScale(q) * (1 - 0.3 * smooth(0.3, 1, q)), b = g.boil;
        const dx = variant < 0 ? 0 : b[k], scale = variant < 0 ? 1 : b[k + 2];
        const x = cfg.cx + g.xn * half + dx, y = cfg.horizon + K * q;
        const len = base * ds * g.len * scale, th = Math.max(1, base * ds * g.th * scale);
        const hit = touched(x, y, len, th, g.fadePick);
        if (hit < 0) continue;
        const color = hit ? CREST : g.fadePick < 0.8 * fade ? g.dimColor : g.color;
        const lift = 1 + 0.35 * hit;
        batch.dash(x, y, len * lift, th * lift, color, hit ? 'ripple-crest' : 'glitter');
      }
    }
  }

  // Extra bright glints scattered along each crest, so a ring reads even where the water is sparse.
  // Their angles are fixed per ring, so a ring expands smoothly instead of re-scattering.
  function drawRippleCrests(batch, rings, base, variant) {
    const n = RIPPLE_RING.crestDashes;
    for (const r of rings) {
      const random = mulberry32(0x51DE + r.key * 7919);
      const ds = depthScale(r.q), v = Math.max(0, variant);
      for (let j = 0; j < n; j++) {
        const a = (j + random() * 0.8) / n * Math.PI * 2, out = random(), keep = random(), len = random();
        const jitter = [random(), random(), random()][v];
        if (keep > 0.2 + 0.7 * r.strength) continue;
        const e = 1 + r.band * (0.3 + 0.5 * out) + 0.04 * (jitter - 0.5);
        const x = r.x + Math.cos(a) * r.rx * e, y = r.y + Math.sin(a) * r.ry * e;
        // Dashes follow the ellipse, so near its ends they shorten as the ring turns away.
        const along = Math.abs(Math.sin(a)) * 0.6 + 0.4;
        batch.dash(x, y, base * ds * (0.7 + 0.5 * len) * along, Math.max(1, base * ds * 0.4), CREST, 'ripple-crest');
      }
    }
  }

  // Sparse, dim, static dashes mirroring each island; they only boil.
  function generateIslandReflections(islands, horizon, seed) {
    const random = mulberry32(seed);
    const dashes = [];
    for (const island of islands) {
      for (let y = horizon + 2; y < horizon + island.peak * 1.1; y += 2.6 + (y - horizon) * 0.08) {
        for (let x = island.x0; x < island.x1; x += 9 + random() * 16) {
          const len = 4 + random() * 9, th = 1.2 + random() * 0.9, accept = random(), colorPick = random();
          const boil = boilFor(random, 0.9, 0);
          const depth = (y - horizon) / Math.max(1, island.heightAt(x));
          if (depth > 1 || accept > 0.42 * (1 - depth)) continue;
          dashes.push({ x, y, len, th, color: island.reflection[colorPick < 0.7 ? 0 : 1], boil });
        }
      }
    }
    return dashes;
  }

  function drawIslandReflections(batch, dashes, variant) {
    const k = Math.max(0, variant) * 4;
    for (const d of dashes) {
      const dx = variant < 0 ? 0 : d.boil[k] * 1.4, scale = variant < 0 ? 1 : d.boil[k + 2];
      batch.dash(d.x + dx, d.y, d.len * scale, d.th, d.color, 'island-reflections');
    }
  }

  root.NightWater = Object.freeze({
    depthScale, generateWater, drawWater, generateIslandReflections, drawIslandReflections, rippleRings, drawRippleCrests, RIPPLE_RING
  });
})(window);
