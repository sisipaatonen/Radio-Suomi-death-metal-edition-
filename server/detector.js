'use strict';

const { EventEmitter } = require('events');
const { magnitudeSpectrum } = require('./fft');

// Speech / music discriminator for 16 kHz mono PCM (signed 16-bit LE).
//
// It uses well-established lightweight features rather than a heavy ML model so
// it can run forever on a small Railway box:
//   - LSTER  (Low Short-Time Energy Ratio): speech has many low-energy frames
//            because of pauses between words -> high LSTER => speech.
//   - HZCRR  (High Zero-Crossing-Rate Ratio): unvoiced speech bursts push ZCR
//            high intermittently -> high HZCRR => speech.
//   - Energy coefficient of variation: speech energy is bursty, music steadier.
//   - Spectral flux variability: music tends to have steadier spectral motion.
//
// These are combined into a single musicProbability in [0,1]. A hysteresis
// timer prevents the output state from flapping on short pauses / breaks.

const SAMPLE_RATE = 32000;
const FRAME = 1024; // ~32 ms
const HOP = 512; // ~16 ms
const FRAMES_PER_WINDOW = Math.round(SAMPLE_RATE / HOP); // ~1 second of frames

// Spectral band bins for the FRAME-point FFT (mag length = FRAME/2).
const BIN_HZ = SAMPLE_RATE / FRAME; // ~31.25 Hz/bin
const SUB_LO_BIN = 1; // ~31 Hz   } sub-bass: kick/bass energy -> music
const SUB_HI_BIN = Math.round(110 / BIN_HZ); // ~110 Hz
const HF_LO_BIN = Math.round(10000 / BIN_HZ); // 10 kHz: cymbals/production -> music

class Detector extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.musicThreshold = opts.musicThreshold ?? 0.55;
    // Asymmetric hold: slow to switch INTO death metal (ride the host's 5-10 s
    // crossfade), fast to cut BACK to radio the moment speech starts.
    this.enterHoldSeconds = opts.enterHoldSeconds ?? 5;
    this.exitHoldSeconds = opts.exitHoldSeconds ?? 1;
    this.switchHoldSeconds = opts.switchHoldSeconds ?? 3; // legacy/back-compat

    this._tail = Buffer.alloc(0); // leftover bytes between pushes
    this._frames = []; // feature objects for the current texture window
    this._prevMag = null; // previous magnitude spectrum (for flux)

    this.state = 'speech'; // public, debounced state
    this._candidate = null; // pending state awaiting hold
    this._candidateWindows = 0; // consecutive windows the candidate has held
  }

  setConfig({ musicThreshold, enterHoldSeconds, exitHoldSeconds }) {
    if (typeof musicThreshold === 'number') {
      this.musicThreshold = Math.min(1, Math.max(0, musicThreshold));
    }
    if (typeof enterHoldSeconds === 'number') {
      this.enterHoldSeconds = Math.min(30, Math.max(0, enterHoldSeconds));
    }
    if (typeof exitHoldSeconds === 'number') {
      this.exitHoldSeconds = Math.min(30, Math.max(0, exitHoldSeconds));
    }
  }

  // Feed raw PCM bytes (s16le mono 16 kHz).
  push(buffer) {
    const data = this._tail.length ? Buffer.concat([this._tail, buffer]) : buffer;
    const totalSamples = Math.floor(data.length / 2);

    let off = 0; // sample offset
    while (off + FRAME <= totalSamples) {
      this._processFrame(data, off * 2);
      off += HOP;
    }

    // Keep the unconsumed tail (samples not yet covered by a full frame hop).
    const consumed = off * 2;
    this._tail = data.subarray(consumed);
  }

  _processFrame(buf, byteOffset) {
    const frame = new Float32Array(FRAME);
    let sumSq = 0;
    let zc = 0;
    let prev = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = buf.readInt16LE(byteOffset + i * 2) / 32768;
      frame[i] = s;
      sumSq += s * s;
      if (i > 0 && ((s >= 0 && prev < 0) || (s < 0 && prev >= 0))) zc++;
      prev = s;
    }
    const energy = sumSq / FRAME; // mean power
    const zcr = zc / FRAME;

    // Spectral features.
    const mag = magnitudeSpectrum(frame);
    let magSum = 0;
    let centroidNum = 0;
    for (let i = 0; i < mag.length; i++) {
      magSum += mag[i];
      centroidNum += i * mag[i];
    }
    const centroid = magSum > 0 ? centroidNum / magSum : 0;

    let flux = 0;
    if (this._prevMag) {
      for (let i = 0; i < mag.length; i++) {
        const d = mag[i] - this._prevMag[i];
        if (d > 0) flux += d;
      }
    }
    this._prevMag = mag;

    // Band energies (skip DC bin 0). Sub-bass and >10 kHz favour music.
    let totalMag = 0;
    let subMag = 0;
    let hfMag = 0;
    for (let i = 1; i < mag.length; i++) {
      totalMag += mag[i];
      if (i >= SUB_LO_BIN && i <= SUB_HI_BIN) subMag += mag[i];
      if (i >= HF_LO_BIN) hfMag += mag[i];
    }
    this._frames.push({ energy, zcr, centroid, flux, subMag, hfMag, totalMag });
    if (this._frames.length >= FRAMES_PER_WINDOW) this._finishWindow();
  }

  _finishWindow() {
    const frames = this._frames;
    this._frames = [];
    const n = frames.length;
    if (n === 0) return;

    let eSum = 0;
    let zSum = 0;
    for (const f of frames) {
      eSum += f.energy;
      zSum += f.zcr;
    }
    const eAvg = eSum / n;
    const zAvg = zSum / n;

    // LSTER / HZCRR.
    let lowE = 0;
    let highZ = 0;
    let eVar = 0;
    let fluxSum = 0;
    let fluxSq = 0;
    let subMagSum = 0;
    let hfMagSum = 0;
    let totMagSum = 0;
    for (const f of frames) {
      if (f.energy < 0.5 * eAvg) lowE++;
      if (f.zcr > 1.5 * zAvg) highZ++;
      const de = f.energy - eAvg;
      eVar += de * de;
      fluxSum += f.flux;
      fluxSq += f.flux * f.flux;
      subMagSum += f.subMag;
      hfMagSum += f.hfMag;
      totMagSum += f.totalMag;
    }
    // Energy-weighted band ratios over the whole window, so near-silent speech
    // pauses (where a per-frame ratio is just noise) don't inflate the bands.
    const subBassRatio = totMagSum > 0 ? subMagSum / totMagSum : 0;
    const highFreqRatio = totMagSum > 0 ? hfMagSum / totMagSum : 0;
    const lster = lowE / n;
    const hzcrr = highZ / n;
    const energyCV = eAvg > 0 ? Math.sqrt(eVar / n) / eAvg : 0;
    const fluxMean = fluxSum / n;
    const fluxCV =
      fluxMean > 0 ? Math.sqrt(Math.max(0, fluxSq / n - fluxMean * fluxMean)) / fluxMean : 0;

    // Map each feature to a "music-ness" in [0,1] (1 = music).
    const m1 = 1 - clamp01(lster / 0.22); // high LSTER -> speech
    const m2 = 1 - clamp01(hzcrr / 0.18); // high HZCRR -> speech
    const m3 = 1 - clamp01(energyCV / 1.4); // high energy CV -> speech
    const m4 = 1 - clamp01(fluxCV / 1.6); // steady flux -> music
    const m5 = clamp01(subBassRatio / 0.18); // strong sub-bass -> music
    const m6 = clamp01(highFreqRatio / 0.06); // >10 kHz -> music (weak on bandlimited radio)

    // Weighted blend, tuned on labeled YLE talk vs music. LSTER and sub-bass are
    // the strongest discriminators; >10 kHz barely separates on codec-limited
    // streams so it carries only a small weight (honours the idea without noise).
    const musicProb = clamp01(
      0.34 * m1 + 0.12 * m2 + 0.12 * m3 + 0.1 * m4 + 0.27 * m5 + 0.05 * m6
    );

    // Near-silence is ambiguous; treat as speech (a pause), don't trigger metal.
    const silent = eAvg < 1e-5;
    const rawState = !silent && musicProb >= this.musicThreshold ? 'music' : 'speech';

    this._applyHysteresis(rawState);

    this.emit('analysis', {
      state: this.state,
      rawState,
      musicProb: round(musicProb),
      metrics: {
        lster: round(lster),
        hzcrr: round(hzcrr),
        energyCV: round(energyCV),
        fluxCV: round(fluxCV),
        subBass: round(subBassRatio),
        highFreq: round(highFreqRatio),
        level: round(Math.sqrt(eAvg)),
      },
      threshold: this.musicThreshold,
      ts: Date.now(),
    });
  }

  _applyHysteresis(rawState) {
    // Each texture window is ~1 second, so switchHoldSeconds ≈ window count.
    // Counting windows (rather than wall-clock time) keeps the hold consistent
    // even when ffmpeg delivers PCM in bursts (e.g. HLS segment boundaries).
    if (rawState === this.state) {
      this._candidate = null;
      this._candidateWindows = 0;
      return;
    }
    if (this._candidate !== rawState) {
      this._candidate = rawState;
      this._candidateWindows = 1;
      return;
    }
    this._candidateWindows++;
    // Asymmetric: switching to 'music' (into death metal) needs enterHold; back
    // to 'speech' needs only exitHold so the radio talk is cut in fast.
    const holdSec = rawState === 'music' ? this.enterHoldSeconds : this.exitHoldSeconds;
    if (this._candidateWindows >= Math.max(1, Math.round(holdSec))) {
      this.state = rawState;
      this._candidate = null;
      this._candidateWindows = 0;
      this.emit('state', this.state);
    }
  }
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}
function round(x) {
  return Math.round(x * 1000) / 1000;
}

module.exports = { Detector };
