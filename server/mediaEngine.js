'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const ffmpegPath = require('ffmpeg-static');

// Runs a single ffmpeg process that pulls the upstream radio once and produces
// two outputs from that one connection:
//   - stdout (pipe:1): re-encoded MP3, broadcast to every /stream listener.
//   - fd 3   (pipe:3): 16 kHz mono s16le PCM, fed to the detector.
//
// Using one upstream connection keeps the audio the browser hears and the audio
// the detector analyses time-aligned. ffmpeg is auto-restarted with backoff if
// the upstream drops.

class MediaEngine extends EventEmitter {
  constructor({ streamUrl, bitrate = '128k' }) {
    super();
    this.streamUrl = streamUrl;
    this.bitrate = bitrate;

    this.proc = null;
    this.clients = new Set(); // express response objects for /stream
    this._restartDelay = 1000;
    this._stopped = false;
  }

  start() {
    this._stopped = false;
    this._spawn();
  }

  stop() {
    this._stopped = true;
    if (this.proc) {
      this.proc.kill('SIGKILL');
      this.proc = null;
    }
  }

  _spawn() {
    const args = [
      '-loglevel', 'error',
      // Reconnect on flaky http(s) upstreams.
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', this.streamUrl,
      // Output 1: MP3 for the browser.
      '-map', '0:a:0',
      '-ac', '2',
      '-ar', '44100',
      '-c:a', 'libmp3lame',
      '-b:a', this.bitrate,
      '-f', 'mp3',
      'pipe:1',
      // Output 2: PCM for analysis.
      '-map', '0:a:0',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      '-f', 's16le',
      'pipe:3',
    ];

    const proc = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    proc.stdout.on('data', (chunk) => this._broadcast(chunk));

    const pcm = proc.stdio[3];
    pcm.on('data', (chunk) => this.emit('pcm', chunk));

    proc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.error('[ffmpeg]', msg);
    });

    proc.on('exit', (code, signal) => {
      if (this._stopped) return;
      console.error(`[ffmpeg] exited (code=${code} signal=${signal}); restarting...`);
      setTimeout(() => this._spawn(), this._restartDelay);
      this._restartDelay = Math.min(this._restartDelay * 2, 15000);
    });

    proc.on('spawn', () => {
      this._restartDelay = 1000;
      console.log('[ffmpeg] streaming from', this.streamUrl);
    });
  }

  _broadcast(chunk) {
    for (const res of this.clients) {
      try {
        res.write(chunk);
      } catch (_) {
        this.clients.delete(res);
      }
    }
  }

  // Attach an HTTP response as an MP3 listener.
  addClient(req, res) {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }
}

module.exports = { MediaEngine };
