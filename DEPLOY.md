# DEPLOY — instructions for Claude Code to ship a working version

You are deploying **Radio Suomi: Death Metal Edition** to **Railway**. Follow
these steps in order. Each step has a **verify** check — do not move on until it
passes. Stop and report if a step can't be made to pass.

The app only "works" when **three** things are true:
1. The server is up and serving the UI + `/stream`.
2. `YLE_STREAM_URL` points at a stream the server can actually pull (YLE is
   **geo-restricted to Finland** — see Step 2).
3. A YouTube death metal playlist/video source is configured.

---

## Step 0 — Local sanity check (do this first, before deploying)

```bash
npm install
node -c server/index.js   # syntax check; repeat for other server/*.js if changed
```

Confirm the bundled ffmpeg is healthy and can do the dual-output split:

```bash
FF=$(node -e "process.stdout.write(require('ffmpeg-static'))")
"$FF" -version | head -1
"$FF" -hide_banner -encoders 2>/dev/null | grep -q libmp3lame && echo "libmp3lame OK"
```

**Verify:** ffmpeg prints a version and `libmp3lame OK`.

---

## Step 1 — Find a working YLE Radio Suomi stream URL

The default in `.env.example` may be stale. Find a current one and test it with
the *bundled* ffmpeg (this is exactly what the server uses):

```bash
FF=$(node -e "process.stdout.write(require('ffmpeg-static'))")
URL="<candidate stream url>"   # HLS .m3u8 or Icecast/MP3
timeout 15 "$FF" -hide_banner -loglevel error -i "$URL" \
  -t 5 -ac 1 -ar 16000 -f s16le /tmp/yle_test.pcm
echo "exit=$?  bytes=$(wc -c < /tmp/yle_test.pcm)"
```

**Verify:** exit code `0` and `bytes` ≈ `160000` (5 s × 16000 × 2). If it's `0`
bytes or errors with 403/blocked, the URL is wrong **or** you're being
geo-blocked (see Step 2).

Where to look for current URLs:
- https://fmstream.org/index.php?c=FIN (Finland stations)
- the `oniongarlic/yle-api` project on GitHub
- YLE Areena network requests for "Radio Suomi" live

> Do not hardcode a URL you haven't verified with the command above.

---

## Step 2 — Handle the Finland geo-restriction (critical)

YLE streams only play from Finnish IPs. The **browser** side is fine (the user
is in Finland). The **server** must also reach YLE, so the Railway deployment
needs an egress IP YLE accepts.

Check, in order:
1. **Does Step 1 pass from your current machine?** If you're in Finland it will;
   that tells you the URL is good.
2. **Does it pass from Railway?** After deploying (Step 4), check the logs for
   repeated `[ffmpeg] exited ... restarting` with HTTP 403 — that means Railway's
   IP is blocked.

If Railway is geo-blocked, pick one (ask the user which they prefer):
- Set a Railway region closest to / inside Finland if available.
- Put a Finland-based HTTP proxy in front and point `YLE_STREAM_URL` through it,
  or run the backend on a small Finnish VPS and only host the static UI on
  Railway.
- As a fallback for testing, point `YLE_STREAM_URL` at any reachable Icecast/MP3
  talk stream to prove the pipeline end-to-end, then swap back.

**Verify:** server logs show `[ffmpeg] streaming from ...` and NOT a restart
loop; `/healthz` returns `{"ok":true,...}`.

---

## Step 3 — Pick a death metal source

You need a YouTube **playlist ID** (preferred, gets shuffled) or specific video
IDs. Ask the user for their playlist URL if they have one. Otherwise set it
later from the UI. If setting via env:

- `YT_PLAYLIST_ID` = the part after `list=` in a playlist URL, **or**
- `YT_VIDEO_IDS` = comma-separated 11-char video IDs.

Do **not** invent video/playlist IDs — unverified IDs 404. Either use one the
user gives you, or leave empty and configure from the UI after deploy.

---

## Step 4 — Deploy to Railway

Prefer the Railway CLI. Install/login if needed:

```bash
npm i -g @railway/cli        # if not installed
railway whoami || railway login   # login is interactive; ask the user to run it if no token
```

If a `RAILWAY_TOKEN` is available in the environment, the CLI uses it
non-interactively. From the repo root:

```bash
railway init        # create/link a project (or: railway link to attach existing)
railway up          # build & deploy using railway.json (Nixpacks, npm start)
```

Set environment variables (CLI):

```bash
railway variables --set "YLE_STREAM_URL=<verified url from Step 1>"
railway variables --set "MUSIC_THRESHOLD=0.55"
railway variables --set "SWITCH_HOLD_SECONDS=3"
# optional:
railway variables --set "YT_PLAYLIST_ID=<id>"
```

Expose a public URL:

```bash
railway domain           # generates a public domain; note the URL
```

> `PORT` is provided by Railway automatically — do **not** set it. `ffmpeg`
> ships with the app via `ffmpeg-static`, so no system packages are needed.

**Alternative (no CLI):** connect the GitHub repo in the Railway dashboard
(New Project → Deploy from GitHub), set the same variables under Variables, and
generate a domain under Settings → Networking. Deploy this branch (or merge it
to `main` first).

---

## Step 5 — Verify the live deployment

Replace `$APP` with the Railway URL.

```bash
APP="https://<your-app>.up.railway.app"
curl -s "$APP/healthz"            # -> {"ok":true,"state":"speech"}
curl -s "$APP/api/config"         # -> shows deathMetal + detection config
# Pull ~3s of the proxied radio MP3 and confirm real audio bytes flow:
curl -s --max-time 6 "$APP/stream" -o /tmp/live.mp3; echo "stream bytes=$(wc -c < /tmp/live.mp3)"
```

**Verify:**
- `/healthz` returns ok.
- `/stream` produces a non-trivial number of bytes (tens of KB+), not 0. Zero
  bytes means ffmpeg can't pull the upstream → revisit Steps 1–2.

Then open `$APP` in a browser and:
1. Paste the death metal playlist (if not set via env) → **Save**.
2. Press **▶ Start**.
3. Watch the **Music probability** meter move with the audio; confirm that on a
   music segment it crosses the threshold and YouTube death metal takes over,
   and that it returns to radio afterward. Tune the **Sensitivity** slider to
   the real content.

---

## Step 6 — Report back

Report to the user:
- The public URL.
- Which `YLE_STREAM_URL` you used and that Step 1 + Step 5 passed.
- Whether Railway hit the geo-block and how it was resolved.
- The death metal source configured.

If anything is still failing, report the exact failing step and its output
rather than claiming success.
