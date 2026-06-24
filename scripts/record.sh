#!/usr/bin/env bash
# Rolling capture of the live Icecast stream as 30s timestamped clips, matching
# the server's decode (32 kHz mono s16le WAV). Keeps ~the last 30 min, pruning
# older segments. Flag a rough wall-clock time when you hear a hiccup; the
# segment named seg_YYYYMMDD_HHMMSS.wav covering that minute is the clip.
#
#   bash scripts/record.sh [STREAM_URL] [OUT_DIR]
set -euo pipefail
URL="${1:-https://icecast.live.yle.fi/radio/YleRS/icecast.audio}"
OUT="${2:-/tmp/rdm-cap}"
mkdir -p "$OUT"

# Background pruner: drop clips older than 30 min so /tmp doesn't grow forever.
( while true; do find "$OUT" -name 'seg_*.wav' -mmin +30 -delete 2>/dev/null || true; sleep 60; done ) &
PRUNE=$!
trap 'kill "$PRUNE" 2>/dev/null || true' EXIT

echo "[record] $URL -> $OUT/seg_*.wav (32kHz mono, 30s segments, 30min rolling)"
exec ffmpeg -loglevel error -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
  -i "$URL" -ac 1 -ar 32000 -c:a pcm_s16le \
  -f segment -segment_time 30 -reset_timestamps 1 -strftime 1 \
  "$OUT/seg_%Y%m%d_%H%M%S.wav"
