/**
 * pi-dj — Full AI Music Suite for pi
 *
 * Commands:
 *   /dj [preset]       — Lyria RealTime live stream (1-9 presets)
 *   /spacedj           — Space DJ terminal galaxy navigator
 *   /generate [prompt] — Suno AI song generation + auto-play
 *   /sample            — record Lyria stream to MP3
 *   /sc [url]          — download from SoundCloud
 *   /bandcamp [url]    — download from Bandcamp
 *   /play [path]       — play local library with cliamp
 *   /dj-status         — check music library status
 *   /dj-help           — show all commands
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const LYRIA_CLI   = "node C:/Users/Artale/Music/lyria-cli/index.js";
const SPACEDJ_CLI = "node C:/Users/Artale/Music/lyria-cli/spacedj.js";
const CLIAMP      = "cliamp.exe";

const SC_PATH      = "E:/Music/SoundCloud";
const BC_PATH      = "E:/Music/Bandcamp";
const SUNO_PATH    = "C:/Users/Artale/Music/Suno";
const SAMPLES_PATH = "C:/Users/Artale/Music/Samples";

const PRESETS: Record<string, { name: string; bpm: number }> = {
  "1": { name: "Carmack Core",  bpm: 90  },
  "2": { name: "Chill",         bpm: 75  },
  "3": { name: "Hard",          bpm: 140 },
  "4": { name: "Soul Flip",     bpm: 85  },
  "5": { name: "Chaos",         bpm: 110 },
  "6": { name: "Jersey Club",   bpm: 140 },
  "7": { name: "Soulection",    bpm: 88  },
  "8": { name: "Drill",         bpm: 145 },
  "9": { name: "Afrobeats",     bpm: 100 },
};

export default function piDj(pi: ExtensionAPI) {

  // /dj — Lyria live stream
  pi.registerCommand("dj", {
    description: "Start Lyria AI music stream. Usage: /dj [1-9] (default: Carmack Core 90bpm)",
    handler: async (args, ctx) => {
      const preset = args?.trim() || "1";
      const p = PRESETS[preset];
      const label = p ? `${p.name} (${p.bpm} bpm)` : preset;
      ctx.ui.notify(`🎵 Starting Lyria: ${label}`, "info");
      pi.sendUserMessage(
        `Launch Lyria live stream: interactive_shell command="${LYRIA_CLI}" mode=interactive reason="Lyria: ${label}". ` +
        `Tell user to type "${preset}" for preset. Keys: 1-9=presets p=pause r=resume q=quit`
      );
    },
  });

  // /spacedj — Space DJ galaxy
  pi.registerCommand("spacedj", {
    description: "Space DJ — fly through a genre galaxy, Lyria blends nearby sounds in real-time",
    handler: async (_args, ctx) => {
      ctx.ui.notify("🚀 Launching Space DJ...", "info");
      pi.sendUserMessage(
        `Launch Space DJ: interactive_shell command="${SPACEDJ_CLI}" mode=interactive reason="🚀 Space DJ Galaxy". ` +
        `Arrow keys=fly, Space=autopilot, q=quit`
      );
    },
  });

  // /generate — Suno
  pi.registerCommand("generate", {
    description: "Generate AI music with Suno. Usage: /generate [description]",
    handler: async (args, ctx) => {
      const prompt = args?.trim() || "Mr Carmack style trap soul beat, chopped samples, 808s, lo-fi";
      ctx.ui.notify(`🎵 Generating: "${prompt}"`, "info");
      pi.sendUserMessage(
        `Generate a Suno song using the suno skill. Prompt: "${prompt}". ` +
        `Steps: 1) Check credits 2) Generate instrumental:true model:V4_5ALL callBackUrl:https://example.com/callback ` +
        `3) Poll until SUCCESS 4) Download both variants to ${SUNO_PATH} ` +
        `5) Play with cliamp.exe`
      );
    },
  });

  // /sample — record Lyria
  pi.registerCommand("sample", {
    description: "Record Lyria AI stream to MP3 file",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`🔴 Recording Lyria → ${SAMPLES_PATH}`, "info");
      pi.sendUserMessage(
        `Help the user record Lyria output to MP3 in ${SAMPLES_PATH}. ` +
        `Create the directory if needed. Run lyria.py and capture system audio with ffmpeg. ` +
        `Save as ${SAMPLES_PATH}/lyria_$(date +%Y%m%d_%H%M%S).mp3`
      );
    },
  });

  // /sc — SoundCloud
  pi.registerCommand("sc", {
    description: "Download from SoundCloud. Usage: /sc [url]",
    handler: async (args, ctx) => {
      const url = args?.trim() || "https://soundcloud.com/71tick/likes";
      ctx.ui.notify(`⬇️ SoundCloud: ${url}`, "info");
      pi.sendUserMessage(
        `Download SoundCloud: ${url}. ` +
        `1) Check disk: df -h /e/ and /c/ ` +
        `2) If E: has space: scdl -l ${url} -c --path "${SC_PATH}" ` +
        `3) If E: full: use C:/Users/Artale/Music/SoundCloud ` +
        `4) Run in background, monitor progress`
      );
    },
  });

  // /bandcamp
  pi.registerCommand("bandcamp", {
    description: "Download from Bandcamp. Usage: /bandcamp [url]",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /bandcamp <url>  e.g. https://mrcarmack.bandcamp.com/music", "warning");
        return;
      }
      const url = args.trim();
      const artist = url.split(".bandcamp.com")[0].replace("https://", "");
      ctx.ui.notify(`⬇️ Bandcamp: ${artist}`, "info");
      pi.sendUserMessage(
        `Download Bandcamp: ${url}. ` +
        `yt-dlp --extract-audio --audio-format mp3 --audio-quality 0 ` +
        `-o "${BC_PATH}/${artist}/%(album)s/%(track_number)s. %(title)s.%(ext)s" ${url} ` +
        `Run in background, report when done.`
      );
    },
  });

  // /play — cliamp
  pi.registerCommand("play", {
    description: "Play music with cliamp. Usage: /play [path]",
    handler: async (args, ctx) => {
      const target = args?.trim() || SC_PATH;
      ctx.ui.notify(`🎵 Playing: ${target}`, "info");
      pi.sendUserMessage(
        `Play music with cliamp for: ${target}. ` +
        `Use interactive_shell command="${CLIAMP} ${target.replace(/\//g, "\\")}" mode=interactive`
      );
    },
  });

  // /dj-status
  pi.registerCommand("dj-status", {
    description: "Check music library — songs, disk space, active downloads",
    handler: async (_args, ctx) => {
      ctx.ui.notify("📊 Checking library...", "info");
      pi.sendUserMessage(
        `Check music library status and report: ` +
        `1) SoundCloud songs: find "/e/Music/SoundCloud/" -type f \\( -name "*.mp3" -o -name "*.m4a" \\) | wc -l ` +
        `2) Disk: df -h /e/ /c/ ` +
        `3) Download log: tail -3 /c/Users/Artale/AppData/Local/Temp/scdl_log.txt ` +
        `4) Suno songs: ls "${SUNO_PATH}" | wc -l ` +
        `5) Bandcamp: find "/e/Music/Bandcamp/" -name "*.mp3" | wc -l`
      );
    },
  });

  // /dj-help
  pi.registerCommand("dj-help", {
    description: "Show all pi-dj commands",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        [
          "🎧 pi-dj commands:",
          "/dj [1-9]       Lyria live AI stream",
          "/spacedj        Space DJ galaxy",
          "/generate [..]  Suno AI song",
          "/sample         Record Lyria → MP3",
          "/sc [url]       SoundCloud download",
          "/bandcamp [url] Bandcamp download",
          "/play [path]    cliamp player",
          "/dj-status      Library check",
        ].join("\n"),
        "info"
      );
    },
  });
}
