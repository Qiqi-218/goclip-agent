#!/usr/bin/env sh
set -eu

out=${1:?usage: generate.sh OUTPUT_DIRECTORY}
mkdir -p "$out"
ffmpeg_bin=${FFMPEG:-ffmpeg}

make_video() {
  name=$1
  duration=$2
  color=$3
  frequency=$4
  "$ffmpeg_bin" -hide_banner -loglevel error -nostdin -y \
    -f lavfi -i "color=c=$color:s=640x360:r=30:d=$duration" \
    -f lavfi -i "sine=frequency=$frequency:sample_rate=48000:duration=$duration" \
    -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$out/$name"
}

# Colours and frequencies make source/order checks deterministic. Semantic labels
# are maintained in docs/fixtures/F01-real-tasks.md, not embedded as model truth.
make_video talking-head.mp4 24 navy 440
make_video event-a.mp4 12 darkred 510
make_video event-b.mp4 12 darkgreen 610
make_video event-c.mp4 12 darkblue 710
printf 'Generated F01 fixture substitutes in %s\n' "$out"
