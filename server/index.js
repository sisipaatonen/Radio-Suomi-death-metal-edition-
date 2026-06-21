'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const { MediaEngine } = require('./mediaEngine');
const { Detector } = require('./detector');
const { resolvePlaylist } = require('./playlist');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// Resolve the configured death metal source into a concrete, ordered list of
// YouTube video IDs the browser can shuffle and play itself (reliable shuffle +
// pause/resume, no dependence on the IFrame API's flaky native shuffle).
// Manual YT_VIDEO_IDS win; otherwise YT_PLAYLIST_ID is scraped and cached.
let metalCache = { ids: [], ts: 0 };
const METAL_TTL_MS = 60 * 60 * 1000;

app.get('/api/metal', async (_req, res) => {
  const { playlistId, videoIds } = config.deathMetal;
  if (videoIds.length) return res.json({ source: 'ids', playlistId: '', videoIds });
  if (!playlistId) return res.json({ source: 'none', playlistId: '', videoIds: [] });

  if (metalCache.ids.length && Date.now() - metalCache.ts < METAL_TTL_MS) {
    return res.json({ source: 'playlist', playlistId, videoIds: metalCache.ids });
  }
  try {
    const ids = await resolvePlaylist(playlistId);
    if (ids.length) metalCache = { ids, ts: Date.now() };
    else console.warn('[playlist] scrape returned 0 video IDs (consent cookie stale or layout changed?)');
    res.json({ source: 'playlist', playlistId, videoIds: ids.length ? ids : metalCache.ids });
  } catch (e) {
    console.error('[playlist] resolve failed:', e.message);
    // Fall back to any stale cache; the client falls back to native playlist
    // playback (still seeded with playlistId) if the list is empty.
    res.json({ source: 'playlist-error', playlistId, videoIds: metalCache.ids, error: e.message });
  }
});

// Expose the (optionally pre-seeded) death metal config + detection defaults
// so the browser can start without any manual setup if env vars are present.
app.get('/api/config', (_req, res) => {
  res.json({
    deathMetal: config.deathMetal,
    detection: {
      musicThreshold: detector.musicThreshold,
      enterHoldSeconds: detector.enterHoldSeconds,
      exitHoldSeconds: detector.exitHoldSeconds,
    },
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, state: detector.state }));

// The proxied, same-origin radio audio the browser plays for speech.
app.get('/stream', (req, res) => media.addClient(req, res));

// --- wiring ----------------------------------------------------------------

const media = new MediaEngine({
  streamUrl: config.streamUrl,
  bitrate: config.streamBitrate,
});

const detector = new Detector({
  musicThreshold: config.detection.musicThreshold,
  enterHoldSeconds: config.detection.enterHoldSeconds,
  exitHoldSeconds: config.detection.exitHoldSeconds,
});

media.on('pcm', (chunk) => detector.push(chunk));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcastWS(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// Stream per-window analysis (state + live metrics) to all connected browsers.
detector.on('analysis', (a) => broadcastWS({ type: 'analysis', ...a }));

wss.on('connection', (ws) => {
  ws.send(
    JSON.stringify({
      type: 'hello',
      state: detector.state,
      threshold: detector.musicThreshold,
      enterHoldSeconds: detector.enterHoldSeconds,
      exitHoldSeconds: detector.exitHoldSeconds,
    })
  );

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    if (msg.type === 'setConfig') {
      detector.setConfig({
        musicThreshold: msg.musicThreshold,
        enterHoldSeconds: msg.enterHoldSeconds,
        exitHoldSeconds: msg.exitHoldSeconds,
      });
      broadcastWS({
        type: 'configUpdated',
        threshold: detector.musicThreshold,
        enterHoldSeconds: detector.enterHoldSeconds,
        exitHoldSeconds: detector.exitHoldSeconds,
      });
    }
  });
});

media.start();

server.listen(config.port, () => {
  console.log(`Radio Suomi: Death Metal Edition listening on :${config.port}`);
  console.log(`Upstream: ${config.streamUrl}`);
});

function shutdown() {
  console.log('Shutting down...');
  media.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
