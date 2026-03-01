/**
 * pi-dj — AI Music Production Suite for pi
 *
 * Part of the OpenVoiceUI ecosystem:
 *   Web UI  → https://github.com/MCERQUA/OpenVoiceUI-public  (@MetaMikeC)
 *   CLI/pi  → https://github.com/arosstale/pi-dj             (@arosstale)
 *
 * Commands:
 *   /dj [1-9]          — Lyria RealTime live AI stream (auto-records MP3)
 *   /generate [prompt] — Suno AI song generation + cliamp playback
 *   /music [1-6]       — Browse & play your music libraries
 *   /play [path]       — Play any file/folder with cliamp
 *   /viz               — Terminal audio visualizer (cava)
 *   /video [mp3]       — Render Remotion music video
 *   /sc [url]          — Download from SoundCloud
 *   /bandcamp [url]    — Download from Bandcamp
 *   /mix [a] [b]       — Crossfade two tracks with ffmpeg
 *   /trim [mp3] [s] [e]— Trim audio clip (start/end seconds)
 *   /bpm [mp3]         — Detect BPM of a track
 *   /dj-status         — Library stats
 *   /dj-help           — All commands
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── Paths ──────────────────────────────────────────────────────────────────
const LYRIA_CLI    = "C:/Users/Artale/Music/lyria-cli/index.js";
const REMOTION_CLI = "C:/Users/Artale/Projects/pi-dj/remotion/render.mjs";
const LYRIA_DIR    = "C:/Users/Artale/Music/Lyria";
const SUNO_DIR     = "C:/Users/Artale/Music/Suno";
const VIDEOS_DIR   = "C:/Users/Artale/Music/Videos";

const LIBRARIES: Record<string, { path: string; label: string; emoji: string }> = {
  "1": { path: "E:/Music/SoundCloud",               label: "SoundCloud (34GB)",       emoji: "☁️" },
  "2": { path: "C:/Users/Artale/Music/SoundCloud",  label: "SoundCloud overflow",      emoji: "☁️" },
  "3": { path: "E:/Music/Bandcamp",                 label: "Bandcamp (441MB)",         emoji: "🎸" },
  "4": { path: "C:/Users/Artale/Music/Suno",        label: "Suno AI",                  emoji: "🤖" },
  "5": { path: "C:/Users/Artale/Music/Music/2026",  label: "2026 Collection",          emoji: "📀" },
  "6": { path: "C:/Users/Artale/Music/Lyria",       label: "Lyria Recordings",         emoji: "🎛️" },
};

const PRESETS: Record<string, { name: string; bpm: number }> = {
  "1": { name: "Carmack Core",     bpm: 90  },
  "2": { name: "Chill",            bpm: 75  },
  "3": { name: "Hard",             bpm: 140 },
  "4": { name: "Soul Flip",        bpm: 85  },
  "5": { name: "Chaos",            bpm: 110 },
  "6": { name: "Jersey Club",      bpm: 140 },
  "7": { name: "Soulection",       bpm: 88  },
  "8": { name: "Drill",            bpm: 145 },
  "9": { name: "Afrobeats",        bpm: 100 },
};

export default function piDj(pi: ExtensionAPI) {

  // /dj — Lyria RealTime stream (auto-records MP3)
  pi.registerCommand("dj", {
    description: "Start Lyria RealTime AI music stream. Auto-records to MP3. Usage: /dj [1-9 preset]",
    handler: async (args, ctx) => {
      const preset = args?.trim();
      const presetInfo = PRESETS[preset || "1"];
      ctx.ui.notify(`🎛️ Starting Lyria — ${presetInfo?.name || "custom"} — auto-recording to ${LYRIA_DIR}`, "info");
      pi.sendUserMessage(
        `Start the Lyria CLI stream in an interactive terminal. Run: node "${LYRIA_CLI}" ` +
        `Use interactive_shell in interactive mode so I can control it. ` +
        `${preset ? `Once connected type "${preset}" to switch to the ${presetInfo?.name} preset.` : ""} ` +
        `Remind me: [s] saves a sample, [q] quits and saves the full session to ${LYRIA_DIR}`
      );
    },
  });

  // /generate — Suno song generation
  pi.registerCommand("generate", {
    description: "Generate an AI song with Suno. Usage: /generate [prompt]",
    handler: async (args, ctx) => {
      const prompt = args?.trim() || "lo-fi hip hop trap soul beat, 808s, vinyl texture";
      ctx.ui.notify(`🤖 Generating: "${prompt}"`, "info");
      pi.sendUserMessage(
        `Generate a Suno AI song using the Python script at C:/Users/Artale/Music/lyria.py. ` +
        `Prompt: "${prompt}". ` +
        `Run the script, poll until complete, download the MP3 to ${SUNO_DIR}, ` +
        `then play it with: cmd.exe /c start "" "path\\to\\track.mp3"`
      );
    },
  });

  // /music — browse and play libraries
  pi.registerCommand("music", {
    description: "Browse and play your music libraries. Usage: /music [1-6]",
    handler: async (args, ctx) => {
      const choice = args?.trim();
      if (choice && LIBRARIES[choice]) {
        const lib = LIBRARIES[choice];
        ctx.ui.notify(`${lib.emoji} Playing: ${lib.label}`, "info");
        pi.sendUserMessage(
          `Play the music library at "${lib.path}" using cliamp. ` +
          `Run: cmd.exe /c start "" cliamp.exe "${lib.path}" in interactive_shell mode so I can control playback.`
        );
      } else {
        const list = Object.entries(LIBRARIES)
          .map(([k, v]) => `  ${k} = ${v.emoji} ${v.label}`)
          .join("\n");
        ctx.ui.notify(`🎵 Music Libraries:\n${list}`, "info");
        pi.sendUserMessage(
          `Show the user their music libraries and ask which to play:\n${list}\n` +
          `Then run /music [number] for their choice.`
        );
      }
    },
  });

  // /play — play any path
  pi.registerCommand("play", {
    description: "Play any file or folder with cliamp. Usage: /play [path]",
    handler: async (args, ctx) => {
      const path = args?.trim();
      if (!path) {
        ctx.ui.notify("Usage: /play [path to file or folder]", "warning");
        return;
      }
      pi.sendUserMessage(
        `Play "${path}" using cliamp in interactive_shell interactive mode. ` +
        `Run: cmd.exe /c start "" cliamp.exe "${path}"`
      );
    },
  });

  // /viz — terminal audio visualizer
  pi.registerCommand("viz", {
    description: "Terminal audio visualizer using cava or ffplay spectrum",
    handler: async (args, ctx) => {
      const file = args?.trim();
      ctx.ui.notify("🎨 Starting terminal visualizer...", "info");
      pi.sendUserMessage(
        file
          ? `Show a terminal audio visualization for "${file}". ` +
            `Use ffplay with spectrum display: ` +
            `ffplay -f lavfi "amovie='${file}',asplit[a][out0];[a]avectorscope=s=800x400[out1]" ` +
            `or use: ffplay -showmode 1 "${file}" for a simple waveform/spectrum view. ` +
            `Open in a new window with cmd.exe /c start ""`
          : `Check if cava is installed (cava --version). If yes, run it in interactive_shell. ` +
            `If not, tell the user to install it from https://github.com/karlstav/cava ` +
            `or use ffplay spectrum on a specific file with /viz [path]`
      );
    },
  });

  // /video — render Remotion music video
  pi.registerCommand("video", {
    description: "Render an animated music video. Usage: /video [mp3] [title] [artist] [genre]",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(" ") || [];
      const audio  = parts[0] || "";
      const title  = parts[1] || "Untitled";
      const artist = parts[2] || "71tick";
      const genre  = parts[3] || "Trap Soul";
      const out    = `${VIDEOS_DIR}/${title.replace(/\s+/g, "_")}.mp4`;

      if (!audio) {
        ctx.ui.notify("Usage: /video [mp3 path] [title] [artist] [genre]", "warning");
        return;
      }

      ctx.ui.notify(`🎬 Rendering: "${title}" by ${artist}`, "info");
      pi.sendUserMessage(
        `Render a Remotion music video. Run this command:\n` +
        `node "${REMOTION_CLI}" --audio "${audio}" --title "${title}" --artist "${artist}" ` +
        `--genre "${genre}" --out "${out}" --dur 30\n` +
        `Show progress. When done, open the video: cmd.exe /c start "" "${out}"`
      );
    },
  });

  // /sc — SoundCloud download
  pi.registerCommand("sc", {
    description: "Download from SoundCloud. Usage: /sc [url]",
    handler: async (args, ctx) => {
      const url = args?.trim();
      if (!url) {
        ctx.ui.notify("Usage: /sc [soundcloud url]", "warning");
        return;
      }
      ctx.ui.notify(`☁️ Downloading from SoundCloud...`, "info");
      pi.sendUserMessage(
        `Download this SoundCloud URL: ${url}\n` +
        `Run: scdl -l "${url}" --path "E:/Music/SoundCloud" --mp3 --onlymp3\n` +
        `If E: drive is full, use: C:/Users/Artale/Music/SoundCloud instead.`
      );
    },
  });

  // /bandcamp — Bandcamp download
  pi.registerCommand("bandcamp", {
    description: "Download from Bandcamp. Usage: /bandcamp [url]",
    handler: async (args, ctx) => {
      const url = args?.trim();
      if (!url) {
        ctx.ui.notify("Usage: /bandcamp [url]", "warning");
        return;
      }
      ctx.ui.notify(`🎸 Downloading from Bandcamp...`, "info");
      pi.sendUserMessage(
        `Download this Bandcamp URL: ${url}\n` +
        `Run: yt-dlp --extract-audio --audio-format mp3 --audio-quality 0 ` +
        `-o "E:/Music/Bandcamp/%(artist)s/%(album)s/%(track_number)s - %(title)s.%(ext)s" "${url}"\n` +
        `Show what was downloaded when done.`
      );
    },
  });

  // /mix — crossfade two tracks
  pi.registerCommand("mix", {
    description: "Crossfade two audio tracks with ffmpeg. Usage: /mix [track-a] [track-b] [crossfade-seconds]",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(" ") || [];
      const trackA = parts[0];
      const trackB = parts[1];
      const xfade  = parts[2] || "4";

      if (!trackA || !trackB) {
        ctx.ui.notify("Usage: /mix [track-a.mp3] [track-b.mp3] [crossfade-secs]", "warning");
        return;
      }

      const outName = `mix_${Date.now()}.mp3`;
      const outPath = `${LYRIA_DIR}/${outName}`;
      ctx.ui.notify(`🎚️ Crossfading ${xfade}s between tracks...`, "info");
      pi.sendUserMessage(
        `Mix two audio tracks with a ${xfade}s crossfade using ffmpeg.\n` +
        `Track A: "${trackA}"\nTrack B: "${trackB}"\n` +
        `Run:\nffmpeg -i "${trackA}" -i "${trackB}" ` +
        `-filter_complex "[0][1]acrossfade=d=${xfade}:c1=tri:c2=tri[out]" ` +
        `-map "[out]" "${outPath}"\n` +
        `When done, play it: cmd.exe /c start "" "${outPath}"`
      );
    },
  });

  // /trim — trim audio clip
  pi.registerCommand("trim", {
    description: "Trim an audio clip. Usage: /trim [file] [start-sec] [end-sec]",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(" ") || [];
      const file  = parts[0];
      const start = parts[1] || "0";
      const end   = parts[2];

      if (!file) {
        ctx.ui.notify("Usage: /trim [file.mp3] [start] [end] (seconds)", "warning");
        return;
      }

      const outName = `trim_${start}s_${Date.now()}.mp3`;
      const outPath = `${LYRIA_DIR}/${outName}`;
      const duration = end ? `-to ${end}` : "";
      ctx.ui.notify(`✂️ Trimming from ${start}s${end ? ` to ${end}s` : ""}...`, "info");
      pi.sendUserMessage(
        `Trim the audio file "${file}" from ${start}s${end ? ` to ${end}s` : " to end"}.\n` +
        `Run: ffmpeg -i "${file}" -ss ${start} ${duration} -c copy "${outPath}"\n` +
        `When done, show the file size and play it.`
      );
    },
  });

  // /bpm — detect BPM
  pi.registerCommand("bpm", {
    description: "Detect BPM of a track. Usage: /bpm [file]",
    handler: async (args, ctx) => {
      const file = args?.trim();
      if (!file) {
        ctx.ui.notify("Usage: /bpm [file.mp3]", "warning");
        return;
      }
      ctx.ui.notify(`🥁 Detecting BPM for: ${file}`, "info");
      pi.sendUserMessage(
        `Detect the BPM of "${file}".\n` +
        `Try these in order:\n` +
        `1. If bpm-tools installed: sox "${file}" -t raw -r 44100 -e float -c 1 - | bpm\n` +
        `2. If librosa available: python3 -c "import librosa; y,sr=librosa.load('${file}'); tempo,_=librosa.beat.beat_track(y=y,sr=sr); print(f'BPM: {tempo:.1f}')"\n` +
        `3. Otherwise estimate from ffprobe metadata: ffprobe -v quiet -print_format json -show_format "${file}"\n` +
        `Report the BPM clearly.`
      );
    },
  });

  // /dj-status — library stats
  pi.registerCommand("dj-status", {
    description: "Show music library stats",
    handler: async (args, ctx) => {
      pi.sendUserMessage(
        `Show music library stats. Run these commands and summarize:\n` +
        `echo "=== Lyria Recordings ===" && ls -lh "${LYRIA_DIR}" 2>/dev/null | tail -20\n` +
        `echo "=== Suno AI ===" && ls "${SUNO_DIR}" 2>/dev/null | grep ".mp3" | wc -l\n` +
        `echo "=== Videos ===" && ls -lh "${VIDEOS_DIR}" 2>/dev/null\n` +
        `echo "=== SoundCloud ===" && du -sh "E:/Music/SoundCloud" 2>/dev/null\n` +
        `echo "=== Bandcamp ===" && du -sh "E:/Music/Bandcamp" 2>/dev/null\n` +
        `Format as a clean summary table.`
      );
    },
  });

  // /dj-help — all commands
  pi.registerCommand("dj-help", {
    description: "Show all pi-dj commands",
    handler: async (args, ctx) => {
      ctx.ui.notify(
        `🎧 pi-dj commands:\n` +
        `/dj [1-9]      — Lyria stream (auto-records)\n` +
        `/generate      — Suno AI song\n` +
        `/music [1-6]   — Browse libraries\n` +
        `/play [path]   — Play with cliamp\n` +
        `/viz [file]    — Terminal visualizer\n` +
        `/video [mp3]   — Render music video\n` +
        `/sc [url]      — SoundCloud download\n` +
        `/bandcamp [url]— Bandcamp download\n` +
        `/mix [a] [b]   — Crossfade tracks\n` +
        `/trim [f] [s] [e]— Trim audio\n` +
        `/bpm [file]    — Detect BPM\n` +
        `/dj-status     — Library stats`,
        "info"
      );
    },
  });
}
