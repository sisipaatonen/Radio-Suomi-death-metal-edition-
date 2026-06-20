# ☠ Radio Suomi — Death Metal Edition

Listens to the **YLE Radio Suomi** live stream and plays **only the speech**.
The moment the radio switches to music, it fades the radio out and plays a
**full classic death metal song** from YouTube instead. When the death metal
song ends, it rejoins the live radio (or plays another death metal track if the
radio is still on music).

> Personal-use project. Built to run as a single full-stack service on
> **Railway**.

---

## How it works

```
                 one ffmpeg process, one upstream connection
                 ┌───────────────────────────────────────────┐
 YLE Radio Suomi │  ── MP3 (44.1k stereo) ──► /stream ───────────►  browser <audio>  (speech)
   (HLS/Icecast) │  ── PCM (16k mono)     ──► detector            (talk you actually hear)
                 └───────────────────────────────────────────┘
                                              │
                                   speech / music + metrics
                                              │  WebSocket (/ws)
                                              ▼
                                       browser controller
                                              │
                              music? ─────────┴───────── speech?
                                 │                          │
                         YouTube IFrame                 keep radio
                       (full death metal song)
```

- **One `ffmpeg`** pulls the upstream once and produces two outputs, so what you
  hear and what gets analysed stay time-aligned.
- The browser plays the **same-origin** `/stream` MP3 (no CORS headaches).
- The **detector** (`server/detector.js`) classifies speech vs. music using
  classic lightweight features — LSTER, HZCRR, energy variability, and spectral
  flux — combined into a `musicProbability`, with hysteresis so it doesn't flap
  on short pauses. No GPU, no ML model, runs forever on a tiny box.
- Death metal comes from a **YouTube playlist** (shuffled) or a list of video
  URLs you provide. Full song wins: a detected music segment is replaced by a
  whole death metal track; length is **not** stretched to match (that would
  require buffering the whole radio segment first).

---

## Quick start (local)

Requires Node 18+. `ffmpeg` is bundled via `ffmpeg-static`, so you don't need to
install it yourself.

```bash
npm install
cp .env.example .env      # then edit .env
npm start
# open http://localhost:3000
```

In the browser:

1. Paste a **YouTube playlist URL** (e.g. your "classic death metal" playlist)
   or one/more **video URLs** into the *Death metal source* box and hit **Save**.
2. Press **▶ Start**. (Browsers require a click before audio/YouTube can play.)
3. Use the **Sensitivity** slider and the live **Music probability** meter to
   tune detection to the actual YLE content. **Force radio / Force metal** let
   you override the detector; **Auto** hands control back to it.

---

## Configuration

All optional — everything can also be set from the UI. See `.env.example`.

| Variable             | Default                              | Meaning |
|----------------------|--------------------------------------|---------|
| `PORT`               | `3000`                               | HTTP port (Railway sets this). |
| `YLE_STREAM_URL`     | YLE Radio Suomi HLS                  | Any URL `ffmpeg` can read. |
| `STREAM_BITRATE`     | `128k`                               | MP3 bitrate served to the browser. |
| `MUSIC_THRESHOLD`    | `0.55`                               | Music probability above which audio is treated as music. |
| `SWITCH_HOLD_SECONDS`| `3`                                  | How long a new state must hold before switching (anti-flap). |
| `YT_PLAYLIST_ID`     | *(empty)*                            | Pre-seed a death metal playlist ID. |
| `YT_VIDEO_IDS`       | *(empty)*                            | Comma-separated fallback video IDs. |

### About the YLE stream URL

YLE changes its stream endpoints occasionally and they are **geo-restricted to
Finland**. If detection/playback fails, update `YLE_STREAM_URL`. Current URLs can
be found via [fmstream.org (Finland)](https://fmstream.org/index.php?c=FIN) or
community projects like `oniongarlic/yle-api`. Anything `ffmpeg` understands
works (HLS `.m3u8`, Icecast/MP3, …).

> ⚠️ **Geo-restriction note:** because the stream is Finland-only, your Railway
> service must reach YLE from an IP that YLE allows. If the deployed backend gets
> blocked, deploy it in/through Finland or run the backend on a machine in
> Finland. The browser side has no such requirement.

---

## Deploy to Railway

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
3. Railway auto-detects Node (Nixpacks) and runs `npm start` (see
   `railway.json`). `ffmpeg` ships with the app, so no extra system packages.
4. Add environment variables from the table above as needed (at minimum verify
   `YLE_STREAM_URL`; optionally set `YT_PLAYLIST_ID`).
5. Open the generated URL, paste your death metal playlist, press Start.

Health check: `GET /healthz` returns `{ ok: true, state }`.

---

## Tuning the detector

Speech/music discrimination on real radio is never perfect. Watch the live
meter and metrics while listening:

- **LSTER** and **HZCRR** high → speech. They drop during music.
- **E-CV** (energy variability) high → speech (pauses between words).
- **Flux-CV** low → music (steadier spectral motion).
- Lower the **threshold** to be more eager to call something music (more death
  metal, more false positives on lively speech); raise it to be more
  conservative. Increase `SWITCH_HOLD_SECONDS` if it flips too often.

The threshold can be changed live from the slider; it's pushed to the server
over the WebSocket and applied immediately.

---

## Project layout

```
server/
  index.js        Express + WebSocket server, serves UI, /stream proxy, /ws
  mediaEngine.js  One ffmpeg → MP3 (browser) + PCM (detector)
  detector.js     Speech/music classifier with hysteresis
  fft.js          Tiny dependency-free FFT for spectral features
  config.js       Env configuration
public/
  index.html      UI
  app.js          Browser controller + YouTube IFrame integration
  styles.css      Styling
```

## Notes & limitations

- Detection latency is a few seconds (analysis window + hold), so you'll hear a
  short tail of radio music before death metal kicks in — expected.
- YouTube playback requires the IFrame API (loaded from youtube.com) and a user
  gesture (the Start button) before it can play with sound.
- This replaces music with death metal for **personal listening**; respect
  YLE's and YouTube's terms of service.
