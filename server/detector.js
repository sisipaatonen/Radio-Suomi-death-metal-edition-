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
const SUB_LO_BIN = 1; // ~31 Hz   } TRUE sub-bass (kick/bass) -> music. Capped at
const SUB_HI_BIN = Math.round(75 / BIN_HZ); // ~75 Hz, BELOW the male voice
//   fundamental (~85-180 Hz) so a deep male speaker is not mistaken for music.
const HF_LO_BIN = Math.round(10000 / BIN_HZ); // 10 kHz: cymbals/production -> music

class Detector extends EventEmitter {
  constructor(opts = {}) {
    super();
    // Schmitt-trigger thresholds on a smoothed probability. A dead-band between
    // exit and enter stops the state flapping when a song dips momentarily
    // (quiet verse, breakdown) or a stray musical sting appears during talk.
    // Tuned on real Radio Suomi: songs smooth to ~0.6-0.8, the DJ talk (often
    // over a light music bed) sits ~0.40, so exit must be ~0.42 to catch it
    // while songs stay safely above. The gap to enter (0.50) is the dead-band.
    this.enterThreshold = opts.enterThreshold ?? 0.6; // speech -> music (clear songs only)
    this.exitThreshold = opts.exitThreshold ?? 0.42; // music -> speech
    this.smoothing = opts.smoothing ?? 0.45; // EMA weight on the newest window
    // Asymmetric hold: slow into death metal (ride the host's 5-10 s crossfade),
    // quick back to radio so the talk is not missed.
    this.enterHoldSeconds = opts.enterHoldSeconds ?? 5;
    this.exitHoldSeconds = opts.exitHoldSeconds ?? 1;

    this._tail = Buffer.alloc(0); // leftover bytes between pushes
    this._frames = []; // feature objects for the current texture window
    this._prevMag = null; // previous magnitude spectrum (for flux)
    this._probEMA = null; // smoothed music probability

    this.state = 'speech'; // public, debounced state
    this._candidate = null; // pending state awaiting hold
    this._candidateWindows = 0; // consecutive windows the candidate has held
  }

  setConfig({ enterThreshold, exitThreshold, enterHoldSeconds, exitHoldSeconds }) {
    if (typeof enterThreshold === 'number') {
      this.enterThreshold = Math.min(1, Math.max(0, enterThreshold));
    }
    if (typeof exitThreshold === 'number') {
      this.exitThreshold = Math.min(1, Math.max(0, exitThreshold));
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
    const m5 = clamp01(subBassRatio / 0.08); // sub-bass -> music (narrow 30-78 Hz band; catches weak-bass songs, male talk stays low because its energy is above this band)
    const m6 = clamp01(highFreqRatio / 0.06); // >10 kHz -> music (weak on bandlimited radio)

    // Weighted blend, tuned on real Radio Suomi audio. SUB-BASS dominates: it is
    // the reliable music cue (kick/bass present in songs, absent in talk). LSTER
    // is demoted because beat-driven music has many low-energy frames and was
    // wrongly dragging real music toward "speech" (the random-switching bug).
    const musicProb = clamp01(
      0.18 * m1 + 0.1 * m2 + 0.08 * m3 + 0.06 * m4 + 0.5 * m5 + 0.08 * m6
    );

    // Smooth (EMA) then apply the Schmitt trigger: only cross INTO music above
    // enterThreshold and back to speech below exitThreshold. The dead-band kills
    // the flapping. Near-silence is treated as speech (don't play metal over a
    // dead-air gap).
    this._probEMA =
      this._probEMA == null ? musicProb : this.smoothing * musicProb + (1 - this.smoothing) * this._probEMA;
    const smooth = this._probEMA;
    const silent = eAvg < 1e-5;

    let rawState = this.state;
    if (silent) rawState = 'speech';
    else if (this.state !== 'music' && smooth >= this.enterThreshold) rawState = 'music';
    else if (this.state === 'music' && smooth < this.exitThreshold) rawState = 'speech';

    this._applyHysteresis(rawState);

    this.emit('analysis', {
      state: this.state,
      rawState,
      musicProb: round(musicProb),
      smoothProb: round(smooth),
      metrics: {
        lster: round(lster),
        hzcrr: round(hzcrr),
        energyCV: round(energyCV),
        fluxCV: round(fluxCV),
        subBass: round(subBassRatio),
        highFreq: round(highFreqRatio),
        level: round(Math.sqrt(eAvg)),
      },
      enterThreshold: this.enterThreshold,
      exitThreshold: this.exitThreshold,
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
