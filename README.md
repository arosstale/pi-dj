# pi-dj 🎧

AI music production suite for [pi](https://github.com/badlogic/pi-mono).

Stream YouTube, generate AI music with Suno, live-stream Lyria RealTime, download SoundCloud & Bandcamp, mix, trim, BPM — all from the terminal.

## Platforms

| Platform | Status |
|----------|--------|
| Windows (Git Bash / WSL) | ✅ |
| macOS | ✅ |
| Linux | ✅ |
| Raspberry Pi | ✅ |
| Termux (Android) | ✅ |

## Install

```bash
pi install npm:pi-dj
```

### Dependencies by platform

**Windows**
```bash
winget install mpv
pip install yt-dlp
winget install ffmpeg
```

**macOS**
```bash
brew install mpv yt-dlp ffmpeg
```

**Linux / Raspberry Pi**
```bash
sudo apt install mpv ffmpeg -y
pip install yt-dlp
```

**Termux (Android)**
```bash
pkg install mpv ffmpeg python
pip install yt-dlp
# Optional: better SoundCloud downloads
pip install scdl
```

You don't need everything — the extension detects what's installed and degrades gracefully.

## Commands

### Playback
| Command | What it does |
|---------|-------------|
| `/play <query\|path>` | YouTube search, URL, or local file |
| `/pause` | Toggle pause |
| `/stop` | Stop + clear queue |
| `/np` | Now playing + queue count |
| `/vol <0-100>` | Volume |
| `/queue <query>` | Add track to queue |
| `/skip` | Skip to next |

### AI Music
| Command | What it does |
|---------|-------------|
| `/generate <prompt>` | Generate a song with Suno AI |
| `/dj [1-9]` | Stream live AI music with Lyria RealTime |

**Lyria presets:**
`1` Carmack Core · `2` Chill · `3` Hard · `4` Soul Flip · `5` Chaos · `6` Jersey Club · `7` Soulection · `8` Drill · `9` Afrobeats

### Downloads
| Command | What it does |
|---------|-------------|
| `/sc <url>` | SoundCloud (scdl or yt-dlp fallback) |
| `/bandcamp <url>` | Bandcamp (yt-dlp) |

### Production
| Command | What it does |
|---------|-------------|
| `/mix <a> <b> [secs]` | Crossfade two tracks with ffmpeg |
| `/trim <file> <start> [end]` | Trim audio clip (seconds) |
| `/bpm <file>` | Detect BPM (librosa) |
| `/dj-help` | All commands + tool status |

## AI DJ (LLM tools)

pi-dj registers tools the AI can use directly:

- *"play something chill"* → `play_music`
- *"queue 5 ambient tracks"* → `queue_music`

## Config (optional)

Create `~/.pi-dj.json`:

```json
{
  "musicDir": "/path/to/music",
  "sunoApiKey": "your-suno-key",
  "googleApiKey": "your-gemini-key"
}
```

Or env vars: `PI_DJ_MUSIC`, `SUNO_API_KEY`, `GOOGLE_API_KEY`

Default music dirs:
- Windows/macOS/Linux: `~/Music`
- Termux: `~/storage/music`

## How it works

```
yt-dlp "ytsearch:<query>"     →  YouTube URL
mpv --input-ipc-server        →  stream audio (cross-platform)
socat / nc -U (IPC fallback)  →  pause/vol control
SIGSTOP/SIGCONT               →  pause fallback on Termux/RPi
ffmpeg filter_complex         →  mix / trim
Suno API                      →  AI song generation
Lyria RealTime API            →  live AI music stream
scdl / yt-dlp                 →  SoundCloud / Bandcamp
```

## vs pi-amp

| Feature | pi-amp | **pi-dj** |
|---------|--------|-----------|
| YouTube streaming | ✅ | ✅ |
| **Windows** | ❌ | ✅ |
| **macOS** | partial | ✅ |
| **Termux / Android** | ❌ | ✅ |
| **Raspberry Pi** | ❌ | ✅ |
| **AI generation (Suno)** | ❌ | ✅ |
| **AI streaming (Lyria)** | ❌ | ✅ |
| **SoundCloud download** | ❌ | ✅ |
| **Bandcamp download** | ❌ | ✅ |
| **Mix / crossfade** | ❌ | ✅ |
| **Trim** | ❌ | ✅ |
| **BPM detection** | ❌ | ✅ |
| **IPC fallback (nc)** | ❌ | ✅ |
| **Config file** | ❌ | ✅ |
| EQ presets | ✅ PipeWire | planned |
| Status bar | ✅ | ✅ |
| LLM tools | ✅ | ✅ |

## License

MIT
