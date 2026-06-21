'use strict';

// Centralised configuration, read from environment with sane defaults.
// Some values (detection threshold / hold) can be overridden live from the UI;
// these are the starting points.

const config = {
  port: parseInt(process.env.PORT || '3000', 10),

  streamUrl:
    process.env.YLE_STREAM_URL ||
    'https://yleradiolive.akamaized.net/hls/live/2027674/in-YleRS/master.m3u8',

  streamBitrate: process.env.STREAM_BITRATE || '128k',

  detection: {
    // Music probability (0..1) above which we treat audio as music.
    musicThreshold: clampNum(process.env.MUSIC_THRESHOLD, 0.4, 0, 1),
    // Seconds of sustained music before switching INTO death metal (rides the
    // host's 5-10 s crossfade so we don't jump on a brief sting).
    enterHoldSeconds: clampNum(process.env.MUSIC_ENTER_HOLD_SECONDS, 5, 0, 30),
    // Seconds of sustained speech before cutting BACK to radio (kept short so
    // the talk is not missed). "As fast as possible" within the ~1 s window.
    exitHoldSeconds: clampNum(process.env.MUSIC_EXIT_HOLD_SECONDS, 1, 0, 30),
  },

  deathMetal: {
    playlistId: (process.env.YT_PLAYLIST_ID || '').trim(),
    videoIds: (process.env.YT_VIDEO_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z0-9_-]{11}$/.test(s)),
  },
};

function clampNum(raw, fallback, min, max) {
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = config;
