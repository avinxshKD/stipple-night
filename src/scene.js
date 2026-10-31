(function (root) {
  'use strict';
  const W = 1920, H = 1080;
  const { mulberry32, modulo, seedFor } = root.NightRandom;
  const { DotBatch, BOIL_VARIANTS, generateField, drawField } = root.NightStipple;
  const Water = root.NightWater;
  const P = Object.freeze({
    cream: '#F4E4C1', peach: '#F2B27A', lavender: '#B9A3F2', violet: '#8E63D9',
    cobalt: '#2D6BE0', sky: '#2FA8F0', teal: '#2BA58F', green: '#35B56A',
    tangerine: '#F28A3C', mustard: '#E8B040', pink: '#E879B8', red: '#E0452F'
  });
  const STAR_COLORS = [P.violet, P.lavender, P.cobalt, P.sky, P.teal, P.green, P.tangerine, P.peach, P.mustard, P.pink, P.red];
  const BRIGHT_STARS = [P.cream, P.lavender, P.sky, P.peach];
  const MOON_GREY = '#BDB3CC', MOON_PEACH = '#F0CBA0';
  // Log-depth units the water moves toward the viewer per drawing; matched so a planted foot
  // travels with the water under it rather than sliding.
  const WATER_SPEED = 0.0181;
  const TWINKLE_PERIODS = Object.freeze([9, 12, 16, 18, 24, 36, 48]);
  const FIXED = 0x5EED;

  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const blend = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const dim = (hex, k) => '#' + [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('');
  const bumps = list => x => list.reduce((s, [c, a, w]) => s + a * Math.exp(-(((x - c) / w) ** 2)), 0);
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const toward = (hex, target, t) => '#' + blend(rgb(hex), rgb(target), t).map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  // A chime star's flare by drawings since its chime: up over 2, back down over 6.
  const flare = age => age < 2 ? (age + 1) / 2 : age < 8 ? Math.pow(1 - (age - 1) / 7, 1.6) : 0;

  function island(x0, x1, list, palette, reflection, litSide) {
    const raw = bumps(list);
    const heightAt = x => (x < x0 || x > x1) ? 0 : raw(x) * smooth(x0, x0 + 40, x) * smooth(x1, x1 - 60, x);
    return Object.freeze({ x0, x1, heightAt, peak: Math.max(...list.map(b => b[1])), palette, reflection, litSide });
  }

  const LAYOUTS = Object.freeze({
    // A texture test bench: big hills and a large moon so every texture shows in one crop.
    test: Object.freeze({
      horizon: 700, moon: Object.freeze({ x: 1104, y: 374, r: 363 }),
      stars: { count: 480, topBias: 1 }, hills: true, islands: [],
      water: { cx: 1104, farHalf: 52, nearHalf: 290, rippleRate: 380, glintRate: 2000 },
      figure: { x: 1104, feetY: 905, height: 216 }
    }),
    night: Object.freeze({
      horizon: 648, moon: Object.freeze({ x: 960, y: 451, r: 281 }),
      stars: { count: 300, topBias: 1.7, bright: 18 }, hills: false,
      islands: [
        island(-40, 530, [[30, 26, 80], [150, 44, 120], [300, 28, 100], [420, 12, 70]],
          ['#1E5E5A', '#2A4E73', '#38376A', '#3C8178'], ['#173F3D', '#22355A'], 1),
        island(1420, 1735, [[1530, 30, 70], [1645, 17, 60]],
          ['#3F3570', '#2B3F73', '#5A4A92', '#6A5AA0'], ['#2C2650', '#1F2D52'], -1)
      ],
      water: { cx: 960, farHalf: 118, nearHalf: 380, rippleRate: 380, glintRate: 2000 },
      figure: { x: 960, feetY: 826, height: 238, headTilt: 1 }
    })
  });

  const nearness = (L, y) => clamp((y - L.horizon) / (H - L.horizon));
  const probe = document.createElement('canvas').getContext('2d');

  function stars(L) {
    const random = mulberry32(seedFor(FIXED, 1));
    const { x: mx, y: my, r } = L.moon, list = [];
    const clear = (x, y) => Math.hypot(x - mx, y - my) > r * 1.12 + 18 && !L.islands.some(i => y > L.horizon - i.heightAt(x) - 6);
    for (let n = 0; n < L.stars.count; n++) {
      const x = random() * W, y = Math.pow(random(), L.stars.topBias) * (L.horizon - 8);
      const color = STAR_COLORS[Math.floor(random() * STAR_COLORS.length)], size = 0.85 + random() * 1.0;
      if (clear(x, y)) list.push({ x, y, r: size, color: L.stars.bright ? dim(color, 0.62) : color });
    }
    for (let n = 0; n < (L.stars.bright || 0); n++) {
      const x = random() * W, y = Math.pow(random(), 1.3) * (L.horizon - 60);
      const color = BRIGHT_STARS[Math.floor(random() * BRIGHT_STARS.length)], size = 2 + random() * 0.9;
      const period = TWINKLE_PERIODS[Math.floor(random() * TWINKLE_PERIODS.length)], phase = Math.floor(random() * period);
      if (clear(x, y)) list.push({ x, y, r: size, color, bright: true, period, phase, index: n });
    }
    return list;
  }

  // Seas laid out like the near side, in moon radii with +y up: Imbrium (upper left) running into
  // Procellarum down the left side, a separate Serenitatis and Tranquillitatis mass right of center
  // with a thin gap before Imbrium, Crisium alone on the right limb, two small central patches,
  // Nubium and Fecunditatis. The lower part stays pale. [x, y, rx, ry, rotation (counter-clockwise)]
  // The rx/ry are about 1.2x the visible radius, since a sea's edge sits inside its Gaussian falloff.
  const MARIA = Object.freeze([
    [-0.28, 0.5, 0.31, 0.27, 0.2], [-0.46, 0.3, 0.2, 0.22, 0.5],
    [-0.6, 0.08, 0.19, 0.36, 0.1], [-0.52, -0.16, 0.14, 0.17, -0.3],
    [0.31, 0.46, 0.17, 0.16, 0], [0.37, 0.28, 0.12, 0.13, 0], [0.4, 0.1, 0.24, 0.19, 0.35],
    [0.7, 0.27, 0.09, 0.075, -0.5],
    [0.03, 0.2, 0.13, 0.11, 0.3], [-0.1, -0.02, 0.14, 0.12, -0.2],
    [-0.2, -0.36, 0.22, 0.16, 0.25],
    [0.6, -0.15, 0.14, 0.12, 0.2]
  ].map(([x, y, rx, ry, rot]) => [x, -y, rx, ry, -rot]));
  // 0..1: how much a point (in moon radii) belongs to a sea. A slow warp keeps the edges irregular.
  function maria(nx, ny) {
    const wx = nx + 0.05 * Math.sin(4.3 * ny + 0.7) + 0.03 * Math.sin(7.9 * ny + 3.1 * nx + 2);
    const wy = ny + 0.05 * Math.sin(3.7 * nx + 1.9) + 0.03 * Math.sin(8.3 * nx - 2.6 * ny + 0.4);
    let outside = 1;
    for (const [mx, my, rx, ry, rot] of MARIA) {
      const c = Math.cos(rot), s = Math.sin(rot), px = wx - mx, py = wy - my;
      const u = (c * px + s * py) / rx, v = (-s * px + c * py) / ry;
      outside *= 1 - Math.exp(-(u * u + v * v));
    }
    return smooth(0.3, 0.72, 1 - outside);
  }
  const moonEdge = (r, theta) => r * (1 + 0.005 * Math.sin(theta * 9) + 0.003 * Math.sin(theta * 17));

  function moonFields(L, base, seed) {
    const { x: cx, y: cy, r } = L.moon, halo = r * 0.1;
    // Accents paint over the cream, so their share of visible area runs higher than these weights.
    // The seas are mostly lavender-grey with a little pale peach; the rim gets a little pink.
    const core = [0.992, 0.002, 0.003, 0.001, 0.002, 0], mare = [0.42, 0.003, 0.02, 0, 0.53, 0.027], limb = [0.95, 0.008, 0.006, 0.028, 0.008, 0];
    const disc = generateField({
      bounds: [cx - r - 4, cy - r - 4, cx + r + 4, L.horizon], diameterAt: () => base, seed,
      palette: [P.cream, P.peach, P.lavender, P.pink, MOON_GREY, MOON_PEACH], toggleRate: 0.008,
      sample(x, y) {
        if (y > L.horizon - 1) return null;
        const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy), edge = moonEdge(r, Math.atan2(dy, dx));
        if (d > edge) return null;
        const m = maria(dx / r, dy / r), rim = smooth(0.8, 1, d / edge);
        return { density: 0.95 - 0.1 * m - 0.22 * rim, weights: blend(blend(core, mare, m), limb, rim * 0.6) };
      }
    });
    const glow = generateField({
      bounds: [cx - r - halo, cy - r - halo, cx + r + halo, L.horizon], diameterAt: () => base * 0.5, seed: seed + 1,
      palette: ['#8F846F', '#8A6E58', '#6B6090', '#7A6070'], nudge: 0.8, toggleRate: 0,
      sample(x, y) {
        if (y > L.horizon - 1) return null;
        const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy), edge = moonEdge(r, Math.atan2(dy, dx));
        const h = (d - edge) / halo;
        if (h < 0 || h >= 1) return null;
        return { density: 0.16 * (1 - h) ** 2, weights: [0.7, 0.18, 0.12, 0] };
      }
    });
    return { disc, glow };
  }

  // Smooth gradients cost almost nothing to encode and make the moon glow rather than look cut out.
  function moonGlow(ctx, L) {
    const { x, y, r } = L.moon;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, L.horizon); ctx.clip();
    const g = ctx.createRadialGradient(x, y, r * 0.96, x, y, r * 1.24);
    g.addColorStop(0, 'rgba(244, 228, 193, 0.14)'); g.addColorStop(0.35, 'rgba(244, 228, 193, 0.06)'); g.addColorStop(1, 'rgba(244, 228, 193, 0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r * 1.24, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // A warm disc under the dots so the gaps read as soft texture: nearly the dot color at the core,
  // deepening toward the limb, and lavender-grey under the seas. Built once per layout, per pixel,
  // so the seas match the dots' mask exactly.
  const UNDER = Object.freeze([[0, [226, 209, 176]], [0.55, [214, 195, 161]], [0.85, [193, 170, 137]], [0.97, [172, 147, 116]]]);
  const SEA = [168, 158, 178];
  const underlayers = new Map();
  function moonUnderlayer(ctx, L) {
    const { x, y, r } = L.moon;
    let layer = underlayers.get(L);
    if (!layer) {
      const left = Math.floor(x - r * 1.02), top = Math.floor(y - r * 1.02), size = Math.ceil(r * 2.04) + 1;
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const g = c.getContext('2d'), img = g.createImageData(size, size);
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
          const nx = (left + i + 0.5 - x) / r, ny = (top + j + 0.5 - y) / r, d = Math.hypot(nx, ny);
          const alpha = clamp((1.012 - d) / 0.017);
          if (!alpha) continue;
          let k = 0;
          while (k < UNDER.length - 2 && d > UNDER[k + 1][0]) k++;
          const [d0, c0] = UNDER[k], [d1, c1] = UNDER[k + 1];
          const color = blend(blend(c0, c1, clamp((d - d0) / (d1 - d0))), SEA, 0.8 * maria(nx, ny));
          const o = 4 * (j * size + i);
          img.data[o] = Math.round(color[0]); img.data[o + 1] = Math.round(color[1]); img.data[o + 2] = Math.round(color[2]);
          img.data[o + 3] = Math.round(255 * alpha);
        }
      }
      g.putImageData(img, 0, 0);
      layer = { canvas: c, left, top };
      underlayers.set(L, layer);
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, L.horizon); ctx.clip();
    ctx.drawImage(layer.canvas, layer.left, layer.top);
    ctx.restore();
  }

  function horizonHaze(ctx, L) {
    const { x, r } = L.moon;
    ctx.save();
    ctx.translate(x, L.horizon); ctx.scale(1, 0.065);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.45);
    g.addColorStop(0, 'rgba(244, 228, 193, 0.24)'); g.addColorStop(0.5, 'rgba(244, 228, 193, 0.09)'); g.addColorStop(1, 'rgba(244, 228, 193, 0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.45, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function hillFields(L, base, seed) {
    const leftEdge = y => 857 - 0.29 * (y - 700) + 19 * Math.sin((y - 480) / 103);
    const rightEdge = y => 1240 + 0.31 * (y - 760) + 14 * Math.sin(y / 88);
    const shapes = [
      {
        bounds: [0, 485, 910, H], palette: [P.teal, P.sky, P.green, P.lavender],
        shade: [0.78, 0.07, 0.11, 0.04], lit: [0.5, 0.38, 0.06, 0.06], light: (x, y) => 1 - (leftEdge(y) - x) / 420,
        path() {
          const p = new Path2D();
          p.moveTo(-20, H + 20); p.lineTo(-20, 716);
          p.bezierCurveTo(115, 725, 186, 454, 357, 509); p.bezierCurveTo(474, 530, 499, 637, 618, 636);
          p.bezierCurveTo(745, 627, 779, 664, 869, 731); p.bezierCurveTo(835, 817, 800, 961, 757, H + 20);
          p.closePath(); return p;
        }
      },
      {
        bounds: [1200, 600, W, H], palette: [P.violet, P.lavender, P.pink, P.cobalt],
        shade: [0.78, 0.08, 0.06, 0.08], lit: [0.5, 0.4, 0.06, 0.04], light: (x, y) => 1 - (x - rightEdge(y)) / 380,
        path() {
          const p = new Path2D();
          p.moveTo(1333, H + 20); p.bezierCurveTo(1302, 938, 1208, 824, 1258, 744);
          p.bezierCurveTo(1302, 681, 1368, 707, 1414, 654); p.bezierCurveTo(1483, 573, 1555, 627, 1582, 659);
          p.bezierCurveTo(1649, 733, 1743, 725, 1780, 788); p.bezierCurveTo(1841, 861, 1939, 833, 1944, 868);
          p.lineTo(W + 20, H + 20); p.closePath(); return p;
        }
      }
    ];
    return shapes.map((s, n) => {
      const path = s.path();
      const dots = generateField({
        bounds: s.bounds, palette: s.palette, seed: seed + 10 + n,
        diameterAt: y => base * (0.9 + 0.5 * nearness(L, y)),
        sample(x, y) {
          if (!probe.isPointInPath(path, x, y)) return null;
          const light = Math.pow(clamp(s.light(x, y)), 1.4);
          return { density: 0.87 + 0.12 * light, size: 1 + 0.06 * light, weights: blend(s.shade, s.lit, light) };
        }
      });
      return { path, dots };
    });
  }

  function islandFields(L, seed) {
    return L.islands.map((isl, n) => generateField({
      bounds: [isl.x0, L.horizon - isl.peak - 6, isl.x1, L.horizon], diameterAt: () => 4.6, seed: seed + 20 + n,
      palette: isl.palette, nudge: 0.8,
      sample(x, y) {
        const h = isl.heightAt(x);
        if (y > L.horizon - 0.5 || y < L.horizon - h) return null;
        const towardMoon = isl.litSide > 0 ? smooth(isl.x1 - 260, isl.x1, x) : smooth(isl.x0 + 200, isl.x0, x);
        const top = smooth(h * 0.5, h, L.horizon - y);
        const light = clamp(0.25 * towardMoon + 0.35 * top * towardMoon);
        return { density: 0.8 + 0.12 * light, weights: blend([0.8, 0.1, 0.08, 0.02], [0.5, 0.08, 0.06, 0.36], light) };
      }
    }));
  }

  const cache = new Map();
  function assets(name, L, base, drawings, scatterKey) {
    const key = `${name}|${base}|${drawings}|${scatterKey}`;
    if (cache.has(key)) return cache.get(key);
    const seed = seedFor(scatterKey == null ? FIXED : scatterKey, 3);
    const tile = WATER_SPEED * drawings;
    const a = {
      stars: stars(L),
      moon: moonFields(L, base, seed),
      hills: L.hills ? hillFields(L, base, seed) : [],
      islands: islandFields(L, seed),
      reflections: Water.generateIslandReflections(L.islands, L.horizon, seed + 30),
      water: Water.generateWater({ ...L.water, horizon: L.horizon }, seed + 40, tile)
    };
    if (name === 'night') {
      for (const c of root.NightEvents.chimes) {
        const s = a.stars.find(t => t.bright && t.index === c.star);
        if (!s || Math.abs(s.x - c.x) > 0.1) throw new Error(`Chime at drawing ${c.drawing} names a star that is not in the sky.`);
      }
    }
    // Re-scattered drawings are never reused, so only the coherent set is kept.
    if (scatterKey == null) cache.set(key, a);
    return a;
  }

  function frame(index, ctx, options = {}) {
    if (!Number.isInteger(index)) throw new RangeError('Frame index must be an integer.');
    const { layout = 'night', boil = 'coherent', drawings = 144, base = 8.5 } = options;
    const L = LAYOUTS[layout];
    if (!L) throw new RangeError('Unknown layout.');
    if (!Number.isInteger(drawings) || drawings <= 0 || drawings % BOIL_VARIANTS) throw new RangeError('Drawing period must be a positive multiple of the boil cycle.');
    if (boil !== 'coherent' && boil !== 'scatter') throw new RangeError('Boil is coherent or scatter.');
    const drawing = modulo(Math.floor(index / 2), drawings);
    const coherent = boil === 'coherent';
    const variant = coherent ? drawing % BOIL_VARIANTS : -1;
    const a = assets(layout, L, base, drawings, coherent ? null : drawing);
    const waterCfg = { ...L.water, horizon: L.horizon, base };
    const flowU = coherent ? a.water.tile * drawing / drawings : 0;

    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, W, H);
    const batch = new DotBatch();
    const { TIMING, footsteps, chimes } = root.NightEvents;
    const timed = coherent && drawings === TIMING.drawings;
    for (const s of a.stars) {
      // Twinkle only with periods that divide the loop, so it stays seamless.
      if (!s.bright || !coherent || drawings % s.period) { batch.dot(s.x, s.y, s.r, s.color, 'stars'); continue; }
      const b = 0.5 + 0.5 * Math.cos(Math.PI * 2 * (drawing + s.phase) / s.period);
      const f = timed ? chimes.reduce((m, c) => c.star === s.index ? Math.max(m, flare(modulo(drawing - c.drawing, drawings))) : m, 0) : 0;
      if (f > 0) batch.dot(s.x, s.y, s.r * (2.2 + 1.6 * f), dim(s.color, 0.3 * f), 'star-flare');
      const lit = Math.max(b, f);
      batch.dot(s.x, s.y, s.r * (0.78 + 0.32 * lit) * (1 + 0.45 * f), toward(dim(s.color, 0.45 + 0.55 * lit), '#FFFFFF', 0.6 * f), 'stars');
    }
    batch.paint(ctx);
    moonGlow(ctx, L);
    moonUnderlayer(ctx, L);
    drawField(batch, a.moon.glow, variant, 'moon-halo'); batch.paint(ctx);
    drawField(batch, a.moon.disc, variant, 'moon'); batch.paint(ctx);
    a.islands.forEach(dots => drawField(batch, dots, variant, 'islands')); batch.paint(ctx);
    horizonHaze(ctx, L);
    Water.drawIslandReflections(batch, a.reflections, variant); batch.paint(ctx);
    const figure = { horizon: L.horizon, speed: WATER_SPEED, ...L.figure, ...options.figure };
    const walking = coherent && drawings % TIMING.strideDrawings === 0;
    const contacts = walking && timed ? footsteps.map(f => ({ drawing: f.drawing, point: root.NightFigure.contactPoint(f.foot, figure) })) : [];
    const rings = Water.rippleRings(contacts, waterCfg, drawing, drawings, WATER_SPEED);
    Water.drawWater(batch, a.water, waterCfg, drawing, variant, flowU, rings); batch.paint(ctx);
    Water.drawRippleCrests(batch, rings, base, variant); batch.paint(ctx);
    for (const h of a.hills) {
      ctx.fillStyle = '#000000'; ctx.fill(h.path);
      drawField(batch, h.dots, variant, 'hills'); batch.paint(ctx);
    }
    const phase = walking ? (drawing % TIMING.strideDrawings) / TIMING.strideDrawings : 0;
    root.NightFigure.draw(ctx, coherent ? variant : drawing + 1000, { phase, ...figure });
    ctx.restore();
    return { drawing, variant, layout, boil, dots: batch.count, layers: batch.layers };
  }

  const brightStars = (name = 'night') => stars(LAYOUTS[name]).filter(s => s.bright);

  root.StippleNight = Object.freeze({ W, H, P, LAYOUTS, frame, brightStars });
})(window);
