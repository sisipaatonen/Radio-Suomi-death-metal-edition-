'use strict';

// Minimal in-place iterative radix-2 Cooley-Tukey FFT.
// Operates on real input of length N (power of two), returns magnitude
// spectrum (length N/2). Kept dependency-free on purpose so the whole app
// runs on Railway with nothing but Node + the bundled ffmpeg binary.

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Hann window, cached per size.
const hannCache = new Map();
function hann(n) {
  let w = hannCache.get(n);
  if (w) return w;
  w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  hannCache.set(n, w);
  return w;
}

// Returns Float32Array of magnitudes (length N/2) for a windowed real frame.
function magnitudeSpectrum(frame) {
  const N = nextPow2(frame.length);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const w = hann(frame.length);
  for (let i = 0; i < frame.length; i++) re[i] = frame[i] * w[i];

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wpr = Math.cos(ang);
    const wpi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = i + k + len / 2;
        const tr = cr * re[b] - ci * im[b];
        const ti = cr * im[b] + ci * re[b];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wpr - ci * wpi;
        ci = cr * wpi + ci * wpr;
        cr = ncr;
      }
    }
  }

  const half = N >> 1;
  const mag = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
  return mag;
}

module.exports = { magnitudeSpectrum };
