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

const SAMPLE_RATE = 16000;
const FRAME = 512; // ~32 ms
const HOP = 256; // ~16 ms
const FRAMES_PER_WINDOW = Math.round(SAMPLE_RATE / HOP); // ~1 second of frames

class Detector extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.musicThreshold = opts.musicThreshold ?? 0.55;
    this.switchHoldSeconds = opts.switchHoldSeconds ?? 3;

    this._tail = Buffer.alloc(0); // leftover bytes between pushes
    this._frames = []; // feature objects for the current texture window
    this._prevMag = null; // previous magnitude spectrum (for flux)

    this.state = 'speech'; // public, debounced state
    this._candidate = null; // pending state awaiting hold
    this._candidateWindows = 0; // consecutive windows the candidate has held
  }

  setConfig({ musicThreshold, switchHoldSeconds }) {
    if (typeof musicThreshold === 'number') {
      this.musicThreshold = Math.min(1, Math.max(0, musicThreshold));
    }
    if (typeof switchHoldSeconds === 'number') {
      this.switchHoldSeconds = Math.min(30, Math.max(0, switchHoldSeconds));
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

    this._frames.push({ energy, zcr, centroid, flux });
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
    for (const f of frames) {
      if (f.energy < 0.5 * eAvg) lowE++;
      if (f.zcr > 1.5 * zAvg) highZ++;
      const de = f.energy - eAvg;
      eVar += de * de;
      fluxSum += f.flux;
      fluxSq += f.flux * f.flux;
    }
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

    // Weighted blend. LSTER is the strongest classic indicator.
    const musicProb = clamp01(0.4 * m1 + 0.25 * m2 + 0.2 * m3 + 0.15 * m4);

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
    if (this._candidateWindows >= Math.max(1, Math.round(this.switchHoldSeconds))) {
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
