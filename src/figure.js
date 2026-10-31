(function (root) {
  'use strict';
  const { mulberry32, seedFor } = root.NightRandom;
  const TAU = Math.PI * 2;
  const LINE = 5.5;
  // Local units: feet at y = 0, head top near y = -214; scaled to the requested height.
  const LOCAL_HEIGHT = 214;
  const BOX = Object.freeze({ left: -60, top: -240, width: 120, height: 262 });
  // stance: share of the stride a foot is planted (11 of 18 drawings, so contact and toe-off land on
  // whole drawings). lift: peak height of the swinging foot. sway/counter: hip and shoulder shift.
  const GAIT = Object.freeze({ stance: 11 / 18, lift: 22, sway: 6.5, counter: 2, bob: 3.6, ankle: 7.8 });
  const REFLECTION = Object.freeze({ squash: 0.42, alpha: 0.7, gap: 3 });

  const lerp = (a, b, t) => a + (b - a) * t;
  const mix2 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

  function chaikin(points, rounds, closed = true) {
    let p = points;
    for (let r = 0; r < rounds; r++) {
      const next = closed ? [] : [p[0]];
      const n = closed ? p.length : p.length - 1;
      for (let i = 0; i < n; i++) {
        const a = p[i], b = p[(i + 1) % p.length];
        next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
        next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
      }
      if (!closed) next.push(p[p.length - 1]);
      p = next;
    }
    return p;
  }

  function ellipse(cx, cy, rx, ry, steps = 20) {
    return Array.from({ length: steps }, (_, i) => {
      const a = i / steps * TAU;
      return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
    });
  }

  // Outline of a tapered tube around a centerline, with round ends.
  function limb(center, widths) {
    const n = center.length, leftSide = [], rightSide = [];
    for (let i = 0; i < n; i++) {
      const a = center[Math.max(0, i - 1)], b = center[Math.min(n - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len, w = widths[i];
      leftSide.push([center[i][0] + nx * w, center[i][1] + ny * w]);
      rightSide.push([center[i][0] - nx * w, center[i][1] - ny * w]);
    }
    const cap = (p, q, w) => {
      const out = [], base = Math.atan2(q[1] - p[1], q[0] - p[0]) + Math.PI / 2;
      for (let k = 1; k < 6; k++) {
        const a = base + k / 6 * Math.PI;
        out.push([p[0] + w * Math.cos(a), p[1] + w * Math.sin(a)]);
      }
      return out;
    };
    return [...leftSide, ...cap(center[n - 1], center[n - 2], widths[n - 1]), ...rightSide.reverse(), ...cap(center[0], center[1], widths[0])];
  }

  function resample(points, spacing, closed = true) {
    const out = [];
    const n = closed ? points.length : points.length - 1;
    for (let i = 0; i < n; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / spacing));
      for (let k = 0; k < steps; k++) out.push([a[0] + (b[0] - a[0]) * k / steps, a[1] + (b[1] - a[1]) * k / steps]);
    }
    if (!closed) out.push(points[points.length - 1]);
    return out;
  }

  // Low-frequency drift plus a little tremor, re-rolled per boil variant, gives a pen line that boils.
  function wobble(points, random) {
    const p1 = random() * TAU, p2 = random() * TAU, p3 = random() * TAU, p4 = random() * TAU;
    let s = 0;
    return points.map((pt, i) => {
      if (i) s += Math.hypot(pt[0] - points[i - 1][0], pt[1] - points[i - 1][1]);
      return [
        pt[0] + 1.1 * Math.sin(s / 21 + p1) + 0.4 * Math.sin(s / 7 + p2) + (random() - 0.5) * 0.5,
        pt[1] + 1.1 * Math.sin(s / 25 + p3) + 0.4 * Math.sin(s / 8 + p4) + (random() - 0.5) * 0.5
      ];
    });
  }

  function toPath(points, closed = true) {
    const path = new Path2D();
    points.forEach((p, i) => i ? path.lineTo(p[0], p[1]) : path.moveTo(p[0], p[1]));
    if (closed) path.closePath();
    return path;
  }

  function inkLine(ctx, points, random, width, closed) {
    const q1 = random() * TAU, q2 = random() * TAU;
    const n = closed ? points.length : points.length - 1;
    let s = 0;
    for (let i = 0; i < n; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      s += Math.hypot(b[0] - a[0], b[1] - a[1]);
      const taper = closed ? 1 : Math.min(1, 0.45 + 1.4 * Math.min(i, n - 1 - i) / n);
      ctx.lineWidth = width * taper * (1 + 0.18 * Math.sin(s / 33 + q1) + 0.08 * Math.sin(s / 12 + q2));
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
  }

  // How the ground moves under the figure, in local units: depth is the distance from the horizon
  // down to the feet line, k the log-depth the water flows during one stance. A planted foot rides
  // the water exactly, so it never skates and its ripple stays under it.
  function groundFor(options = {}) {
    const { feetY = 826, height = 238, horizon = 648, speed = 0.0181 } = options;
    const strideDrawings = root.NightEvents.TIMING.strideDrawings;
    return { depth: (feetY - horizon) / (height / LOCAL_HEIGHT), k: speed * GAIT.stance * strideDrawings };
  }
  // Foot height on screen (local units, 0 = feet line) t of the way through stance.
  const stanceY = (ground, t) => ground.depth * (Math.exp(ground.k * (t - 1)) - 1);

  // One leg at stride phase phi (0 = heel contact, planted far ahead). In stance the foot rides
  // the water toward the viewer (down the screen) and its heel peels up at the end; in swing the
  // lower leg kicks back toward the viewer (rising and foreshortening) and reaches forward again.
  function leg(phi, side, hipX, bob, ground) {
    const reach = -stanceY(ground, 0);
    let groundY, liftN = 0, heel = 0;
    if (phi < GAIT.stance) {
      const t = phi / GAIT.stance;
      groundY = stanceY(ground, t);
      heel = smooth(0.7, 1, t);
    } else {
      const t = (phi - GAIT.stance) / (1 - GAIT.stance);
      groundY = -reach * (0.5 - 0.5 * Math.cos(Math.PI * t));
      liftN = Math.sin(Math.PI * Math.pow(t, 0.7));
    }
    const footY = groundY - GAIT.lift * liftN;
    const hip = [side * 6.5 + hipX, -104 + bob];
    const ankleX = side * (GAIT.ankle - 1.5 * liftN);
    const ankle = [ankleX, footY - 5.5 - 3 * heel];
    const rest = mix2(hip, [ankleX, groundY - 5.5], 0.5);
    const knee = [rest[0] + side * (0.8 + 1.4 * liftN), rest[1] - 3 * liftN];
    const thigh = mix2(hip, knee, 0.45);
    return {
      outline: limb([hip, thigh, knee, ankle], [8.4, 7, 4.7, 3.3]),
      // The sole turns toward the viewer as the heel lifts.
      foot: ellipse(ankleX + side * 0.4, footY - 2.6 - 1.5 * heel, 4.3, 2.4 + 2.6 * liftN + 1.4 * heel, 14),
      knee, liftN, groundY
    };
  }

  // Arm swing s: 1 = forward (forearm foreshortened, hand higher and in), -1 = back (longer, out).
  function arm(s, side, shX, bob) {
    const t = (1 - s) / 2;
    const at = ([x, y]) => [x + shX, y + bob];
    const shoulder = at([side * 18, -173]);
    const elbow = at(mix2([side * 21, -151], [side * 23.5, -144], t));
    const hand = at(mix2([side * 21.5, -133], [side * 27.5, -104], t));
    const wrist = mix2(elbow, hand, 0.82);
    return [limb([shoulder, elbow, wrist], [4.6, 3.7, 2.9]), ellipse(hand[0], hand[1], 3.6, 4.2, 12)];
  }

  function pose(phase, headTilt, ground = groundFor()) {
    const p = ((phase % 1) + 1) % 1;
    // Lowest at each contact, highest mid-stance: twice per stride.
    const bob = GAIT.bob * Math.cos(TAU * 2 * p);
    // Hips shift over the planted foot; shoulders lean slightly the other way.
    const lean = Math.cos(TAU * (p - 0.3));
    const hipX = -GAIT.sway * lean, shX = GAIT.counter * lean;
    const xAt = y => lerp(shX, hipX, clamp((y + 175) / 71));
    const up = pts => pts.map(([x, y]) => [x + xAt(y), y + bob]);
    const left = leg(p, -1, hipX, bob, ground), right = leg((p + 0.5) % 1, 1, hipX, bob, ground);
    // The leg whose foot sits lower on the screen is nearer the viewer and overlaps the other.
    const [far, near] = left.groundY > right.groundY ? [right, left] : [left, right];
    const swing = Math.cos(TAU * (p - 0.04));
    const [leftArm, leftHand] = arm(-swing, -1, shX, bob), [rightArm, rightHand] = arm(swing, 1, shX, bob);
    return {
      body: {
        head: up(ellipse(0.5, -200 + 3 * headTilt, 11, 14 - 1.6 * headTilt)),
        neck: up([[-4.5, -189 + 2 * headTilt], [5, -189 + 2 * headTilt], [5.5, -177], [-4.5, -177]]),
        torso: up([[-16.5, -182], [17, -182], [20.5, -172], [17.5, -146], [14, -114], [11.5, -100], [-11.5, -100], [-14, -114], [-17.5, -146], [-20.5, -172]]),
        farLeg: far.outline, farFoot: far.foot
      },
      nearLeg: [near.outline, near.foot],
      arms: [[leftArm, leftHand], [rightArm, rightHand]],
      details: [
        ...[left, right].filter(l => l.liftN > 0.25).map(l => [[l.knee[0] - 3, l.knee[1] + 0.5], [l.knee[0], l.knee[1] + 2], [l.knee[0] + 3, l.knee[1] + 0.5]])
      ],
      bob, hipY: -104 + bob
    };
  }

  const ROUND = new Set(['head', 'farFoot']);
  const canvases = {};
  function layer(name, width, height) {
    let c = canvases[name];
    if (!c || c.width !== width || c.height !== height) {
      c = document.createElement('canvas');
      c.width = width; c.height = height;
      canvases[name] = c;
    }
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.filter = 'none';
    g.clearRect(0, 0, width, height);
    return [c, g];
  }

  // The figure's water reflection: flipped, squashed, sliced into wavering rows and broken into dashes.
  function reflection(art, random, phase) {
    const [c, g] = layer('reflection', art.width, art.height);
    const rows = 4, p1 = random() * TAU;
    for (let y = 0; y < art.height; y += rows) {
      const dx = 1.6 * Math.sin(y / 9 + p1 + TAU * phase) + (random() - 0.5) * 1.2;
      g.drawImage(art, 0, y, art.width, rows, dx, y, art.width, rows);
    }
    // destination-in clears everything outside each draw call, so the dashes must be one fill.
    const dashes = new Path2D();
    for (let y = 0; y < art.height; y += rows + REFLECTION.gap) {
      for (let x = random() * 6; x < art.width; x += 4 + random() * 8) {
        const len = 5 + random() * 12;
        dashes.rect(x, y, len, rows);
        x += len;
      }
    }
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = '#FFFFFF';
    g.fill(dashes);
    return c;
  }

  // wobbleKey selects the line's wobble: the drawing index for a full re-roll, or a boil variant.
  function draw(ctx, wobbleKey, options = {}) {
    const { x = 960, feetY = 826, height = 238, halo = true, headTilt = 0, phase = 0, mirror = true } = options;
    const scale = height / LOCAL_HEIGHT;
    const random = mulberry32(seedFor(wobbleKey, 40));
    const P = pose(phase, headTilt, groundFor(options));
    const shape = (pts, round) => wobble(resample(round ? pts : chaikin(pts, 2), 3), random);
    const parts = Object.fromEntries(Object.entries(P.body).map(([name, pts]) => [name, shape(pts, ROUND.has(name))]));
    const body = Object.values(parts);
    const nearLeg = [shape(P.nearLeg[0], false), shape(P.nearLeg[1], true)];
    const arms = P.arms.map(([a, hand]) => [shape(a, false), shape(hand, true)]);
    const details = P.details.map(line => wobble(resample(chaikin(line, 2, false), 2.5, false), random));

    const width = Math.ceil(BOX.width * scale), tall = Math.ceil(BOX.height * scale);
    const [art, g] = layer('figure', width, tall);
    g.setTransform(scale, 0, 0, scale, -BOX.left * scale, -BOX.top * scale);
    g.lineJoin = 'round'; g.lineCap = 'round'; g.strokeStyle = '#FFFFFF'; g.fillStyle = '#000000';
    // Doubled strokes, then erasing every interior, leaves only the outer half: the union's contour.
    for (const s of body) inkLine(g, s, random, 2 * LINE / scale, true);
    g.globalCompositeOperation = 'destination-out';
    for (const s of body) g.fill(toPath(s));
    g.globalCompositeOperation = 'source-over';
    // A part on top hides the lines behind it, then gets its own contour. Shapes are filled one
    // at a time because mixed winding directions in one path would leave holes.
    const overlay = (shapes, clip) => {
      g.save();
      if (clip) g.clip(clip);
      g.globalCompositeOperation = 'destination-out';
      for (const s of shapes) g.fill(toPath(s));
      g.globalCompositeOperation = 'source-over';
      for (const s of shapes) inkLine(g, s, random, 2 * LINE / scale, true);
      g.globalCompositeOperation = 'destination-out';
      for (const s of shapes) g.fill(toPath(s));
      g.restore();
    };
    // The near leg stays open at the top so it flows into the hips instead of capping off.
    const belowHips = new Path2D();
    belowHips.rect(BOX.left, P.hipY + 2, BOX.width, BOX.height);
    overlay(nearLeg, belowHips);
    for (const a of arms) overlay(a);
    for (const d of details) inkLine(g, d, random, 0.9 * LINE / scale, false);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const left = Math.round(x + BOX.left * scale), top = Math.round(feetY + BOX.top * scale);
    if (mirror) {
      const water = reflection(art, random, phase);
      const axis = feetY + 3;
      ctx.save();
      // Additive, so the reflection can only brighten the water and never darkens the glitter.
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = REFLECTION.alpha;
      ctx.setTransform(1, 0, 0, -REFLECTION.squash, 0, axis * (1 + REFLECTION.squash));
      ctx.drawImage(water, left, top - (feetY - axis));
      ctx.restore();
    }
    if (halo) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
      ctx.shadowBlur = 7;
      ctx.drawImage(art, left, top);
    }
    ctx.shadowColor = 'rgba(0, 0, 0, 0)'; ctx.shadowBlur = 0;
    ctx.filter = 'blur(0.45px)';
    ctx.drawImage(art, left, top);
    ctx.restore();
  }

  // Screen point where a foot touches the water at heel contact.
  function contactPoint(foot, options = {}) {
    const { x = 960, feetY = 826, height = 238 } = options;
    const scale = height / LOCAL_HEIGHT, side = foot === 'left' ? -1 : 1;
    const reach = -stanceY(groundFor(options), 0);
    return [x + side * (GAIT.ankle + 0.4) * scale, feetY - (reach + 2.6) * scale];
  }

  root.NightFigure = Object.freeze({ draw, pose, contactPoint, groundFor, GAIT });
})(window);
