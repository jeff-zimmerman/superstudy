#!/usr/bin/env bash
# Remux lecture recordings for web playback: H.264/AAC MP4 with the index (moov)
# at the front so the browser can seek with range requests. Subtitle tracks are
# dropped from the web copy (the app loads the extracted .vtt instead).
# Usage: ./prepare_videos.sh raw/*.mp4   -> web/<name>.mp4
set -euo pipefail
mkdir -p web
for f in "$@"; do
  out="web/$(basename "${f%.*}").mp4"
  v=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$f")
  if [ "$v" = "h264" ]; then
    ffmpeg -v error -y -i "$f" -map 0:v:0 -map 0:a:0? -c:v copy -c:a aac -movflags +faststart "$out"
  else
    # re-encode; -g 60 keeps keyframes ~2 s apart so seeks/thumbnails are fast
    ffmpeg -v error -y -i "$f" -map 0:v:0 -map 0:a:0? -c:v libx264 -crf 26 -preset veryfast -g 60 \
      -c:a aac -b:a 96k -movflags +faststart "$out"
  fi
  echo "$out"
done
