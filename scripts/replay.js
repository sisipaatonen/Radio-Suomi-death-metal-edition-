'use strict';

// Offline detector harness. Feeds a captured clip through the SAME Detector the
// server uses and prints the per-window timeline + state transitions, plus the
// absolute sub-bass distribution split by the detector's own state (for gating
// calibration). Accepts WAV (32 kHz mono s16le) or raw .pcm.
//
//   node scripts/replay.js <clip.wav|.pcm> ['{"subBassFloor":0.5,...}']
//
// The optional 2nd arg is a JSON of Detector opts so you can A/B a tuning change
// against a clip without editing code.

const fs = require('fs');
const { Detector } = require('../server/detector');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/replay.js <clip.wav|.pcm> [optsJSON]');
  process.exit(1);
}
const opts = process.argv[3] ? JSON.parse(process.argv[3]) : {};

let buf = fs.readFileSync(file);
// Strip a RIFF/WAVE header if present -> raw s16le PCM.
if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      buf = buf.subarray(off + 8, off + 8 + sz);
      break;
    }
    off += 8 + sz + (sz & 1);
  }
}

const det = new Detector(opts);
const rows = [];
let win = 0;
det.on('analysis', (a) => {
  win++;
  rows.push({
    t: +(win * 0.992).toFixed(1),
    state: a.state,
    raw: a.rawState,
    prob: a.musicProb,
    smooth: a.smoothProb,
    sub: a.metrics.subBass,
    subAbs: a.metrics.subBassAbs,
    level: a.metrics.level,
    lster: a.metrics.lster,
  });
});

// Feed in ~0.25 s chunks to emulate streamed delivery (64 KB/s => 16 KB/chunk).
const CHUNK = 16000;
for (let i = 0; i < buf.length; i += CHUNK) det.push(buf.subarray(i, i + CHUNK));

const fmt = (x) => (typeof x === 'number' ? x.toFixed(typeof x === 'number' && Math.abs(x) < 1 ? 3 : 2) : x);
console.log('t\tstate\traw\tprob\tsmooth\tsub\tsubAbs\tlevel\tlster');
for (const r of rows) {
  console.log([r.t, r.state, r.raw, r.prob, r.smooth, r.sub, fmt(r.subAbs), r.level, r.lster].join('\t'));
}

console.log('\n# transitions:');
let prev = 'speech';
for (const r of rows) {
  if (r.state !== prev) {
    console.log(`  ${r.t}s  ${prev} -> ${r.state}`);
    prev = r.state;
  }
}

const pct = (arr, p) => (arr.length ? arr[Math.floor(p * (arr.length - 1))] : null);
const music = rows.filter((r) => r.state === 'music').map((r) => r.subAbs).sort((a, b) => a - b);
const speech = rows.filter((r) => r.state === 'speech').map((r) => r.subAbs).sort((a, b) => a - b);
console.log('\n# subBassAbs by current-detector state (for gate floor calibration):');
console.log(`  music  n=${music.length} p10=${fmt(pct(music, 0.1))} p50=${fmt(pct(music, 0.5))} p90=${fmt(pct(music, 0.9))}`);
console.log(`  speech n=${speech.length} p10=${fmt(pct(speech, 0.1))} p50=${fmt(pct(speech, 0.5))} p90=${fmt(pct(speech, 0.9))}`);
