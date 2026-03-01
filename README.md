# pi-dj 🎧

> The CLI that powers [dj-piguy.com](https://dj-piguy.com) — an AI radio station built entirely inside [pi](https://github.com/badlogic/pi-mono).

Full AI music suite for pi. Generate, stream, sample, download, and publish music — all from your terminal.

## Demo

🎵 **[dj-piguy.com](https://dj-piguy.com)** — 32+ AI-generated tracks, live radio, built with this extension.

## Install

```bash
pi install git:github.com/arosstale/pi-dj
```

### Requirements

- **[cliamp](https://github.com/bjarneo/cliamp)** — Terminal Winamp player
- **scdl** — `uv tool install scdl`
- **yt-dlp** — `uv tool install yt-dlp`
- **Gemini API key** — free at [aistudio.google.com](https://aistudio.google.com/apikey)
- **Suno API key** — [sunoapi.org](https://sunoapi.org)

```bash
export GEMINI_API_KEY="your-key"
export SUNO_API_KEY="your-key"
```

---

## Commands

| Command | What |
|---------|------|
| `/dj [1-9]` | **Lyria RealTime** live AI stream — 9 presets |
| `/spacedj` | **Space DJ** — fly a 3D genre galaxy, Lyria blends sounds live |
| `/generate [prompt]` | **Suno** AI song + auto-play with cliamp |
| `/sample` | Record Lyria stream → MP3 |
| `/music [1-6]` | Browse & play your full music library |
| `/sc [url]` | Download from SoundCloud |
| `/bandcamp [url]` | Download from Bandcamp |
| `/play [path]` | Play any path with cliamp |
| `/dj-status` | Library stats — songs, disk, downloads |

### `/music` libraries

```
1 = SoundCloud (34GB)       ☁️  5600+ liked tracks
2 = SoundCloud overflow      ☁️  extra downloads
3 = Bandcamp (441MB)         🎸  full discographies
4 = Suno AI (115MB)          🤖  your generated songs
5 = 2026 Collection          📀  curated folder
6 = Lyria Samples            🎛️  recorded AI streams
```

---

## Lyria Presets

```
1 = Carmack Core     90 bpm   trap soul, chopped samples, 808s
2 = Chill            75 bpm   lo-fi hip hop, vinyl, mellow
3 = Hard            140 bpm   heavy trap, distorted 808s
4 = Soul Flip        85 bpm   neo soul, jazzy chords, vinyl crackle
5 = Chaos           110 bpm   glitch hop, pitched vocal chops
6 = Jersey Club     140 bpm   fast hi-hats, aggressive kicks
7 = Soulection       88 bpm   future beats, dreamy pads
8 = Drill           145 bpm   dark strings, sliding 808s
9 = Afrobeats       100 bpm   percussion, tropical, rhythmic
```

Inside `/dj`: type **1-9** to switch, **p** pause, **r** resume, **q** quit, or type any custom prompt.

---

## Space DJ

```
/spacedj
```

Fly through a 3D galaxy of genres. Arrow keys move your ship. Lyria blends nearby genres in real-time. Land between Trap and Soul Flip for a Carmack zone. Space = autopilot.

Inspired by [Google Magenta's Space DJ](https://magenta.withgoogle.com/spacedj-announce).

---

## How dj-piguy.com was built

Every track on [dj-piguy.com](https://dj-piguy.com) was generated using pi + Suno:

```
/generate volcanic bassline hip hop beat heavy 808s
→ Suno generates 2 variants
→ cliamp plays them back  
→ pick the best one
→ publish to dj-piguy.com
```

The whole workflow — idea to published track — runs inside pi.

---

## Ecosystem

pi-dj is the **CLI companion** to [OpenVoiceUI](https://github.com/MCERQUA/OpenVoiceUI-public) — a browser-based voice agent platform with animated face, music player, Suno integration, and web canvas display built by [@MetaMikeC](https://github.com/MCERQUA).

| Project | What | By |
|---------|------|----|
| [OpenVoiceUI](https://github.com/MCERQUA/OpenVoiceUI-public) | Web voice interface — animated face, Suno, music player | [@MetaMikeC](https://github.com/MCERQUA) |
| **pi-dj** (this) | CLI version — terminal, Lyria streams, samples, cliamp | [@arosstale](https://github.com/arosstale) |

Both connect to the same AI music generation layer. OpenVoiceUI runs in your browser on a VPS. pi-dj runs in your terminal via pi.

---

## Built on

- [Lyria RealTime](https://ai.google.dev/gemini-api/docs/music-generation) — Google's live music generation
- [Suno](https://suno.com) — AI song generation
- [OpenVoiceUI](https://github.com/MCERQUA/OpenVoiceUI-public) — web voice UI companion
- [cliamp](https://github.com/bjarneo/cliamp) — Terminal Winamp
- [scdl](https://github.com/flyingrub/scdl) — SoundCloud downloader
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — Bandcamp/YouTube downloader
- [Space DJ](https://magenta.withgoogle.com/spacedj-announce) — Google Magenta inspiration

## License

MIT — by [71tick / arosstale](https://dj-piguy.com) | [dj-piguy.com](https://dj-piguy.com)
