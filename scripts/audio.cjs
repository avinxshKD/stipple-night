'use strict';
// Synthesizes the 12-second soundtrack from src/events.js and writes output/audio: the loop WAV,
// a three-loop WAV, audio-report.json, events-used.md, and a spectrogram and waveform.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'output', 'audio');
const { FFMPEG } = require('./media.cjs');
const SR = 48000;
const SECONDS = 12;
const N = SR * SECONDS;
const TOTAL = N * 3;
const TAU = Math.PI * 2;
const SEED = 0x61C8A93D;
const TARGET = -14;
const CEILING = 0.86;
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src', 'rng.js'), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src', 'events.js'), 'utf8'), sandbox);
const { mulberry32 } = sandbox.window.NightRandom;
const timeline = sandbox.window.NightEvents;
const footsteps = Array.from(timeline.footsteps);
const chimes = Array.from(timeline.chimes || timeline.events.filter(e => e.type === 'chime'));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const quantizeHz = f => Math.round(f * SECONDS) / SECONDS;
const midiHz = midi => quantizeHz(440 * 2 ** ((midi - 69) / 12));
const noteName = midi => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][midi % 12] + (Math.floor(midi / 12) - 1);
const pans = pan => [Math.cos((pan + 1) * Math.PI / 4), Math.sin((pan + 1) * Math.PI / 4)];
const chords = [
  { name: 'Dmaj9', midi: [50, 54, 57, 61, 64] },
  { name: 'Bm11', midi: [47, 54, 57, 62, 64] },
  { name: 'Gmaj9(#11)', midi: [43, 50, 57, 59, 61, 66] },
  { name: 'Em9', midi: [52, 55, 59, 62, 66] }
];
const chimeMidi = [81, 78, 85, 83];
const frequencies = new Set();

function rngFor(tag) {
  let seed = SEED;
  for (const character of tag) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  return mulberry32(seed);
}

function sine(frequency, t, phase = 0) {
  const hz = quantizeHz(frequency);
  frequencies.add(hz);
  return Math.sin(TAU * hz * t + phase);
}

function bus(length) {
  return { L: new Float64Array(length), R: new Float64Array(length), sL: new Float64Array(length), sR: new Float64Array(length) };
}

function addEvent(target, seconds, duration, pan, wet, sample) {
  const start = Math.round(seconds * SR);
  const length = Math.ceil(duration * SR);
  const [left, right] = pans(pan);
  for (let n = 0; n < length; n++) {
    const i = (start + n) % N;
    const value = sample(n / SR, n);
    target.L[i] += value * left;
    target.R[i] += value * right;
    target.sL[i] += value * left * wet;
    target.sR[i] += value * right * wet;
  }
}

function makePad(target) {
  const random = rngFor('pad');
  const voices = chords.map(chord => chord.midi.map((midi, j) => {
    const center = midiHz(midi);
    const phase = random() * TAU;
    const pan = (j % 2 ? 1 : -1) * (0.16 + random() * 0.16);
    const gains = pans(pan);
    const oscillators = [-0.25, 0, 0.25].map((detune, k) => {
      const frequency = quantizeHz(center + detune);
      frequencies.add(frequency);
      frequencies.add(frequency * 2);
      frequencies.add(frequency * 3);
      return { omega: TAU * frequency, phase: phase + k * 1.97, gain: k === 1 ? 0.46 : 0.27 };
    });
    return { oscillators, gains };
  }));
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const bar = Math.floor(t / 3);
    const position = t - bar * 3;
    let a = bar, b = bar, wa = 1, wb = 0;
    if (position < 0.5) {
      a = (bar + 3) % 4;
      b = bar;
      const angle = (position + 0.5) * Math.PI / 2;
      wa = Math.cos(angle); wb = Math.sin(angle);
    } else if (position > 2.5) {
      b = (bar + 1) % 4;
      const angle = (position - 2.5) * Math.PI / 2;
      wa = Math.cos(angle); wb = Math.sin(angle);
    }
    let left = 0, right = 0;
    for (const [chordIndex, weight] of [[a, wa], [b, wb]]) {
      if (weight === 0) continue;
      const gain = 0.19 * weight / Math.sqrt(voices[chordIndex].length);
      for (const voice of voices[chordIndex]) {
        let value = 0;
        for (const oscillator of voice.oscillators) {
          const phase = oscillator.omega * t + oscillator.phase;
          value += oscillator.gain * (Math.sin(phase) + 0.14 * Math.sin(phase * 2) + 0.035 * Math.sin(phase * 3));
        }
        left += value * voice.gains[0] * gain;
        right += value * voice.gains[1] * gain;
      }
    }
    const breath = 0.91 + 0.09 * sine(1 / 12, t, -0.7);
    target.L[i] = left * breath;
    target.R[i] = right * breath;
  }
}

function makeFootsteps(target) {
  for (let index = 0; index < footsteps.length; index++) {
    const event = footsteps[index];
    const random = rngFor(`water-${index}`);
    const gain = 0.9 + random() * 0.2;
    const pan = event.foot === 'left' ? -0.15 : 0.15;
    const phase = random() * TAU;
    const highPole = Math.exp(-TAU * 1800 / SR);
    const lowPole = Math.exp(-TAU * 3800 / SR);
    let low = 0, highLow = 0;
    const drops = [700, 648, 590, 536, 480, 428, 380].map((hz, k) => ({
      hz: quantizeHz(hz + (gain - 1) * 22), center: 0.011 + k * 0.008
    }));
    addEvent(target, event.seconds, 0.12, pan, 1.45, (t) => {
      const noise = random() * 2 - 1;
      low = lowPole * low + (1 - lowPole) * noise;
      highLow = highPole * highLow + (1 - highPole) * low;
      const touch = (low - highLow) * smooth(t / 0.012) * Math.exp(-t / 0.026) * smooth((0.12 - t) / 0.025);
      let body = 0, sum = 0;
      // Overlapping fixed-frequency grains make a downward plip without a free-running chirp.
      for (const drop of drops) {
        const weight = Math.exp(-0.5 * ((t - drop.center) / 0.0065) ** 2);
        body += sine(drop.hz, t, phase) * weight;
        sum += weight;
      }
      body = body / Math.max(sum, 0.001) * smooth(t / 0.008) * Math.exp(-t / 0.028) * smooth((0.085 - t) / 0.02);
      return gain * (0.115 * touch + 0.033 * body);
    });
  }
}

function makeChimes(target) {
  for (let index = 0; index < chimes.length; index++) {
    const event = chimes[index];
    const frequency = midiHz(chimeMidi[index]);
    const pan = clamp((event.x / 1920 * 2 - 1) * 0.6, -0.6, 0.6);
    const random = rngFor(`chime-${index}`);
    const phase = random() * TAU;
    addEvent(target, event.seconds, 8.5, pan, 2.5, t => {
      const envelope = smooth(t / 0.045) * Math.exp(-t / 1.3) * smooth((8.5 - t) / 0.5);
      const fundamental = sine(frequency, t, phase);
      const partial = sine(quantizeHz(frequency * 2.003), t, phase * 0.3) * 0.18 * Math.exp(-t / 0.55);
      return 0.021 * envelope * (fundamental + partial);
    });
  }
}

function makeContinuous(pad, events) {
  const out = bus(TOTAL);
  const seaRandomL = rngFor('sea-left'), seaRandomR = rngFor('sea-right');
  const noiseL = new Float64Array(N), noiseR = new Float64Array(N);
  for (let i = 0; i < N; i++) { noiseL[i] = seaRandomL() * 2 - 1; noiseR[i] = seaRandomR() * 2 - 1; }
  let padL1 = 0, padL2 = 0, padR1 = 0, padR2 = 0;
  let seaL = 0, seaR = 0, seaLowL = 0, seaLowR = 0;
  const seaPole = Math.exp(-TAU * 1450 / SR);
  const seaLowPole = Math.exp(-TAU * 450 / SR);
  const droneHz = midiHz(38);
  for (let i = 0; i < TOTAL; i++) {
    const j = i % N, t = j / SR;
    const cutoff = 780 + 190 * sine(1 / 12, t, 0.8) + 70 * sine(2 / 12, t, -0.3);
    const pole = Math.exp(-TAU * cutoff / SR);
    padL1 = pole * padL1 + (1 - pole) * pad.L[j];
    padL2 = pole * padL2 + (1 - pole) * padL1;
    padR1 = pole * padR1 + (1 - pole) * pad.R[j];
    padR2 = pole * padR2 + (1 - pole) * padR1;
    seaL = seaPole * seaL + (1 - seaPole) * noiseL[j];
    seaR = seaPole * seaR + (1 - seaPole) * noiseR[j];
    seaLowL = seaLowPole * seaLowL + (1 - seaLowPole) * seaL;
    seaLowR = seaLowPole * seaLowR + (1 - seaLowPole) * seaR;
    const lap = 0.55 + 0.24 * sine(3 / 12, t, 0.9) + 0.21 * sine(5 / 12, t, -1.6);
    const seaOutL = (seaL - seaLowL) * lap * 0.018;
    const seaOutR = (seaR - seaLowR) * lap * 0.018;
    const drone = 0.015 * (0.8 + 0.2 * sine(1 / 12, t, -0.9)) *
      (sine(droneHz, t, 0.45) + 0.15 * sine(droneHz * 2, t, 0.9));
    out.L[i] = padL2 + drone + seaOutL + events.L[j];
    out.R[i] = padR2 + drone + seaOutR + events.R[j];
    out.sL[i] = 0.55 * padL2 + 0.12 * drone + 0.9 * seaOutL + 0.8 * events.sL[j] + 0.2 * events.sR[j];
    out.sR[i] = 0.55 * padR2 + 0.12 * drone + 0.9 * seaOutR + 0.8 * events.sR[j] + 0.2 * events.sL[j];
  }
  return out;
}

function fft(real, imaginary, inverse = false) {
  const length = real.length;
  for (let i = 1, j = 0; i < length; i++) {
    let bit = length >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let size = 2; size <= length; size *= 2) {
    const half = size / 2;
    const angle = (inverse ? TAU : -TAU) / size;
    const stepR = Math.cos(angle), stepI = Math.sin(angle);
    for (let offset = 0; offset < length; offset += size) {
      let wr = 1, wi = 0;
      for (let j = 0; j < half; j++) {
        const a = offset + j, b = a + half;
        const br = real[b] * wr - imaginary[b] * wi;
        const bi = real[b] * wi + imaginary[b] * wr;
        real[b] = real[a] - br; imaginary[b] = imaginary[a] - bi;
        real[a] += br; imaginary[a] += bi;
        const nextR = wr * stepR - wi * stepI;
        wi = wr * stepI + wi * stepR; wr = nextR;
      }
    }
  }
  if (inverse) for (let i = 0; i < length; i++) { real[i] /= length; imaginary[i] /= length; }
}

function impulse(channel) {
  const length = Math.round(SR * 10.5);
  const out = new Float64Array(length);
  const random = rngFor(`reverb-${channel}`);
  const pole = Math.exp(-TAU * 2300 / SR);
  let low = 0, dc = 0, energy = 0;
  for (let i = 0; i < length; i++) {
    const t = i / SR;
    low = pole * low + (1 - pole) * (random() * 2 - 1);
    dc = 0.998 * dc + 0.002 * low;
    const tail = smooth((10.5 - t) / 0.5);
    const value = (low - dc) * Math.exp(-Math.log(1000) * t / 5.6) * smooth((t - 0.03) / 0.11) * tail;
    out[i] = value; energy += value * value;
  }
  const gain = 0.7 / Math.sqrt(energy);
  for (let i = 0; i < length; i++) out[i] *= gain;
  for (const [t, amplitude] of [[0.071, 0.11], [0.113, 0.075], [0.181, 0.05]]) {
    const index = Math.round((t + channel * 0.0031) * SR);
    for (let j = 0; j < 120; j++) out[index + j] += amplitude * (1 - pole) * pole ** j;
  }
  return out;
}

function convolve(input, response) {
  let length = 1;
  while (length < input.length + response.length - 1) length *= 2;
  const real = new Float64Array(length), imag = new Float64Array(length);
  const filterR = new Float64Array(length), filterI = new Float64Array(length);
  real.set(input); filterR.set(response);
  fft(real, imag); fft(filterR, filterI);
  for (let i = 0; i < length; i++) {
    const value = real[i] * filterR[i] - imag[i] * filterI[i];
    imag[i] = real[i] * filterI[i] + imag[i] * filterR[i];
    real[i] = value;
  }
  fft(real, imag, true);
  return real.subarray(0, TOTAL);
}

function integratedLoudness(left, right) {
  const filter = input => {
    const out = Float64Array.from(input);
    for (const [[b0, b1, b2], [a1, a2]] of [
      [[1.53512485958697, -2.69169618940638, 1.19839281085285], [-1.69065929318241, 0.73248077421585]],
      [[1, -2, 1], [-1.99004745483398, 0.99007225036621]]
    ]) {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < out.length; i++) {
        const x = out[i];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        out[i] = y; x2 = x1; x1 = x; y2 = y1; y1 = y;
      }
    }
    return out;
  };
  const l = filter(left), r = filter(right), energies = [];
  const block = SR * 0.4, step = SR * 0.1;
  for (let start = 0; start + block <= left.length; start += step) {
    let energy = 0;
    for (let i = start; i < start + block; i++) energy += l[i] * l[i] + r[i] * r[i];
    energies.push(energy / block);
  }
  const lk = value => -0.691 + 10 * Math.log10(value);
  const absolute = energies.filter(value => lk(value) > -70);
  const threshold = lk(absolute.reduce((sum, value) => sum + value, 0) / absolute.length) - 10;
  const gated = absolute.filter(value => lk(value) > threshold);
  return lk(gated.reduce((sum, value) => sum + value, 0) / gated.length);
}

function master(raw) {
  const L = new Float64Array(N), R = new Float64Array(N);
  const renderGain = gain => {
    for (let i = 0; i < N; i++) {
      L[i] = CEILING * Math.tanh(raw.L[N + i] * gain / CEILING);
      R[i] = CEILING * Math.tanh(raw.R[N + i] * gain / CEILING);
    }
    return integratedLoudness(L, R);
  };
  let low = 0.01, high = 30;
  for (let iteration = 0; iteration < 17; iteration++) {
    const midpoint = (low + high) / 2;
    if (renderGain(midpoint) < TARGET) low = midpoint; else high = midpoint;
  }
  const gain = (low + high) / 2;
  const lufs = renderGain(gain);
  let maximumDifference = 0, maximumOutputDifference = 0;
  const perChannel = {};
  for (const channel of ['L', 'R']) {
    let difference = 0, outputDifference = 0;
    for (let i = 0; i < N; i++) {
      const a = raw[channel][N + i], b = raw[channel][N * 2 + i];
      difference = Math.max(difference, Math.abs(a - b));
      outputDifference = Math.max(outputDifference, Math.abs(CEILING * Math.tanh(a * gain / CEILING) - CEILING * Math.tanh(b * gain / CEILING)));
    }
    perChannel[channel] = { rawMaxAbsDifference: difference, masteredMaxAbsDifference: outputDifference };
    maximumDifference = Math.max(maximumDifference, difference);
    maximumOutputDifference = Math.max(maximumOutputDifference, outputDifference);
  }
  return { L, R, gain, internalLufs: lufs, periodicity: { rawMaxAbsDifference: maximumDifference, masteredMaxAbsDifference: maximumOutputDifference, perChannel } };
}

function writeWav(file, left, right, repeats = 1) {
  const length = left.length * repeats;
  const data = Buffer.alloc(length * 6);
  for (let i = 0; i < length; i++) {
    const j = i % left.length;
    data.writeIntLE(clamp(Math.round(left[j] * 8388607), -8388608, 8388607), i * 6, 3);
    data.writeIntLE(clamp(Math.round(right[j] * 8388607), -8388608, 8388607), i * 6 + 3, 3);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22); header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 6, 28);
  header.writeUInt16LE(6, 32); header.writeUInt16LE(24, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

function ffmpeg(args) {
  const result = spawnSync(FFMPEG, ['-hide_banner', ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stderr;
}

function measure(file) {
  const text = ffmpeg(['-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  fs.writeFileSync(path.join(OUT, 'ebur128.txt'), text);
  const summary = text.slice(text.lastIndexOf('Summary:'));
  const integratedLufs = Number(summary.match(/I:\s+(-?[\d.]+)\s+LUFS/)[1]);
  const truePeakDbtp = Number(summary.match(/Peak:\s+(-?[\d.]+)\s+dBFS/)[1]);
  return { integratedLufs, truePeakDbtp, method: 'ffmpeg ebur128=peak=true on the 36-second x3 PCM file' };
}

function seamReport(left, right) {
  const report = {};
  for (const [channel, input] of [['L', left], ['R', right]]) {
    const samples = Float64Array.from(input, sample => Math.round(sample * 8388607) / 8388607);
    const steps = new Float64Array(N - 1);
    for (let i = 1; i < N; i++) steps[i - 1] = Math.abs(samples[i] - samples[i - 1]);
    steps.sort();
    const step = Math.abs(samples[0] - samples[N - 1]);
    const percentile = steps[Math.ceil(0.999 * steps.length) - 1];
    report[channel] = { seamStep: step, interiorStepPercentile99_9: percentile, ratio: step / percentile };
  }
  return report;
}

function writeEvents() {
  const rows = [];
  footsteps.forEach(event => rows.push({
    seconds: event.seconds, type: `Footstep (${event.foot})`, detail: 'Seeded water plip, 120 ms touch / 85 ms body',
    pan: event.foot === 'left' ? -0.15 : 0.15
  }));
  chords.forEach((chord, index) => rows.push({
    seconds: index * 3, type: 'Chord', detail: `${chord.name}: ${chord.midi.map(noteName).join(' ')}`, pan: 'wide'
  }));
  chimes.forEach((event, index) => rows.push({
    seconds: event.seconds, type: 'Star chime', detail: `${noteName(chimeMidi[index])}, star x=${event.x}`,
    pan: clamp((event.x / 1920 * 2 - 1) * 0.6, -0.6, 0.6).toFixed(6)
  }));
  rows.sort((a, b) => a.seconds - b.seconds || a.type.localeCompare(b.type));
  const text = [
    '# Events used', '',
    '48 kHz stereo, 12 seconds, 80 BPM, four 4/4 bars. Footsteps and star chimes are read from src/events.js.',
    'Pad changes use one-second equal-power crossfades centered on the listed times. The 0 s crossfade runs from 11.5 s through 0.5 s.',
    'D2 pedal and very quiet sea noise run continuously. Every oscillator and LFO is an integer multiple of 1/12 Hz.',
    'Negative pan is left; positive pan is right. Star pan = 0.6 × (2x/1920 − 1).', '',
    '| Time (s) | Event | Notes / detail | Pan |', '|---:|---|---|---:|',
    ...rows.map(row => `| ${row.seconds.toFixed(3)} | ${row.type} | ${row.detail} | ${row.pan} |`), ''
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'events-used.md'), text);
}

function reviewImages(file) {
  const guides = [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33].map(t => {
    const seam = t === 12 || t === 24;
    return `drawbox=x=${Math.round(t / 36 * 1920)}:y=0:w=${seam ? 2 : 1}:h=ih:color=${seam ? '0xf0c980@0.9' : 'white@0.12'}:t=fill`;
  }).join(',');
  ffmpeg(['-y', '-i', file, '-lavfi',
    `showspectrumpic=s=1920x760:legend=disabled:scale=log:fscale=log:color=nebulae:gain=3:drange=100:stop=10000,${guides}`,
    '-frames:v', '1', path.join(OUT, 'spectrogram.png')]);
  ffmpeg(['-y', '-i', file, '-lavfi',
    `showwavespic=s=1920x600:split_channels=1:colors=0xc5d9ee|0x84cfc6:scale=sqrt:filter=peak,${guides}`,
    '-frames:v', '1', path.join(OUT, 'waveform.png')]);
}

function main() {
  if (timeline.TIMING.frames / timeline.TIMING.fps !== SECONDS) throw new Error('Expected a 12-second timeline.');
  if (footsteps.length !== 16 || footsteps.some((event, i) => event.seconds !== i * 0.75)) throw new Error('Unexpected footstep schedule.');
  if (chimes.length !== 4 || chimes.some((event, i) => event.seconds !== 1.5 + i * 3 || !Number.isFinite(event.x))) {
    throw new Error('Expected four star chime events, each with seconds and x, in src/events.js.');
  }
  fs.mkdirSync(OUT, { recursive: true });
  const wav = path.join(OUT, 'night-loop.wav'), x3 = path.join(OUT, 'night-loop-x3.wav');
  const previousFileHash = fs.existsSync(wav) ? crypto.createHash('sha256').update(fs.readFileSync(wav)).digest('hex') : null;
  console.log('Rendering periodic pad, water footsteps, drone, sea and shared star chimes.');
  const pad = bus(N), events = bus(N);
  makePad(pad); makeFootsteps(events); makeChimes(events);
  const raw = makeContinuous(pad, events);
  console.log('Convolving three consecutive loops with 10.5-second dark stereo impulses (RT60 5.6 s).');
  for (const [channel, send, index] of [['L', 'sL', 0], ['R', 'sR', 1]]) {
    const wet = convolve(raw[send], impulse(index));
    for (let i = 0; i < TOTAL; i++) raw[channel][i] += wet[i];
  }
  const result = master(raw);
  writeWav(wav, result.L, result.R);
  writeWav(x3, result.L, result.R, 3);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(wav)).digest('hex');
  const loudness = measure(x3);
  writeEvents(); reviewImages(x3);
  const report = {
    format: { sampleRate: SR, channels: 2, bitsPerSample: 24, pcmFrames: N, seconds: SECONDS, x3Frames: TOTAL },
    seed: SEED,
    determinism: {
      algorithm: 'SHA-256', currentRunSha256: hash, previousSeparateRunSha256: previousFileHash,
      twoSeparateRunsByteIdentical: previousFileHash === hash
    },
    loudness,
    periodicity: {
      description: 'Compare loop 2 against loop 3 of the independently filtered and FFT-convolved 36-second render, before extracting the middle loop.',
      ...result.periodicity,
      reverbImpulseSeconds: 10.5, reverbRt60Seconds: 5.6, tolerance: 1e-9
    },
    seam: seamReport(result.L, result.R),
    master: { type: 'Static gain into memoryless tanh, no compressor or limiter', gain: result.gain, ceiling: CEILING, internalLufs: result.internalLufs },
    pitch: {
      gridHz: 1 / 12,
      allFrequenciesOnGrid: [...frequencies].every(hz => Math.abs(hz * 12 - Math.round(hz * 12)) < 1e-8),
      frequenciesHz: [...frequencies].sort((a, b) => a - b),
      chordVoicings: chords.map(chord => ({ name: chord.name, notes: chord.midi.map(noteName), frequenciesHz: chord.midi.map(midiHz) })),
      chimes: chimes.map((event, i) => ({ seconds: event.seconds, x: event.x, pan: clamp((event.x / 1920 * 2 - 1) * 0.6, -0.6, 0.6), note: noteName(chimeMidi[i]), frequencyHz: midiHz(chimeMidi[i]) }))
    },
    reviewImages: { width: 1920, durationSeconds: 36, goldSeamLinesSeconds: [12, 24], faintChordLinesEverySeconds: 3 }
  };
  fs.writeFileSync(path.join(OUT, 'audio-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ hash, previousFileHash, loudness, periodicity: result.periodicity, seam: report.seam }, null, 2));
  if (Math.abs(loudness.integratedLufs - TARGET) > 0.3 || loudness.truePeakDbtp > -1) throw new Error('Audio failed loudness or true-peak acceptance.');
  if (result.periodicity.masteredMaxAbsDifference > 1e-9) throw new Error('Audio failed periodicity acceptance.');
  if (!report.pitch.allFrequenciesOnGrid) throw new Error('An oscillator frequency is off the periodic pitch grid.');
  if (Object.values(report.seam).some(channel => channel.ratio > 1)) throw new Error('Seam step exceeds the interior 99.9th-percentile step.');
}

main();
