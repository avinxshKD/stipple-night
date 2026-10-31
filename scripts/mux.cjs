'use strict';
// Muxes the picture master with the soundtrack into the delivery files and verifies them:
// a 12 s loop and a 36 s three-loop cut whose video is the same bitstream three times over.
// Usage: node scripts/mux.cjs [master.mp4] [--audio=dir] [--out=dir] [--tag=name]
//   master   defaults to output/render/night-loop-master-crf16.mp4 (from render-loop.cjs)
//   --audio  folder holding night-loop.wav and night-loop-x3.wav, default output/audio (from audio.cjs)
//   --out    defaults to output/final
//   --tag    suffix used when a target file is locked by a player, default "new"
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { out, root } = require('./browser.cjs');
const { FFMPEG, FFPROBE, ffmpeg, sha256, fileHash } = require('./media.cjs');

// SHA-256 of the night-loop.wav the documented hashes were taken from; recorded in the report, not enforced.
const EXPECTED_WAV_SHA = '56f1a1ba3cfd9229f232c73547467ca732269dbfd4e78e310a1afe51e3259ca7';
// Paths in the report are relative to the repo, or just the file name for files outside it,
// so a report never records where the repo lives on a machine.
const shown = file => {
  const rel = path.relative(root, file);
  return rel.startsWith('..') || path.isAbsolute(rel) ? path.basename(file) : rel;
};
const RATE = 48000, LOOP_SAMPLES = 576000, LOOP_FRAMES = 288, AAC_FRAME = 1024 / RATE;
const AAC = ['-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '320k', '-ar', String(RATE), '-ac', '2'];

function capture(exe, args) {
  const r = spawnSync(exe, args, { maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(exe)} failed: ${args.join(' ')}\n${r.stderr}`);
  return r;
}

function probe(file) {
  const r = capture(FFPROBE, ['-v', 'error', '-show_entries',
    'format=duration,bit_rate,size:stream=index,codec_type,codec_name,profile,pix_fmt,width,height,r_frame_rate,' +
    'color_space,color_primaries,color_transfer,color_range,sample_rate,channels,channel_layout,duration,bit_rate,nb_frames',
    '-of', 'json', file]);
  const j = JSON.parse(r.stdout.toString());
  const streams = Object.fromEntries(j.streams.map(s => [s.codec_type, Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'index'))]));
  const video = Number(streams.video.duration), audio = Number(streams.audio.duration);
  return {
    bytes: Number(j.format.size), seconds: Number(j.format.duration), kbps: Math.round(Number(j.format.bit_rate) / 1000),
    video: streams.video, audio: streams.audio,
    durationGapMs: Number((Math.abs(video - audio) * 1000).toFixed(2)),
    withinOneAacFrame: Math.abs(video - audio) < AAC_FRAME
  };
}

// Hash of a decoded frame's raw YUV, so the comparison involves no colour conversion.
function frameHash(file, n) {
  const r = capture(FFMPEG, ['-hide_banner', '-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1',
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
  return sha256(r.stdout);
}

function loudness(file) {
  const r = capture(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-map', '0:a', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const text = r.stderr.toString(), summary = text.slice(text.lastIndexOf('Summary:'));
  const num = re => { const m = re.exec(summary); return m ? Number(m[1]) : null; };
  return { integratedLUFS: num(/I:\s+(-?[0-9.]+) LUFS/), loudnessRangeLU: num(/LRA:\s+(-?[0-9.]+) LU/), truePeakDBTP: num(/Peak:\s+(-?[0-9.]+) dBFS/) };
}

// Largest sample-to-sample step near each seam against the interior's 99.9th percentile.
function seams(file, at) {
  const pcm = capture(FFMPEG, ['-hide_banner', '-v', 'error', '-i', file, '-map', '0:a', '-f', 'f32le', '-ac', '2', '-ar', String(RATE), '-']).stdout;
  const x = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4), frames = x.length / 2;
  const step = (i, c) => Math.abs(x[2 * i + c] - x[2 * (i - 1) + c]);
  const guard = 64, near = i => at.some(s => Math.abs(i - s) <= guard);
  const interior = [];
  for (let i = 1; i < frames; i++) if (!near(i)) interior.push(Math.max(step(i, 0), step(i, 1)));
  interior.sort((a, b) => a - b);
  const p999 = interior[Math.floor(interior.length * 0.999)];
  const result = at.map(s => {
    let m = 0;
    for (let i = Math.max(1, s - guard); i <= Math.min(frames - 1, s + guard); i++) m = Math.max(m, step(i, 0), step(i, 1));
    return { sample: s, seconds: s / RATE, maxStep: Number(m.toFixed(6)), belowInteriorP999: m <= p999 };
  });
  return { decodedSamples: frames, interiorP999: Number(p999.toFixed(6)), seams: result };
}

function main() {
  const args = process.argv.slice(2);
  const option = (key, fallbackValue) => {
    const hit = args.find(a => a.startsWith(`--${key}=`));
    return hit ? hit.slice(key.length + 3) : fallbackValue;
  };
  const master = path.resolve(args.find(a => !a.startsWith('--')) || path.join(out, 'render', 'night-loop-master-crf16.mp4'));
  const audio = path.resolve(option('audio', path.join(out, 'audio')));
  const dir = path.resolve(option('out', path.join(out, 'final')));
  const fallback = option('tag', 'new');
  const loopWav = path.join(audio, 'night-loop.wav'), x3Wav = path.join(audio, 'night-loop-x3.wav');
  for (const f of [master, loopWav, x3Wav]) if (!fs.existsSync(f)) throw new Error(`Missing input: ${f}`);
  fs.mkdirSync(dir, { recursive: true });
  const work = dir;

  // Muxes into a scratch file, then copies it into place. A player can hold the delivery file open
  // (Windows locks it), so a failed copy falls back to a suffixed name instead of losing the mux.
  const place = (temp, name) => {
    const target = path.join(dir, `${name}.mp4`);
    try { fs.copyFileSync(temp, target); }
    catch (e) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      const alt = path.join(dir, `${name}-${fallback}.mp4`);
      console.error(`${path.basename(target)} is locked (${e.code}); wrote ${path.basename(alt)} instead.`);
      fs.copyFileSync(temp, alt);
      return alt;
    }
    return target;
  };
  const singleTemp = path.join(work, 'mux-12s.partial.mp4'), tripleTemp = path.join(work, 'mux-x3.partial.mp4');
  ffmpeg(['-i', master, '-i', loopWav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...AAC, '-movflags', '+faststart', singleTemp]);
  const list = path.join(work, 'concat-x3.partial.txt');
  const entry = `file '${master.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
  fs.writeFileSync(list, [entry, entry, entry].join('\n') + '\n');
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-i', x3Wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...AAC,
    '-movflags', '+faststart', tripleTemp]);
  const single = place(singleTemp, 'stipple-night-12s'), triple = place(tripleTemp, 'stipple-night-x3');
  for (const f of [singleTemp, tripleTemp, list]) fs.rmSync(f);

  const report = {
    master: shown(master),
    masterSha256: fileHash(master),
    audioSha256: fileHash(loopWav),
    audioMatchesExpected: fileHash(loopWav) === EXPECTED_WAV_SHA,
    single: { file: shown(single), ...probe(single), loudness: loudness(single) },
    triple: { file: shown(triple), ...probe(triple), loudness: loudness(triple) }
  };
  report.triple.audio.seams = seams(triple, [LOOP_SAMPLES, 2 * LOOP_SAMPLES]);
  const frames = [0, LOOP_FRAMES, 2 * LOOP_FRAMES].map(n => ({ n, sha: frameHash(triple, n) }));
  report.triple.loopFrames = { frames, identical: frames.every(f => f.sha === frames[0].sha), masterFrame0: frameHash(master, 0) };
  report.triple.loopFrames.matchesMaster = report.triple.loopFrames.masterFrame0 === frames[0].sha;
  fs.writeFileSync(path.join(dir, 'final-report.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
  const passed = report.single.withinOneAacFrame && report.triple.withinOneAacFrame && report.triple.loopFrames.identical &&
    report.triple.loopFrames.matchesMaster && report.triple.audio.seams.seams.every(s => s.belowInteriorP999);
  if (!passed) { console.error('Mux checks failed.'); process.exitCode = 1; }
}
main();
