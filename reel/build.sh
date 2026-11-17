#!/usr/bin/env bash
# Build the airgap explainer reel from the voice-over and the modem.
#   ./build.sh            -> build/airgap-reel.mp4 (1080x1920, for Instagram's API)
#                            build/airgap-reel-4k.mp4 (2160x3840, for the app)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build

node chirp.mjs                         # the real chirp, tones and CRCs
python3 align.py audio/voice.mp3       # words.json (already committed; rerun after a new take)
python3 sfx.py                         # build/sfx.wav
python3 render.py chapters             # build/video.mp4, drawn at 2160x3840
python3 render.py cover 3.4            # build/cover.jpg

# Voice 1.7 s in (the chirp comes first), effects underneath, -14 LUFS.
ffmpeg -v error -y -i audio/voice.mp3 -i build/sfx.wav -filter_complex \
  "[0:a]aresample=44100,adelay=1700|1700,pan=mono|c0=c0[v];[v][1:a]amix=inputs=2:duration=longest:normalize=0,atrim=0:49,loudnorm=I=-14:TP=-1.5:LRA=11,aformat=sample_rates=48000:channel_layouts=stereo[a]" \
  -map "[a]" -c:a aac -b:a 128k build/mix.m4a
ffmpeg -v error -y -i build/video.mp4 -i build/mix.m4a -map 0:v -map 1:a -c copy -movflags +faststart -shortest build/airgap-reel-4k.mp4

# Instagram's API takes at most 1920 px wide: downscale the 4K master.
ffmpeg -v error -y -i build/airgap-reel-4k.mp4 -vf "scale=1080:1920:flags=lanczos" \
  -c:v libx264 -profile:v high -preset slow -crf 14 -maxrate 14M -bufsize 20M -r 30 -g 60 -flags +cgop \
  -pix_fmt yuv420p -c:a copy -movflags +faststart build/airgap-reel.mp4
echo "build/airgap-reel.mp4  build/airgap-reel-4k.mp4"
