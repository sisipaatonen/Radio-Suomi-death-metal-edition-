'use strict';

// ---------------------------------------------------------------------------
// Radio Suomi: Death Metal Edition — browser controller
//
// Plays the proxied YLE radio while people talk. The instant the server's
// detector reports "music", the radio is paused and a classic death metal track
// takes over. When speech returns, the death metal track is PAUSED (its position
// kept) and the live radio resumes; when music comes back, the same track
// continues exactly where it left off. A track only advances when it finishes.
//
// The death metal queue is a list of video IDs resolved + shuffled by us, so
// shuffle is reliable (no dependence on the YouTube IFrame API's flaky shuffle).
//
// UI is intentionally just Play / Stop. Every display element is optional: the
// controller updates #mode / #nowPlaying / #meterFill only if they exist, so it
// works with any front-end design.
// ---------------------------------------------------------------------------

const el = (id) => document.getElementById(id);
const setText = (id, t) => {
  const e = el(id);
  if (e) e.textContent = t;
};

const radio = el('radio');

const state = {
  running: false,
  mode: 'radio', // what is audible: 'radio' | 'metal'
  serverState: 'speech', // latest detection from the server
  ytReady: false,
  queue: [], // shuffled video IDs
  qi: -1, // index of the currently-loaded metal track
  metalLoaded: false, // a track is loaded in the YT player (playing or paused)
  usingNative: false, // fell back to YouTube's own playlist shuffle
  playlistId: '',
  pendingPrimePause: false,
};

function log(...a) {
  console.log('[rdm]', ...a);
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------
function setMode(mode) {
  state.mode = mode;
  const m = el('mode');
  if (m) {
    m.classList.remove('radio', 'metal');
    m.classList.add(mode);
    m.textContent = mode === 'metal' ? 'DEATH METAL' : 'RADIO';
  }
  document.body.classList.toggle('is-metal', mode === 'metal');
  document.body.classList.toggle('is-radio', mode === 'radio');
}

function setMeter(prob) {
  const f = el('meterFill');
  if (f) f.style.width = Math.round(prob * 100) + '%';
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
  if (window.YT && window.YT.Player) {
    window.onYouTubeIframeAPIReady(); // API already loaded; build the player now
    return;
  }
  if (window.YT) return; // script injected, waiting on the ready callback
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

function onYtStateChange(e) {
  if (e.data === YT.PlayerState.PLAYING) {
    // Priming nudge (started muted to unlock autoplay): pause it back if we are
    // still on the radio so it sits ready at position 0.
    if (state.pendingPrimePause) {
      state.pendingPrimePause = false;
      if (state.mode === 'radio') {
        try {
          ytPlayer.pauseVideo();
        } catch (_) {}
        return;
      }
    }
    if (state.mode === 'metal') {
      const d = ytPlayer.getVideoData ? ytPlayer.getVideoData() : null;
      if (d && d.title) setText('nowPlaying', d.title);
    }
  } else if (e.data === YT.PlayerState.ENDED) {
    onMetalEnded();
  }
}

function onYtError(e) {
  log('YouTube error', e.data, '- skipping track.');
  // Bad/unavailable video — advance past it if we are on metal.
  if (state.mode === 'metal') {
    advanceQueue();
    startMetalAt(state.qi);
  } else {
    advanceQueue();
    state.metalLoaded = false;
  }
}

// ---------------------------------------------------------------------------
// Death metal queue
// ---------------------------------------------------------------------------
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function haveMetal() {
  return state.queue.length > 0 || state.usingNative;
}

function advanceQueue() {
  if (!state.queue.length) return;
  state.qi++;
  if (state.qi >= state.queue.length) {
    shuffle(state.queue);
    state.qi = 0;
  }
}

function startMetalAt(i) {
  if (!state.ytReady || !state.queue.length) return;
  state.qi = Math.max(0, i);
  state.metalLoaded = true;
  try {
    ytPlayer.loadVideoById(state.queue[state.qi]); // autoplays
    ytPlayer.unMute();
    ytPlayer.setVolume(100);
  } catch (_) {}
}

// Unlock YouTube autoplay inside the Play click by loading the first track
// muted, then pausing it. Real playback resumes on the first music detection.
function primeMetal() {
  if (!state.ytReady || state.metalLoaded) return;
  try {
    if (state.usingNative) {
      ytPlayer.mute();
      ytPlayer.loadPlaylist({ listType: 'playlist', list: state.playlistId, index: 0 });
      if (ytPlayer.setShuffle) ytPlayer.setShuffle(true);
      if (ytPlayer.setLoop) ytPlayer.setLoop(true);
      state.metalLoaded = true;
      state.pendingPrimePause = true;
    } else if (state.queue.length) {
      ytPlayer.mute();
      ytPlayer.loadVideoById(state.queue[0]);
      state.qi = 0;
      state.metalLoaded = true;
      state.pendingPrimePause = true;
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Radio audio
// ---------------------------------------------------------------------------
function startRadio() {
  radio.src = '/stream?t=' + Date.now(); // fresh src => rejoin the live edge
  radio.volume = 1;
  const p = radio.play();
  if (p && p.catch) p.catch((err) => log('radio play blocked:', err.message));
}

function stopRadio() {
  try {
    radio.pause();
    radio.removeAttribute('src');
    radio.load();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Mode transitions
// ---------------------------------------------------------------------------
function goMetal() {
  if (!haveMetal()) return; // no source -> stay on radio
  setMode('metal');
  stopRadio();
  try {
    ytPlayer.unMute();
    ytPlayer.setVolume(100);
  } catch (_) {}
  if (state.metalLoaded) {
    try {
      ytPlayer.playVideo(); // resume where it was paused
    } catch (_) {}
    const d = ytPlayer.getVideoData ? ytPlayer.getVideoData() : null;
    if (d && d.title) setText('nowPlaying', d.title);
  } else if (state.usingNative) {
    try {
      ytPlayer.playVideo();
    } catch (_) {}
  } else {
    startMetalAt(state.qi >= 0 ? state.qi : 0);
  }
  log('music -> death metal');
}

function goRadio() {
  setMode('radio');
  if (state.metalLoaded && ytPlayer && ytPlayer.pauseVideo) {
    try {
      ytPlayer.pauseVideo(); // keep position for resume
    } catch (_) {}
  }
  setText('nowPlaying', 'YLE Radio Suomi · live');
  startRadio();
  log('speech -> radio');
}

function onMetalEnded() {
  if (!state.running) return;
  if (state.usingNative) return; // YT auto-advances its own playlist
  advanceQueue();
  if (state.mode === 'metal') startMetalAt(state.qi);
  else state.metalLoaded = false; // load the advanced track on the next switch
}

// ---------------------------------------------------------------------------
// Detection feed (WebSocket)
// ---------------------------------------------------------------------------
let ws = null;
function wsSend(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    log('detector connected');
    if (state.running) wsSend({ type: 'listening', on: true }); // survive reconnects
  };
  ws.onclose = () => setTimeout(connectWS, 2000);
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    if (msg.type === 'hello') {
      state.serverState = msg.state || 'speech';
    } else if (msg.type === 'analysis') {
      onAnalysis(msg);
    }
  };
}

function onAnalysis(a) {
  state.serverState = a.state;
  setMeter(a.musicProb || 0);
  if (!state.running) return;
  if (a.state === 'music' && state.mode !== 'metal') goMetal();
  else if (a.state === 'speech' && state.mode !== 'radio') goRadio();
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------
function start() {
  if (state.running) return;
  state.running = true;
  const playBtn = el('playBtn');
  const stopBtn = el('stopBtn');
  if (playBtn) playBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = false;
  document.body.classList.add('is-running');
  wsSend({ type: 'listening', on: true });

  // The click is our user gesture: start radio and unlock the YT player.
  setMode('radio');
  setText('nowPlaying', 'YLE Radio Suomi · live');
  startRadio();
  if (state.serverState === 'music' && haveMetal()) {
    goMetal(); // already music -> jump straight in (also unlocks YT)
  } else {
    primeMetal();
  }
  log('started');
}

function stop() {
  state.running = false;
  const playBtn = el('playBtn');
  const stopBtn = el('stopBtn');
  if (playBtn) playBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = true;
  document.body.classList.remove('is-running');
  wsSend({ type: 'listening', on: false });

  stopRadio();
  if (ytPlayer && ytPlayer.stopVideo) {
    try {
      ytPlayer.stopVideo();
    } catch (_) {}
  }
  state.metalLoaded = false;
  state.pendingPrimePause = false;
  setMode('radio');
  setText('nowPlaying', 'Stopped.');
  log('stopped');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function loadMetalSource() {
  try {
    const res = await fetch('/api/metal');
    const data = await res.json();
    state.playlistId = data.playlistId || '';
    if (Array.isArray(data.videoIds) && data.videoIds.length) {
      state.queue = shuffle(data.videoIds.slice());
      state.qi = -1;
      state.usingNative = false;
    } else if (state.playlistId) {
      state.usingNative = true; // server scrape failed; let YT shuffle the playlist
    }
    log('metal source:', state.usingNative ? 'native playlist' : state.queue.length + ' tracks');
  } catch (e) {
    log('metal source load failed:', e.message);
  }
}

async function boot() {
  if (el('playBtn')) el('playBtn').onclick = start;
  if (el('stopBtn')) {
    el('stopBtn').onclick = stop;
    el('stopBtn').disabled = true;
  }
  setMode('radio');
  loadYtApi();
  connectWS();
  await loadMetalSource();
}

boot();
