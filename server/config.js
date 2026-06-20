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
    musicThreshold: clampNum(process.env.MUSIC_THRESHOLD, 0.55, 0, 1),
    // How long (seconds) a new state must hold before we switch.
    switchHoldSeconds: clampNum(process.env.SWITCH_HOLD_SECONDS, 3, 0, 30),
  },

  deathMetal: {
    playlistId: (process.env.YT_PLAYLIST_ID || '').trim(),
    videoIds: (process.env.YT_VIDEO_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

function clampNum(raw, fallback, min, max) {
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = config;
