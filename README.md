# pi-dj 🎧

Full AI music suite for [pi](https://github.com/badlogic/pi-mono) — way deeper than just YouTube streaming.

![pi-dj](https://dj-piguy.com/covers/hero/ai-jam-reggae.webp)

## What it does

| Command | What |
|---------|------|
| `/dj [1-9]` | **Lyria RealTime** live AI music stream — 9 presets |
| `/spacedj` | **Space DJ** — fly through a 3D genre galaxy, Lyria blends nearby sounds |
| `/generate [prompt]` | **Suno AI** song generation + auto-play with cliamp |
| `/sample` | Record Lyria stream to MP3 |
| `/sc [url]` | Download from **SoundCloud** |
| `/bandcamp [url]` | Download from **Bandcamp** |
| `/play [path]` | Play local library with **cliamp** |
| `/dj-status` | Library stats — songs, disk, active downloads |

## Install

```bash
pi install git:github.com/71tick/pi-dj
```

### Requirements

- **cliamp** — [github.com/bjarneo/cliamp](https://github.com/bjarneo/cliamp) (Terminal Winamp)
- **scdl** — `uv tool install scdl` (SoundCloud downloader)
- **yt-dlp** — `uv tool install yt-dlp` (Bandcamp downloader)
- **Gemini API key** — free at [aistudio.google.com](https://aistudio.google.com/apikey) (for Lyria)
- **Suno API key** — [sunoapi.org](https://sunoapi.org) (for AI generation)

```bash
export GEMINI_API_KEY="your-key"
export SUNO_API_KEY="your-key"
```

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

Inside the stream: type **1-9** to switch presets, **p** pause, **r** resume, **q** quit, or type any custom prompt.

## Space DJ

```
/spacedj
```

Fly through a 3D galaxy of 20+ genres. Arrow keys move your ship. Lyria blends the nearby genres in real-time — land between Trap and Soul Flip for a Carmack zone, drift toward Ambient for chill mode.

Space = autopilot (random drift), q = quit.

## Examples

```
/dj 1                              # Stream Carmack Core
/dj                                # Same (default)
/generate carmack trap soul beat   # Make a Suno track
/sc https://soundcloud.com/71tick/likes   # Download your likes
/bandcamp https://mrcarmack.bandcamp.com/music
/play E:\Music\SoundCloud          # Play your library
/dj-status                         # Check everything
```

## Built on

- [Lyria RealTime](https://ai.google.dev/gemini-api/docs/music-generation) — Google's live music generation API
- [Suno](https://suno.com) — AI song generation
- [cliamp](https://github.com/bjarneo/cliamp) — Terminal Winamp player
- [scdl](https://github.com/flyingrub/scdl) — SoundCloud downloader
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — Bandcamp/YouTube downloader
- [Space DJ](https://magenta.withgoogle.com/spacedj-announce) — Inspired by Google Magenta's Space DJ

## License

MIT — by [71tick](https://dj-piguy.com)
