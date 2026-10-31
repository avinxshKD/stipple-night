# How it works

Design notes for stipple-night. Numbers come from the reports the scripts write
(`frame-hashes.json`, `final-report.json`, `audio-report.json`, `output/boil-test/metrics.json`)
or from constants in the source, named where they are used.

## Timeline

`src/events.js` holds the timing for picture and sound:

| Constant | Value | Meaning |
|---|---|---|
| `fps` | 24 | frame rate |
| `frames` | 288 | 12 seconds |
| `drawings` | 144 | animation on twos: drawing `d = floor(frame / 2)` |
| `stepDrawings` | 9 | one footstep every 9 drawings (0.75 s) |
| `strideDrawings` | 18 | one full left-right stride (1.5 s), 8 strides per loop |

Everything that animates has a period that divides 144 drawings: the stride (18), the boil
cycle (3), glint twinkle (6, 8, 12, 24), star twinkle (9, 12, 16, 18, 24, 36, 48) and the water
tile (144). The drawing index is taken modulo 144, so `frame(288)` is the same call as
`frame(0)`.

Footsteps land at drawings 0, 9, 18, ..., 135, alternating left and right. Star chimes are at
drawings 18, 54, 90 and 126. Each event carries `drawing`, `frame` and `seconds`, and each chime
also carries the index and screen x of the star it belongs to.

## Determinism

There is no `Math.random` and no clock anywhere in the render path. `src/rng.js` provides
mulberry32 and a small seed mixer, and every generator takes a fixed seed. Fields are generated
once and cached; per-drawing state is derived only from the drawing index. At the start of
each frame the transform, alpha, compositing mode and filter are reset and the canvas is filled
with black, so a frame does not depend on what was drawn before it.

## The dot field

`NightStipple.generateField` places dots on a jittered hex lattice. The lattice pitch is 0.8 of
the dot diameter, positions are jittered by up to 30% of the pitch, and each dot's size varies
by +/-25%. A `sample(x, y)` callback decides whether a lattice cell is inside the shape, its
acceptance density, and the color weights at that point. Each lattice cell draws the same
number of random values whether or not its dot is kept, so changing the density in one region
does not move dots anywhere else.

The base dot diameter is 8.5 px. On the water, dashes scale with depth from 0.5x at the horizon
to 1.5x at the bottom of the frame.

Dots are batched per color into one `Path2D` and filled once per color, which keeps a frame of
about 12,800 dots fast to draw.

## The boil

A hand-drawn boil means the texture changes slightly on every drawing. The first version
re-scattered every dot on every drawing. That looks right but is close to noise for a video
encoder.

The current boil is coherent: each dot has three fixed variants (a small offset, a radius
scale, and occasionally an alternate color) and drawing `d` uses variant `d mod 3`. The dots
stay in place and shimmer.

`npm run boil-test` renders a 48-frame clip of the texture test layout both ways and encodes
each at three rates. From `metrics.json`:

| Encode | Re-scatter kbps | Re-scatter SSIM | Coherent kbps | Coherent SSIM |
|---|---:|---:|---:|---:|
| CRF 16 master | 41,218 | 0.969 | 13,709 | 0.967 |
| 5 Mbps target | 5,017 | 0.814 | 3,220 | 0.902 |
| 2.5 Mbps target | 2,357 | 0.630 | 1,866 | 0.849 |

SSIM is measured on frame 24 against the lossless PNG. At the same visual quality the coherent
boil needs about a third of the bitrate, and at a fixed delivery rate it holds up far better.

## The water treadmill

The water is drawn in log-depth `u`: `q = exp(-u)` runs from 1 at the bottom of the frame to 0
at the horizon, and screen `y = horizon + (1080 - horizon) * q`. Motion at a constant rate in
`u` is self-similar, so dashes move toward the viewer, spread apart and grow the way they would
on a receding plane.

The water moves 0.0181 units of `u` per drawing (`WATER_SPEED` in `src/scene.js`). One loop
moves it 0.0181 x 144 = 2.6064 units, and the dash pattern is generated as exactly one tile of
that length, repeated along `u`. After 144 drawings the pattern has moved one tile and lines up
with itself.

The figure walks in place. During stance (11 of 18 drawings per foot) the planted foot is
moved down the screen by the same log-depth flow as the water under it:
`y(t) = depth * (exp(k * (t - 1)) - 1)` with `k = 0.0181 * 11`. At the figure's feet line this
is about 32 px of travel per stance, so the foot and the ripple it starts move together instead
of the foot sliding over the water. The water speed was chosen first; the gait is fitted to it.

The rest of the walk: the swinging foot lifts up to 22 local units and travels back up the
screen, hips sway 6.5 units toward the planted foot, shoulders counter-sway 2, and the body bobs
3.6 units, lowest at each contact. The leg whose foot is lower on screen is nearer the viewer
and is drawn over the other one.

The figure is a single white contour. It is drawn on an offscreen canvas by stroking every part
at double width and erasing the interiors, which leaves the outer half of the stroke as the
outline of the union. A soft dark shadow behind it keeps it readable over bright glitter. The
water reflection is the same art flipped, squashed to 0.42, sliced into short dashes and added
at alpha 0.7.

## Ripples

Each footstep starts two concentric rings (the inner one at 0.58 of the outer radius). A ring
is not an outline. It is a disturbance of the existing dots:

- a trough: glitter and ripple dashes that overlap a thin elliptical band just inside the ring
  are removed, so the ring reads as a dark line;
- a crest: dashes in a band just outside it are drawn larger in a brighter cream, and 64 extra
  crest dashes at fixed angles fill in where the water is sparse.

Rings have a 4:1 aspect to match the water's perspective at the feet. The outer ring grows from
8 px to 150 px long radius over 18 drawings, fading as it goes, and its center drifts toward
the viewer with the flow. A ring's age is taken modulo 144, so steps near the end of the loop
are still rippling at its start.

## The moon

The moon is a stipple field over a warm underlayer. The seas (maria) come from a low-frequency
mask: 12 elliptical Gaussian blobs, combined as `1 - product(1 - blob)` so overlapping blobs
merge smoothly, with a slow sine warp on the coordinates so the edges are irregular. The blobs
follow the near side of the real moon: Imbrium and Procellarum on the left, Serenitatis and
Tranquillitatis right of center, Crisium alone on the right limb, two small central patches,
Nubium, Fecunditatis, and a mostly bright lower third.

Inside the mask about half the dots are lavender-grey; outside it the disc is almost all
cream. The underlayer is computed once per pixel from the same mask, so the color in the gaps
between dots follows the seas exactly. It is near the dot color at the center, deepens toward
the limb and is tinted under the seas.

## One event list for picture and sound

`src/events.js` runs in the browser and in Node. In the page it sets `window.NightEvents`; in
Node it is loaded with `require` or evaluated in a `vm` sandbox.

- The scene uses footsteps for ripple rings and the figure's contact points, and chimes to
  flare the named star (up over 2 drawings, down over 6). When the night layout is first built,
  the scene checks that each chime names a bright star that exists and that its x matches.
- `scripts/audio.cjs` places a water plip at each footstep and a chime at each chime event,
  panned by the star's screen x.

Because both read the same list, a change of timing moves picture and sound together.

## Audio

The soundtrack is synthesized sample by sample in Node at 48 kHz and written as 24-bit stereo
WAV. All randomness uses mulberry32 with seed `0x61C8A93D`.

- **Harmony.** Four bars at 80 BPM, one chord per 3 seconds: Dmaj9, Bm11, Gmaj9(#11), Em9.
  Each voice is three slightly detuned oscillators with weak 2nd and 3rd harmonics, through a
  slowly moving low-pass filter. Chords change with one-second equal-power crossfades. A quiet
  D2 drone and filtered sea noise run underneath.
- **Footsteps.** Each plip is a short burst of band-limited noise for the touch plus seven
  overlapping fixed-frequency grains from 700 Hz down to 380 Hz, which gives a falling pitch
  without a free-running chirp. Left and right steps are panned -0.15 and +0.15.
- **Chimes.** A5, F#5, C#6 and B5 sine tones with a 45 ms attack and an `exp(-t / 1.3)` decay,
  plus a faint partial at about 2.003x the fundamental that decays over 0.55 s. Each chime is
  rendered over an 8.5-second window so its tail is not cut short. Chimes are panned by
  `0.6 * (2x / 1920 - 1)` from the star's x.
- **Pitch grid.** Every oscillator and LFO frequency is rounded to a multiple of 1/12 Hz. A sine
  at `k/12` Hz completes a whole number of cycles in 12 seconds, so sample 576,000 continues
  sample 0 exactly. `audio-report.json` lists every frequency used and confirms they are all on
  the grid.
- **Reverb.** Two 10.5-second stereo impulses (RT60 5.6 s) are convolved by FFT over three
  consecutive copies of the loop, and the middle copy is kept. By then the tail of the previous
  loop is already ringing into it, so the reverb wraps around the seam. Loop 2 and loop 3 of the
  convolved signal differ by at most 7.8e-12.
- **Master.** A static gain into a memoryless `tanh` with a ceiling of 0.86, and no compressor
  or limiter, so nothing time-varying can break the periodicity. The gain (2.2508) is found by
  bisection against a BS.1770 integrated loudness meter to reach -14 LUFS. ffmpeg's `ebur128`
  on the three-loop file reads -14.0 LUFS and a true peak of -3.6 dBTP.
- **Seam.** The step from the last sample to the first is 0.0039 (left) and 0.00004 (right),
  against a 99.9th-percentile interior step of about 0.044.

Two separate runs of `npm run audio` produce byte-identical WAV files
(SHA-256 `56f1a1ba...59ca7`).

## Encoding

`scripts/media.cjs` converts the full-range sRGB PNGs to BT.709 limited-range yuv420p and
encodes H.264 High with libx264, GOP 48:

- master: CRF 16, preset slow;
- delivery copy: two-pass at 5 Mbps, maxrate 6 Mbps, buffer 10 Mbps.

For the original render (`frame-hashes.json`), the master is 8,571 kbps with SSIM 0.971 and
PSNR 37.0 dB against the PNG frames; the 5 Mbps copy is 4,701 kbps with SSIM 0.951 and PSNR
34.4 dB. Metrics are measured in RGB after decoding with the same BT.709 matrix used to encode.

One gotcha: with only the encoder's `-color_primaries` and `-color_trc` options, the files came
out with primaries and transfer marked "unknown". The frames leaving the `scale` filter carry
unspecified color properties, and those override the encoder options. Adding
`setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv` to the filter chain
stamps the frames themselves, and all four tags then come out as BT.709 / tv.

## The 12 s and 36 s files

`scripts/mux.cjs` builds two files from the master:

- `stipple-night-12s.mp4`: the master video stream copied without re-encoding, plus the WAV as
  AAC-LC at 48 kHz stereo, 320 kbps target.
- `stipple-night-x3.mp4`: the master stream copied three times with the concat demuxer, so
  frames 0, 288 and 576 come from the same bitstream, plus `night-loop-x3.wav` encoded as one
  continuous AAC stream. The joins at 12 s and 24 s fall inside continuous PCM rather than
  between separately encoded AAC segments, which would each add encoder priming at the seam.

For the original files (`final-report.json`): video 8,571 kbps, audio 324 kbps, both streams
exactly 12.000 s and 36.000 s, -14.0 LUFS integrated and -3.6 dBTP true peak in both. In the
decoded 36 s audio the largest sample step within 64 samples of each join is 0.0181 at 12 s and
0.0160 at 24 s, against an interior 99.9th percentile of 0.0476.

## Verification

`npm run still`
- renders the frame in two separate browser launches and requires identical PNGs.

`npm run render`
- frame 288 equals frame 0 and frame 287 does not;
- both frames of every drawing are identical (144 of 144), and all 144 drawings differ;
- the files on disk match the hashes taken at render time;
- 24 frames, including 0, 1, 143, 144, 287 and 288, rendered again in a fresh browser launch,
  match;
- encodes are probed for frame count and bitrate and compared against the PNGs.

`npm run audio`
- integrated loudness within 0.3 LU of -14 LUFS and true peak below -1 dBTP;
- loop 2 and loop 3 of the convolved render differ by less than 1e-9;
- every frequency on the 1/12 Hz grid;
- the seam step no larger than the interior 99.9th-percentile step.

`npm run mux`
- audio and video durations within one AAC frame in both files;
- decoded frames 0, 288 and 576 of the 36 s file identical, and equal to master frame 0
  (compared as raw YUV, so no color conversion is involved);
- seam steps in the decoded 36 s audio below the interior 99.9th percentile;
- codec, profile, pixel format, color tags, durations, bitrates and loudness recorded in
  `final-report.json`.

Each script exits non-zero if its checks fail.
