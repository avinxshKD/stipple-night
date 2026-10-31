(function (root) {
  'use strict';
  // One shared timeline for picture and sound. Animation is on twos: drawing d = floor(frame / 2).
  const TIMING = Object.freeze({ fps: 24, frames: 288, drawings: 144, stepDrawings: 9, strideDrawings: 18 });
  const strides = TIMING.drawings / TIMING.strideDrawings;
  if (!Number.isInteger(strides)) throw new Error('The walk cycle must fit the loop a whole number of times.');
  const at = drawing => ({ drawing, frame: drawing * 2, seconds: drawing * 2 / TIMING.fps });

  const footsteps = Object.freeze(Array.from({ length: TIMING.drawings / TIMING.stepDrawings }, (_, n) => Object.freeze({
    type: 'footstep', foot: n % 2 ? 'right' : 'left', ...at(n * TIMING.stepDrawings)
  })));

  // star is the bright star's generation index (StippleNight.brightStars()[k].index); x is its
  // screen x for panning. The scene checks both against its own star field.
  const chimes = Object.freeze([
    [18, 5, 296.6], [54, 10, 1432.0], [90, 6, 553.2], [126, 12, 1640.1]
  ].map(([drawing, star, x]) => Object.freeze({ type: 'chime', ...at(drawing), star, x })));

  const events = Object.freeze([...footsteps, ...chimes].sort((a, b) => a.drawing - b.drawing || (a.type < b.type ? -1 : 1)));
  const api = Object.freeze({ TIMING, footsteps, chimes, events });
  root.NightEvents = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
