(function (root) {
  'use strict';
  function mulberry32(seed) {
    return () => {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const modulo = (n, period) => ((n % period) + period) % period;
  const seedFor = (drawing, layer) => (0x61C8A93D ^ Math.imul(drawing + 1, 0x45D9F3B) ^ Math.imul(layer + 1, 0x27D4EB2D)) >>> 0;
  root.NightRandom = Object.freeze({ mulberry32, modulo, seedFor });
})(window);
