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
    // Schmitt-trigger thresholds on the smoothed music probability. Cross up
    // through enter -> death metal; down through exit -> radio. The gap between
    // them is a dead-band that stops random flapping on song dips / talk stings.
    enterThreshold: clampNum(process.env.MUSIC_ENTER_THRESHOLD, 0.6, 0, 1),
    exitThreshold: clampNum(process.env.MUSIC_EXIT_THRESHOLD, 0.42, 0, 1),
    // Seconds of sustained music before switching INTO death metal (rides the
    // host's crossfade so we don't jump on a brief sting).
    enterHoldSeconds: clampNum(process.env.MUSIC_ENTER_HOLD_SECONDS, 5, 0, 30),
    // Seconds of sustained speech before cutting BACK to radio. Kept short for a
    // fast exit; the dead-band (not the hold) is what prevents flapping.
    exitHoldSeconds: clampNum(process.env.MUSIC_EXIT_HOLD_SECONDS, 1, 0, 30),
    // Short hold used INSTEAD of enterHoldSeconds when the smoothed prob is
    // already >= highConfThreshold (clearly a loud song), so decisive songs
    // switch fast while ambiguous audio keeps the full ride.
    enterHoldFastSeconds: clampNum(process.env.MUSIC_ENTER_HOLD_FAST_SECONDS, 2, 0, 30),
    highConfThreshold: clampNum(process.env.MUSIC_HIGH_CONF_THRESHOLD, 0.68, 0, 1),
    // Absolute sub-bass floor for the m5 energy gate (raw magnitude units). A
    // quiet voice over hum has a high sub-bass ratio but low absolute energy;
    // below this floor m5 is ramped down. 20 = calibrated on live capture
    // (no-op on real songs); 0 = disabled.
    subBassFloor: clampNum(process.env.MUSIC_SUBBASS_FLOOR, 20, 0, 1e9),
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
