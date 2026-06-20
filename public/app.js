'use strict';

// ---------------------------------------------------------------------------
// Radio Suomi: Death Metal Edition — browser controller
//
// Plays the proxied YLE radio for speech. When the server's detector reports
// "music", it fades out the radio and plays a full classic death metal song
// from YouTube. When the song ends: if the radio is still on music, play
// another; if speech has resumed, rejoin the live radio. (Full song wins.)
// ---------------------------------------------------------------------------

const el = (id) => document.getElementById(id);
const radio = el('radio');

const state = {
  running: false,
  mode: 'radio', // what is currently playing: 'radio' | 'metal'
  override: 'auto', // 'auto' | 'radio' | 'metal'
  serverState: 'speech', // latest detection from server
  threshold: 0.55,
  ytReady: false,
  metal: { type: 'none', playlistId: '', videoIds: [], queue: [], qi: 0 },
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(msg, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  const t = new Date().toLocaleTimeString();
  line.textContent = `${t}  ${msg}`;
  const box = el('log');
  box.prepend(line);
  while (box.children.length > 120) box.removeChild(box.lastChild);
}

// ---------------------------------------------------------------------------
// YouTube IFrame API
// ---------------------------------------------------------------------------
let ytPlayer = null;

window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player('ytHost', {
    height: '1',
    width: '1',
    playerVars: {
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      fs: 0,
      modestbranding: 1,
      playsinline: 1,
      rel: 0,
    },
    events: {
      onReady: () => {
        state.ytReady = true;
        log('YouTube player ready.');
      },
      onStateChange: onYtStateChange,
      onError: onYtError,
    },
  });
};

function loadYtApi() {
  if (window.YT) return;
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

function onYtStateChange(e) {
  if (e.data === YT.PlayerState.PLAYING) {
    const d = ytPlayer.getVideoData ? ytPlayer.getVideoData() : null;
    if (d && d.title) {
      el('nowPlaying').textContent = '☠ ' + d.title;
      log('Metal: ' + d.title, 'metal');
    }
  } else if (e.data === YT.PlayerState.ENDED) {
    onMetalEnded();
  }
}

function onYtError(e) {
  log('YouTube error (' + e.data + '), skipping track.', 'metal');
  // Bad/unavailable video — advance.
  setTimeout(() => {
    if (state.mode === 'metal') playNextMetal();
  }, 300);
}

// ---------------------------------------------------------------------------
// Death metal source handling
// ---------------------------------------------------------------------------
function parseYtInput(text) {
  const out = { playlistId: '', videoIds: [] };
  const listM = text.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (listM) out.playlistId = listM[1];
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  for (const t of tokens) {
    let id = null;
    const m = t.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
    if (m) id = m[1];
    else if (/^[A-Za-z0-9_-]{11}$/.test(t)) id = t;
    if (id && !out.videoIds.includes(id)) out.videoIds.push(id);
  }
  return out;
}

function applyMetalSource(parsed) {
  if (parsed.playlistId) {
    state.metal = { type: 'playlist', playlistId: parsed.playlistId, videoIds: [] };
    el('ytStatus').textContent = 'Playlist set (shuffled).';
  } else if (parsed.videoIds.length) {
    state.metal = {
      type: 'ids',
      playlistId: '',
      videoIds: parsed.videoIds.slice(),
      queue: shuffle(parsed.videoIds.slice()),
      qi: 0,
    };
    el('ytStatus').textContent = parsed.videoIds.length + ' track(s) loaded.';
  } else {
    state.metal = { type: 'none', playlistId: '', videoIds: [] };
    el('ytStatus').textContent = 'No death metal configured yet.';
  }
}

function haveMetal() {
  return state.metal.type !== 'none';
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function playFirstMetal() {
  if (!state.ytReady || !haveMetal()) return;
  if (state.metal.type === 'playlist') {
    ytPlayer.loadPlaylist({ listType: 'playlist', list: state.metal.playlistId, index: 0 });
    if (ytPlayer.setShuffle) ytPlayer.setShuffle(true);
    if (ytPlayer.setLoop) ytPlayer.setLoop(true);
  } else {
    state.metal.queue = shuffle(state.metal.videoIds.slice());
    state.metal.qi = 0;
    ytPlayer.loadVideoById(state.metal.queue[0]);
  }
  ytPlayer.setVolume(100);
}

function playNextMetal() {
  if (!state.ytReady || !haveMetal()) return;
  if (state.metal.type === 'playlist') {
    ytPlayer.nextVideo();
  } else {
    state.metal.qi++;
    if (state.metal.qi >= state.metal.queue.length) {
      state.metal.queue = shuffle(state.metal.videoIds.slice());
      state.metal.qi = 0;
    }
    ytPlayer.loadVideoById(state.metal.queue[state.metal.qi]);
  }
}

// ---------------------------------------------------------------------------
// Radio audio
// ---------------------------------------------------------------------------
function startRadio() {
  // Fresh src each time so we rejoin at the live edge, not a buffered backlog.
  radio.src = '/stream?t=' + Date.now();
  radio.volume = 0;
  const p = radio.play();
  if (p && p.catch) p.catch((err) => log('Radio play blocked: ' + err.message));
  fade(radio, 1, 600);
}

function stopRadio() {
  fade(radio, 0, 400, () => {
    radio.pause();
    radio.removeAttribute('src');
    radio.load();
  });
}

function fade(node, target, ms, cb) {
  const isYt = node === ytPlayer;
  const get = () => (isYt ? node.getVolume() / 100 : node.volume);
  const set = (v) => (isYt ? node.setVolume(Math.round(v * 100)) : (node.volume = v));
  const start = get();
  const steps = Math.max(1, Math.round(ms / 50));
  let i = 0;
  const timer = setInterval(() => {
    i++;
    const v = start + (target - start) * (i / steps);
    try {
      set(Math.min(1, Math.max(0, v)));
    } catch (_) {}
    if (i >= steps) {
      clearInterval(timer);
      if (cb) cb();
    }
  }, 50);
}

// ---------------------------------------------------------------------------
// Mode transitions
// ---------------------------------------------------------------------------
function switchToMetal() {
  if (!haveMetal()) {
    log('Music detected but no death metal configured — staying on radio.', 'radio');
    return;
  }
  state.mode = 'metal';
  setModeUI('metal');
  stopRadio();
  log('Music detected → death metal.', 'metal');
  playFirstMetal();
}

function switchToRadio() {
  state.mode = 'radio';
  setModeUI('radio');
  if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
  el('nowPlaying').textContent = '📻 YLE Radio Suomi (speech)';
  log('Rejoining live radio.', 'radio');
  startRadio();
}

function onMetalEnded() {
  if (!state.running) return;
  if (state.override === 'metal') return playNextMetal();
  if (state.override === 'radio') return switchToRadio();
  // auto
  if (state.serverState === 'music') playNextMetal();
  else switchToRadio();
}

// ---------------------------------------------------------------------------
// Detection feed (WebSocket)
// ---------------------------------------------------------------------------
let ws = null;
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => log('Connected to detector.');
  ws.onclose = () => {
    log('Detector disconnected, retrying…');
    setTimeout(connectWS, 2000);
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    if (msg.type === 'hello') {
      state.threshold = msg.threshold;
      el('threshold').value = msg.threshold;
      el('threshLabel').textContent = msg.threshold.toFixed(2);
      el('threshMark').style.left = msg.threshold * 100 + '%';
    } else if (msg.type === 'analysis') {
      onAnalysis(msg);
    } else if (msg.type === 'configUpdated') {
      state.threshold = msg.threshold;
      el('threshMark').style.left = msg.threshold * 100 + '%';
    }
  };
}

function onAnalysis(a) {
  state.serverState = a.state;
  // Meter
  const pct = Math.round(a.musicProb * 100);
  el('meterFill').style.width = pct + '%';
  el('probVal').textContent = a.musicProb.toFixed(2) + (a.state === 'music' ? ' ♫' : ' 🗣');
  const m = a.metrics;
  el('metrics').innerHTML =
    `<span>LSTER ${m.lster}</span>` +
    `<span>HZCRR ${m.hzcrr}</span>` +
    `<span>E-CV ${m.energyCV}</span>` +
    `<span>Flux-CV ${m.fluxCV}</span>` +
    `<span>Level ${m.level}</span>`;

  if (!state.running || state.override !== 'auto') return;
  if (state.mode === 'radio' && a.state === 'music') switchToMetal();
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function setModeUI(mode) {
  const node = el('mode');
  node.className = 'mode ' + mode;
  node.textContent = mode === 'metal' ? 'DEATH METAL' : 'RADIO';
}

function setOverride(mode) {
  state.override = mode;
  document.querySelectorAll('.seg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  log('Mode: ' + mode + '.');
  if (!state.running) return;
  if (mode === 'radio') {
    if (state.mode !== 'radio') switchToRadio();
  } else if (mode === 'metal') {
    if (state.mode !== 'metal') switchToMetal();
  } else {
    // auto: react to current detection immediately
    if (state.mode === 'radio' && state.serverState === 'music') switchToMetal();
  }
}

function start() {
  if (state.running) return;
  state.running = true;
  el('startBtn').disabled = true;
  el('stopBtn').disabled = false;
  el('skipBtn').disabled = false;
  log('Started.');
  state.mode = 'radio';
  setModeUI('radio');
  el('nowPlaying').textContent = '📻 YLE Radio Suomi (speech)';
  startRadio();
  // If auto and already on music, jump to metal.
  if (state.override === 'auto' && state.serverState === 'music') switchToMetal();
}

function stop() {
  state.running = false;
  el('startBtn').disabled = false;
  el('stopBtn').disabled = true;
  el('skipBtn').disabled = true;
  stopRadio();
  if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
  setModeUI('radio');
  el('nowPlaying').textContent = 'Stopped.';
  log('Stopped.');
}

function wireUI() {
  el('startBtn').onclick = start;
  el('stopBtn').onclick = stop;
  el('skipBtn').onclick = () => {
    if (state.mode === 'metal') playNextMetal();
  };

  document.querySelectorAll('.seg button').forEach((b) => {
    b.onclick = () => setOverride(b.dataset.mode);
  });

  const slider = el('threshold');
  slider.oninput = () => {
    const v = parseFloat(slider.value);
    el('threshLabel').textContent = v.toFixed(2);
    el('threshMark').style.left = v * 100 + '%';
  };
  slider.onchange = () => {
    const v = parseFloat(slider.value);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'setConfig', musicThreshold: v }));
      log('Threshold → ' + v.toFixed(2));
    }
  };

  el('saveYt').onclick = () => {
    const txt = el('ytInput').value.trim();
    const parsed = parseYtInput(txt);
    applyMetalSource(parsed);
    localStorage.setItem('ytSource', txt);
    log('Death metal source saved.');
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  wireUI();
  loadYtApi();
  connectWS();

  let seed = localStorage.getItem('ytSource') || '';
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    if (!seed) {
      if (cfg.deathMetal.playlistId) seed = 'https://www.youtube.com/playlist?list=' + cfg.deathMetal.playlistId;
      else if (cfg.deathMetal.videoIds.length) seed = cfg.deathMetal.videoIds.join('\n');
    }
  } catch (_) {}

  el('ytInput').value = seed;
  applyMetalSource(parseYtInput(seed));
  if (!haveMetal()) {
    el('ytStatus').textContent = 'Paste a YouTube playlist or video URLs, then Save.';
  }
}

boot();
