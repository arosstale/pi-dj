# pi-dj 🎧

[![npm](https://img.shields.io/npm/v/pi-dj?style=flat-square)](https://www.npmjs.com/package/pi-dj)
[![pi-package](https://img.shields.io/badge/pi.dev-package-8B5CF6?style=flat-square)](https://pi.dev/packages)
[![license](https://img.shields.io/badge/license-MIT-4B5563?style=flat-square)](LICENSE)

YouTube streaming, Suno AI generation, Lyria RealTime radio, SoundCloud / Bandcamp / BandLab downloads, mixing, trimming, BPM detection, and ffmpeg music video rendering — all from the terminal.

Works with [pi coding agent](https://github.com/badlogic/pi-mono/).

![pi-dj banner](assets/banner.png)

## Install

```bash
pi install npm:pi-dj
```

Dependencies are optional. The extension detects what's installed and degrades gracefully.

| Platform | Install |
|----------|---------|
| Windows | `winget install mpv ffmpeg` · `pip install yt-dlp` |
| macOS | `brew install mpv yt-dlp ffmpeg` |
| Linux / Raspberry Pi | `sudo apt install mpv ffmpeg -y` · `pip install yt-dlp` |
| Termux | `pkg install mpv ffmpeg python` · `pip install yt-dlp` |

## Commands

### Playback

| Command | Description |
|---------|-------------|
| `/dj-play <query\|url>` | YouTube search, URL, or playlist → stream via mpv |
| `/pause` | Toggle pause / resume |
| `/stop` | Stop + clear queue |
| `/np` | Now playing — title, timestamp, progress bar |
| `/vol <0-100>` | Set volume |
| `/skip` | Skip to next queued track |
| `/repeat` | Toggle repeat current track |
| `/queue <query\|url>` | Add to queue |
| `/history` | Recently played |

### Downloads

| Command | Description |
|---------|-------------|
| `/sc <url>` | SoundCloud → MP3 |
| `/bandcamp <url>` | Bandcamp track or album → MP3 |
| `/bandlab <url>` | BandLab track, album, or collection → MP3 |

### Radio

| Command | Description |
|---------|-------------|
| `/radio <genre\|name>` | Search Radio Browser — 30k+ global stations, no API key |
| `/radio jazz japan` | Genre + country filter |
| `/radio <http url>` | Play any stream URL directly |
| `/radio lyria` | Lyria RealTime AI generative radio (preset 1) |
| `/radio lyria chill` | Lyria with preset name or custom prompt |
| `/radio lyria <1-9>` | Lyria by preset number |

Radio Browser has 30k+ stations across every genre and country. Top station by votes plays automatically; alternatives listed.

Lyria requires [lyria-cli](https://github.com/arosstale/lyria-cli).

### Production

| Command | Description |
|---------|-------------|
| `/mix <a> <b> [secs]` | Crossfade two audio files |
| `/trim <file> <start> [end]` | Trim a clip |
| `/bpm <file>` | Detect BPM |
| `/render <file\|url> [style]` | Render a music video with ffmpeg |
| `/dj-help` | Show all commands + dependency status |

## Render Styles

`/render` outputs a 1080×1080 MP4 with animated visualizer and title overlay. Pure ffmpeg — no extra dependencies.

![Visualizer styles](assets/visualizers.png)

| Style | ffmpeg filter | Notes |
|-------|--------------|-------|
| `bars` *(default)* | `showspectrum` | Frequency spectrum |
| `wave` | `showwaves` | Waveform |
| `circle` | `avectorscope` | Lissajous / stereo field |
| `cqt` | `showcqt` | Constant-Q transform |

```
/render ~/Music/track.mp3
/render ~/Music/track.mp3 wave
/render https://youtu.be/xxx cqt
```

Output: `~/Music/Videos/<title>_<style>.mp4`

If a URL is passed, yt-dlp downloads first.

## LLM Tools

Two tools the AI can call directly mid-conversation:

| Tool | Description |
|------|-------------|
| `dj_play_music` | Stream a YouTube search or URL |
| `dj_queue_music` | Add a track to the queue |
| `dj_radio` | Search and play global radio — genre, country, Lyria AI, or stream URL |

## Division of Labour

| Extension | Commands |
|-----------|----------|
| `cliamp` | Local files, HTTP streams, Lyria radio — `/play` `/music` `/radio` |
| `pi-djvj` | Terminal visualizer + WebGL shaders — `/viz` `/djvj` |
| `pi-dj` | YouTube, AI, production — everything above |

## Platforms

Windows · macOS · Linux · Raspberry Pi · Termux

## License

MIT
