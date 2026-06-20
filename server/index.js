'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const { MediaEngine } = require('./mediaEngine');
const { Detector } = require('./detector');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// Expose the (optionally pre-seeded) death metal config + detection defaults
// so the browser can start without any manual setup if env vars are present.
app.get('/api/config', (_req, res) => {
  res.json({
    deathMetal: config.deathMetal,
    detection: {
      musicThreshold: detector.musicThreshold,
      switchHoldSeconds: detector.switchHoldSeconds,
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
  switchHoldSeconds: config.detection.switchHoldSeconds,
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
      switchHoldSeconds: detector.switchHoldSeconds,
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
        switchHoldSeconds: msg.switchHoldSeconds,
      });
      broadcastWS({
        type: 'configUpdated',
        threshold: detector.musicThreshold,
        switchHoldSeconds: detector.switchHoldSeconds,
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
