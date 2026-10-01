# syntax=docker/dockerfile:1

FROM golang:1.25-bookworm AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/video-agent ./cmd/video-agent

FROM debian:bookworm-slim AS runtime

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/video-agent /usr/local/bin/video-agent
ENV VIDEO_AGENT_FFMPEG=/usr/bin/ffmpeg \
    VIDEO_AGENT_FFPROBE=/usr/bin/ffprobe
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/video-agent"]
CMD ["--help"]
