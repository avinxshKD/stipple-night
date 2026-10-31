'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { root } = require('./browser.cjs');

// A copy unpacked into tools/ffmpeg/bin wins; otherwise ffmpeg and ffprobe come from PATH.
function tool(name) {
  const local = path.join(root, 'tools', 'ffmpeg', 'bin', process.platform === 'win32' ? `${name}.exe` : name);
  return fs.existsSync(local) ? local : name;
}
const FFMPEG = tool('ffmpeg'), FFPROBE = tool('ffprobe');
// PNG frames are full-range sRGB; tagging and converting explicitly as BT.709 limited range keeps
// encode and decode symmetric, so the metrics measure compression rather than a matrix mismatch.
// setparams stamps the frames themselves: frame properties left unknown by the filter chain
// override the encoder's -color_primaries/-color_trc options, leaving those tags unset.
const TO_YUV = 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,' +
  'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';
const FROM_YUV = 'scale=in_color_matrix=bt709:in_range=tv,format=rgb24';
const TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

function run(exe, args) {
  const r = spawnSync(exe, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(exe)} failed: ${args.join(' ')}\n${r.stderr}`);
  return r;
}
const ffmpeg = args => run(FFMPEG, ['-hide_banner', '-y', ...args]);

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const fileHash = file => sha256(fs.readFileSync(file));

// Bitrate targets use two passes; single-pass ABR overshoots badly on a 2-second clip.
function encode(pattern, out, mode) {
  const base = ['-framerate', '24', '-i', pattern, '-vf', TO_YUV, '-c:v', 'libx264', '-profile:v', 'high', '-g', '48', ...TAGS, '-an'];
  if (mode.crf != null) {
    ffmpeg([...base, '-preset', 'slow', '-crf', String(mode.crf), '-movflags', '+faststart', out]);
    return;
  }
  const logDir = path.join(root, 'output', 'work');
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, 'x264-' + path.basename(out, '.mp4'));
  const rate = ['-preset', 'medium', '-b:v', mode.bitrate, '-maxrate', mode.maxrate, '-bufsize', mode.buffer, '-passlogfile', log];
  ffmpeg([...base, ...rate, '-pass', '1', '-f', 'null', '-']);
  ffmpeg([...base, ...rate, '-pass', '2', '-movflags', '+faststart', out]);
  for (const f of fs.readdirSync(path.dirname(log))) {
    if (f.startsWith(path.basename(log)) && /\.log/.test(f)) fs.rmSync(path.join(path.dirname(log), f));
  }
}

function probe(file) {
  const r = run(FFPROBE, ['-v', 'error', '-show_entries', 'format=size,duration,bit_rate:stream=bit_rate,nb_frames',
    '-select_streams', 'v:0', '-of', 'json', file]);
  const j = JSON.parse(r.stdout), s = j.streams[0];
  return {
    bytes: Number(j.format.size), seconds: Number(j.format.duration),
    kbps: Math.round(Number(s.bit_rate || j.format.bit_rate) / 1000), frames: Number(s.nb_frames)
  };
}

// Decodes one frame of a video to RGB PNG, optionally cropped, at native resolution.
function decodeFrame(video, frame, out, crop) {
  const filters = [`select=eq(n\\,${frame})`, FROM_YUV];
  if (crop) filters.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
  ffmpeg(['-i', video, '-vf', filters.join(','), '-frames:v', '1', '-fps_mode', 'passthrough', out]);
}

function cropPng(input, out, crop) {
  ffmpeg(['-i', input, '-vf', `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`, '-frames:v', '1', out]);
}

// SSIM and PSNR of a decoded video (or PNG) against lossless frames, measured in RGB.
function compare(distorted, source, { video = false, sourceIsSequence = false } = {}) {
  const inputs = ['-i', distorted, ...(sourceIsSequence ? ['-framerate', '24'] : []), '-i', source];
  const a = video ? FROM_YUV + ',format=gbrp' : 'format=gbrp';
  const metric = name => {
    const r = ffmpeg([...inputs, '-filter_complex', `[0:v]${a}[a];[1:v]format=gbrp[b];[a][b]${name}`, '-f', 'null', '-']);
    return r.stderr;
  };
  const ssim = /All:([0-9.]+)/.exec(metric('ssim'));
  const psnr = /average:([0-9.inf]+)/.exec(metric('psnr'));
  return { ssim: ssim ? Number(ssim[1]) : null, psnr: psnr ? (psnr[1] === 'inf' ? Infinity : Number(psnr[1])) : null };
}

module.exports = { FFMPEG, FFPROBE, ffmpeg, sha256, fileHash, encode, probe, decodeFrame, cropPng, compare };
