/**
 * pi-dj — AI Music Production Suite for pi
 *
 * Works on: Windows · macOS · Linux · Raspberry Pi · Termux (Android)
 *
 * Install deps:
 *   Windows:  winget install mpv; pip install yt-dlp
 *   macOS:    brew install mpv yt-dlp ffmpeg
 *   Linux/Pi: apt install mpv ffmpeg; pip install yt-dlp
 *   Termux:   pkg install mpv ffmpeg python; pip install yt-dlp
 *
 * Commands:
 *   /play <query|path>   — YouTube search or local file
 *   /pause               — Toggle pause
 *   /stop                — Stop playback
 *   /np                  — Now playing
 *   /vol <0-100>         — Volume
 *   /queue <query>       — Queue a track
 *   /skip                — Skip track
 *   /generate <prompt>   — Suno AI song generation
 *   /dj [1-9]            — Lyria RealTime AI stream
 *   /sc <url>            — SoundCloud download
 *   /bandcamp <url>      — Bandcamp download
 *   /mix <a> <b> [s]     — Crossfade two tracks
 *   /trim <f> <s> [e]    — Trim audio clip
 *   /bpm <file>          — Detect BPM
 *   /dj-help             — All commands + tool status
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

// ── Platform ────────────────────────────────────────────────────────────────
const OS      = platform(); // win32 | darwin | linux | android
const IS_WIN  = OS === "win32";
const IS_MAC  = OS === "darwin";

// Termux detection: Linux but inside Android
const IS_TERMUX = !IS_WIN && existsSync("/data/data/com.termux");
const IS_RPI    = !IS_WIN && !IS_MAC && !IS_TERMUX &&
                  (existsSync("/proc/device-tree/model") &&
                   (() => { try { return readFileSync("/proc/device-tree/model","utf-8").includes("Raspberry"); } catch { return false; }})());

const HOME    = homedir();
const TMP     = IS_TERMUX ? "/data/data/com.termux/files/usr/tmp" : tmpdir();
const IPC_SOCK = IS_WIN ? null : join(TMP, "mpv-pi-dj.sock");

// ── Config (~/.pi-dj.json) ───────────────────────────────────────────────
interface DjConfig {
  musicDir?: string;
  sunoApiKey?: string;
  googleApiKey?: string;
}

function loadConfig(): DjConfig {
  const cfgPath = process.env.PI_DJ_CONFIG || join(HOME, ".pi-dj.json");
  if (existsSync(cfgPath)) {
    try { return JSON.parse(readFileSync(cfgPath, "utf-8")); } catch {}
  }
  return {};
}

function getMusicDir(cfg: DjConfig): string {
  return cfg.musicDir
    || process.env.PI_DJ_MUSIC
    || (IS_TERMUX ? join(HOME, "storage/music") : join(HOME, "Music"));
}

// ── Tool detection ───────────────────────────────────────────────────────
function which(cmd: string): string | null {
  try {
    const r = execSync(
      IS_WIN ? `where "${cmd}" 2>nul` : `command -v "${cmd}" 2>/dev/null`,
      { encoding: "utf-8", stdio: ["ignore","pipe","ignore"], timeout: 3000 }
    ).trim().split(/\r?\n/)[0].trim();
    return r || null;
  } catch { return null; }
}

interface Tools {
  mpv: string | null;
  ytdlp: string | null;
  ffmpeg: string | null;
  scdl: string | null;
  python: string | null;
  socat: string | null;
  nc: string | null;   // netcat — fallback IPC on Termux/RPi
}

function detectTools(): Tools {
  return {
    mpv:    which("mpv"),
    ytdlp:  which("yt-dlp"),
    ffmpeg: which("ffmpeg"),
    scdl:   which("scdl"),
    python: which("python3") || which("python"),
    socat:  which("socat"),
    nc:     which("nc") || which("ncat"),
  };
}

function installHint(): string {
  if (IS_TERMUX) return "pkg install mpv ffmpeg python; pip install yt-dlp";
  if (IS_WIN)    return "winget install mpv; pip install yt-dlp; winget install ffmpeg";
  if (IS_MAC)    return "brew install mpv yt-dlp ffmpeg";
  if (IS_RPI)    return "sudo apt install mpv ffmpeg -y; pip install yt-dlp";
  return "apt install mpv ffmpeg; pip install yt-dlp";
}

// ── mpv playback state ────────────────────────────────────────────────────
let mpvProcess: ChildProcess | null = null;
let mpvPid: number | null = null;
let currentTrack   = { title: "", url: "" };
let isPlaying      = false;
let isPaused       = false;
let trackQueue: { title: string; url: string }[] = [];
let statusCtx: any = null;
let tools: Tools;
let cfg: DjConfig;
let musicDir: string;

// ── mpv IPC (best-effort: works with socat/nc, skipped on Windows) ─────────
function mpvSend(cmd: Record<string, any>): void {
  if (!IPC_SOCK || !existsSync(IPC_SOCK)) return;
  const json = JSON.stringify(cmd);
  try {
    if (tools.socat) {
      execSync(`printf '%s\\n' '${json}' | socat - "${IPC_SOCK}" 2>/dev/null`,
        { timeout: 1500, stdio: "ignore" });
    } else if (tools.nc) {
      // Termux/RPi fallback: nc with unix socket
      execSync(`printf '%s\\n' '${json}' | nc -U "${IPC_SOCK}" 2>/dev/null`,
        { timeout: 1500, stdio: "ignore" });
    }
  } catch {}
}

function mpvQuery(prop: string): string | null {
  if (!IPC_SOCK || !existsSync(IPC_SOCK)) return null;
  const cmd = JSON.stringify({ command: ["get_property", prop] });
  try {
    let out = "";
    if (tools.socat) {
      out = execSync(`printf '%s\\n' '${cmd}' | socat - "${IPC_SOCK}" 2>/dev/null`,
        { timeout: 1500, encoding: "utf-8" }).trim();
    } else if (tools.nc) {
      out = execSync(`printf '%s\\n' '${cmd}' | nc -U "${IPC_SOCK}" 2>/dev/null`,
        { timeout: 1500, encoding: "utf-8" }).trim();
    }
    if (!out) return null;
    const parsed = JSON.parse(out.split("\n")[0]);
    return parsed.data != null ? String(parsed.data) : null;
  } catch { return null; }
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

// ── Status bar ────────────────────────────────────────────────────────────
function updateStatus() {
  if (!statusCtx) return;
  const theme = statusCtx.ui.theme;
  if (!isPlaying || !currentTrack.title) {
    statusCtx.ui.setStatus("pi-dj", theme.fg("dim", "🎵 stopped"));
    return;
  }
  const pos = mpvQuery("time-pos");
  const dur = mpvQuery("duration");
  const paused = isPaused || mpvQuery("pause") === "true";
  const icon  = paused ? "⏸" : "▶";
  const color = paused ? "warning" : "success";
  let title = currentTrack.title;
  if (title.length > 45) title = title.slice(0, 42) + "...";
  const time = (pos && dur) ? theme.fg("dim", ` ${fmt(+pos)}/${fmt(+dur)}`) : "";
  const q    = trackQueue.length ? theme.fg("muted", ` [+${trackQueue.length}]`) : "";
  statusCtx.ui.setStatus("pi-dj",
    theme.fg(color, icon) + " " + theme.fg("text", title) + time + q);
}

// ── Kill mpv ───────────────────────────────────────────────────────────────
function killMpv() {
  if (mpvProcess) {
    try { mpvProcess.kill("SIGTERM"); } catch {}
    mpvProcess = null;
  }
  mpvPid = null;
  isPlaying = false;
  isPaused  = false;
  currentTrack = { title: "", url: "" };
}

// ── Find yt-dlp ────────────────────────────────────────────────────────────
function ytdlpBin(): string {
  if (tools?.ytdlp) return tools.ytdlp;
  // common pip locations
  const candidates = IS_WIN
    ? [`${HOME}\\AppData\\Local\\Programs\\Python\\Python311\\Scripts\\yt-dlp.exe`,
       `${HOME}\\AppData\\Roaming\\Python\\Python311\\Scripts\\yt-dlp.exe`]
    : IS_TERMUX
    ? [join(HOME, ".local/bin/yt-dlp"), "/data/data/com.termux/files/usr/bin/yt-dlp"]
    : ["/usr/local/bin/yt-dlp", `${HOME}/.local/bin/yt-dlp`];
  for (const c of candidates) if (existsSync(c)) return c;
  return "yt-dlp";
}

// ── Resolve track (YouTube search or URL) ─────────────────────────────────
async function resolveTrack(query: string): Promise<{ title: string; url: string } | null> {
  const bin = ytdlpBin();
  const isUrl = /^https?:\/\//.test(query);
  const arg = isUrl ? `"${query}"` : `"ytsearch:${query.replace(/"/g, '\\"')}"`;
  try {
    const out = execSync(
      `${bin} ${arg} --print title --print webpage_url --no-playlist 2>/dev/null`,
      { encoding: "utf-8", timeout: 20000 }
    ).trim().split(/\r?\n/);
    return out[1] ? { title: out[0] || query, url: out[1] } : null;
  } catch { return null; }
}

// ── Play a URL/path with mpv ───────────────────────────────────────────────
async function playTrack(url: string, title?: string): Promise<string> {
  killMpv();

  // Resolve title if not given
  if (!title) {
    try {
      title = execSync(
        `${ytdlpBin()} --print title "${url}" --no-playlist 2>/dev/null`,
        { encoding: "utf-8", timeout: 10000 }
      ).trim() || url;
    } catch { title = url; }
  }

  currentTrack = { title, url };

  const mpvArgs = [
    "--no-video",
    "--really-quiet",
    "--ytdl-format=bestaudio/best",
  ];

  // IPC: use socket on non-Windows if socat or nc available
  const useIpc = !IS_WIN && IPC_SOCK && (tools.socat || tools.nc);
  if (useIpc) mpvArgs.push(`--input-ipc-server=${IPC_SOCK}`);

  // Volume control via mpv flags on Termux (lower latency)
  if (IS_TERMUX) mpvArgs.push("--ao=opensles");

  mpvArgs.push(url);

  mpvProcess = spawn("mpv", mpvArgs, {
    stdio: "ignore",
    detached: true,
    ...(IS_WIN ? { shell: true } : {}),
  });
  mpvPid = mpvProcess.pid ?? null;
  mpvProcess.unref();
  isPlaying = true;
  isPaused  = false;

  mpvProcess.on("exit", () => {
    isPlaying = false;
    mpvProcess = null;
    mpvPid = null;
    if (trackQueue.length > 0) {
      const next = trackQueue.shift()!;
      playTrack(next.url, next.title);
    } else {
      updateStatus();
    }
  });

  // Wait for IPC socket to appear
  if (useIpc) {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 300));
      if (existsSync(IPC_SOCK!)) break;
    }
  }

  updateStatus();
  return title;
}

// ── Open with system default player (fallback when mpv missing) ────────────
function openSystemPlayer(path: string): void {
  try {
    if (IS_WIN)       execSync(`cmd.exe /c start "" "${path}"`, { stdio: "ignore" });
    else if (IS_MAC)  execSync(`open "${path}"`, { stdio: "ignore" });
    else if (IS_TERMUX) execSync(`am start --user 0 -a android.intent.action.VIEW -d "file://${path}" -t audio/* 2>/dev/null`, { stdio: "ignore" });
    else              execSync(`xdg-open "${path}" 2>/dev/null &`, { stdio: "ignore" });
  } catch {}
}

// ── Lyria presets ──────────────────────────────────────────────────────────
const PRESETS: Record<string, { name: string; bpm: number; style: string }> = {
  "1": { name: "Carmack Core",  bpm: 90,  style: "dark ambient trap soul" },
  "2": { name: "Chill",         bpm: 75,  style: "lo-fi hip hop chill beats" },
  "3": { name: "Hard",          bpm: 140, style: "hard drum and bass" },
  "4": { name: "Soul Flip",     bpm: 85,  style: "neo-soul sample flip" },
  "5": { name: "Chaos",         bpm: 110, style: "experimental glitch noise" },
  "6": { name: "Jersey Club",   bpm: 140, style: "jersey club bounce" },
  "7": { name: "Soulection",    bpm: 88,  style: "future beats soulection" },
  "8": { name: "Drill",         bpm: 145, style: "uk drill dark" },
  "9": { name: "Afrobeats",     bpm: 100, style: "afrobeats dancehall" },
};

// ── Extension ─────────────────────────────────────────────────────────────
export default function piDj(pi: ExtensionAPI) {
  let statusInterval: ReturnType<typeof setInterval> | null = null;

  pi.on("session_start", async (_event, ctx) => {
    statusCtx = ctx;
    cfg       = loadConfig();
    tools     = detectTools();
    musicDir  = getMusicDir(cfg);

    // Create output dirs
    for (const sub of ["Lyria", "Suno", "Videos", "SoundCloud", "Bandcamp"]) {
      try { mkdirSync(join(musicDir, sub), { recursive: true }); } catch {}
    }

    updateStatus();
    if (statusInterval) clearInterval(statusInterval);
    statusInterval = setInterval(updateStatus, 3000);
  });

  pi.on("session_shutdown", async () => {
    if (statusInterval) clearInterval(statusInterval);
    killMpv();
  });

  // ── /play ──────────────────────────────────────────────────────────────
  pi.registerCommand("play", {
    description: "Play music — YouTube search, URL, or local file. /play <query|path>",
    handler: async (args, ctx) => {
      const query = args?.trim();

      // No args = toggle pause
      if (!query) {
        if (isPlaying && (tools.socat || tools.nc)) {
          mpvSend({ command: ["cycle", "pause"] });
          isPaused = !isPaused;
          updateStatus();
        } else {
          ctx.ui.notify("Usage: /play <search query, URL, or file path>", "info");
        }
        return;
      }

      if (!tools.mpv) {
        ctx.ui.notify(`mpv not found. Install: ${installHint()}`, "warning");
        // Try to open local files with system player anyway
        if (existsSync(query)) { openSystemPlayer(query); return; }
        return;
      }

      // Local file?
      const isLocalFile = existsSync(query);
      if (isLocalFile) {
        ctx.ui.notify(`▶ ${query}`, "info");
        await playTrack(query);
        ctx.ui.notify(`▶ ${currentTrack.title}`, "success");
        return;
      }

      // YouTube / URL
      if (!tools.ytdlp) {
        ctx.ui.notify(`yt-dlp not found. Install: pip install yt-dlp`, "warning");
        return;
      }

      ctx.ui.notify(`🔍 ${query}...`, "info");
      const track = await resolveTrack(query);
      if (!track) { ctx.ui.notify(`No results for: ${query}`, "warning"); return; }
      await playTrack(track.url, track.title);
      ctx.ui.notify(`▶ ${currentTrack.title}`, "success");
    },
  });

  // ── /pause ─────────────────────────────────────────────────────────────
  pi.registerCommand("pause", {
    description: "Toggle pause",
    handler: async (_args, ctx) => {
      if (!isPlaying) { ctx.ui.notify("Nothing playing", "info"); return; }
      if (tools.socat || tools.nc) {
        mpvSend({ command: ["cycle", "pause"] });
        isPaused = !isPaused;
      } else if (mpvPid) {
        // SIGSTOP/SIGCONT fallback (Linux/RPi/Termux)
        try {
          process.kill(mpvPid, isPaused ? "SIGCONT" : "SIGSTOP");
          isPaused = !isPaused;
        } catch {}
      }
      ctx.ui.notify(isPaused ? "⏸ Paused" : "▶ Playing", "info");
      updateStatus();
    },
  });

  // ── /stop ──────────────────────────────────────────────────────────────
  pi.registerCommand("stop", {
    description: "Stop playback and clear queue",
    handler: async (_args, ctx) => {
      trackQueue.length = 0;
      killMpv();
      updateStatus();
      ctx.ui.notify("⏹ Stopped", "info");
    },
  });

  // ── /np ────────────────────────────────────────────────────────────────
  pi.registerCommand("np", {
    description: "Show now playing",
    handler: async (_args, ctx) => {
      if (!isPlaying) { ctx.ui.notify("Nothing playing", "info"); return; }
      const pos = mpvQuery("time-pos");
      const dur = mpvQuery("duration");
      let msg = `▶ ${currentTrack.title}`;
      if (pos && dur) msg += ` [${fmt(+pos)} / ${fmt(+dur)}]`;
      if (trackQueue.length) msg += `\nQueue: ${trackQueue.length} tracks`;
      ctx.ui.notify(msg, "info");
    },
  });

  // ── /vol ───────────────────────────────────────────────────────────────
  pi.registerCommand("vol", {
    description: "Set volume 0-100. Usage: /vol 75",
    handler: async (args, ctx) => {
      const vol = parseInt(args?.trim() ?? "");
      if (isNaN(vol) || vol < 0 || vol > 100) {
        ctx.ui.notify("Usage: /vol <0-100>", "info"); return;
      }
      mpvSend({ command: ["set_property", "volume", vol] });
      ctx.ui.notify(`🔊 ${vol}%`, "info");
    },
  });

  // ── /queue ─────────────────────────────────────────────────────────────
  pi.registerCommand("queue", {
    description: "Queue a track. Usage: /queue <search query|URL>",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        if (!trackQueue.length) { ctx.ui.notify("Queue empty", "info"); return; }
        ctx.ui.notify(
          `Queue (${trackQueue.length}):\n` + trackQueue.map((t, i) => `${i + 1}. ${t.title}`).join("\n"),
          "info"
        );
        return;
      }
      if (!tools.ytdlp) { ctx.ui.notify("yt-dlp required for queuing", "warning"); return; }
      ctx.ui.notify(`🔍 ${args.trim()}...`, "info");
      const track = await resolveTrack(args.trim());
      if (!track) { ctx.ui.notify("Not found", "warning"); return; }
      if (!isPlaying && tools.mpv) {
        await playTrack(track.url, track.title);
        ctx.ui.notify(`▶ ${track.title}`, "success");
      } else {
        trackQueue.push(track);
        ctx.ui.notify(`➕ Queued #${trackQueue.length}: ${track.title}`, "success");
      }
    },
  });

  // ── /skip ──────────────────────────────────────────────────────────────
  pi.registerCommand("skip", {
    description: "Skip to next queued track",
    handler: async (_args, ctx) => {
      if (!trackQueue.length) {
        killMpv(); updateStatus();
        ctx.ui.notify("Queue empty — stopped", "info"); return;
      }
      killMpv();
      const next = trackQueue.shift()!;
      await playTrack(next.url, next.title);
      ctx.ui.notify(`⏭ ${next.title} (${trackQueue.length} left)`, "success");
    },
  });

  // ── /generate — Suno AI ────────────────────────────────────────────────
  pi.registerCommand("generate", {
    description: "Generate an AI song with Suno. Usage: /generate <prompt>",
    handler: async (args, ctx) => {
      const prompt = args?.trim() || "lo-fi hip hop trap soul beat, 808s, vinyl texture";
      const key = cfg.sunoApiKey || process.env.SUNO_API_KEY;
      const outDir = join(musicDir, "Suno");
      ctx.ui.notify(`🤖 Generating: "${prompt}"`, "info");
      if (!key) ctx.ui.notify("Tip: set SUNO_API_KEY or add sunoApiKey to ~/.pi-dj.json", "warning");
      pi.sendUserMessage(
        `Generate a Suno AI song.\n` +
        `Prompt: "${prompt}"\n` +
        `SUNO_API_KEY: ${key ? "(set)" : "(missing — ask user to set it)"}\n` +
        `Output: ${outDir}\n\n` +
        `Steps:\n` +
        `1. POST https://api.suno.ai/api/generate\n` +
        `   Body: {"prompt":"${prompt}","mv":"chirp-v3-5","make_instrumental":false}\n` +
        `   Header: Authorization: Bearer $SUNO_API_KEY\n` +
        `2. GET https://api.suno.ai/api/feed?ids=<id> until status="complete"\n` +
        `3. Download audio_url to ${outDir}/<title>.mp3\n` +
        `4. Play the file.\n\n` +
        `Use curl or python requests. Show progress.`
      );
    },
  });

  // ── /dj — Lyria RealTime ───────────────────────────────────────────────
  pi.registerCommand("dj", {
    description: "Start Lyria RealTime AI music stream. Usage: /dj [1-9]",
    handler: async (args, ctx) => {
      const num = args?.trim() || "1";
      const p = PRESETS[num] || PRESETS["1"];
      const key = cfg.googleApiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
      const outDir = join(musicDir, "Lyria");
      ctx.ui.notify(`🎛️ ${p.name} — ${p.style} @ ${p.bpm} BPM`, "info");
      if (!key) ctx.ui.notify("Tip: set GOOGLE_API_KEY or GEMINI_API_KEY", "warning");
      pi.sendUserMessage(
        `Start a Lyria RealTime music stream.\n` +
        `Style: "${p.style}" at ${p.bpm} BPM\n` +
        `Google API key: ${key ? "found" : "not set — check GOOGLE_API_KEY"}\n` +
        `Output: ${outDir}/session_${Date.now()}.mp3\n\n` +
        `Use Gemini API model: lyria-realtime-exp\n` +
        `Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/lyria-realtime-exp:streamGenerateContent\n` +
        `Stream PCM audio chunks → pipe to ffmpeg → write MP3 + play live.\n\n` +
        `Check if lyria-cli exists at ${join(musicDir, "lyria-cli/index.js")} and prefer that.\n` +
        `Tell user: press Ctrl+C to stop and save.`
      );
    },
  });

  // ── /sc — SoundCloud ───────────────────────────────────────────────────
  pi.registerCommand("sc", {
    description: "Download from SoundCloud. Usage: /sc <url>",
    handler: async (args, ctx) => {
      const url = args?.trim();
      if (!url) { ctx.ui.notify("Usage: /sc <soundcloud url>", "warning"); return; }
      const outDir = join(musicDir, "SoundCloud");
      ctx.ui.notify(`☁️ Downloading...`, "info");
      if (tools.scdl) {
        pi.sendUserMessage(
          `Download SoundCloud: ${url}\n` +
          `Run: scdl -l "${url}" --path "${outDir}" --mp3 --onlymp3\n` +
          `Show what was downloaded.`
        );
      } else {
        pi.sendUserMessage(
          `Download SoundCloud: ${url}\n` +
          `scdl not found — using yt-dlp:\n` +
          `Run: ${ytdlpBin()} "${url}" -x --audio-format mp3 --audio-quality 0 ` +
          `-o "${outDir}/%(uploader)s/%(title)s.%(ext)s"\n` +
          `Note: install scdl for better results: pip install scdl`
        );
      }
    },
  });

  // ── /bandcamp ──────────────────────────────────────────────────────────
  pi.registerCommand("bandcamp", {
    description: "Download from Bandcamp. Usage: /bandcamp <url>",
    handler: async (args, ctx) => {
      const url = args?.trim();
      if (!url) { ctx.ui.notify("Usage: /bandcamp <url>", "warning"); return; }
      const outDir = join(musicDir, "Bandcamp");
      ctx.ui.notify(`🎸 Downloading...`, "info");
      pi.sendUserMessage(
        `Download Bandcamp: ${url}\n` +
        `Run: ${ytdlpBin()} -x --audio-format mp3 --audio-quality 0 ` +
        `-o "${outDir}/%(artist)s/%(album)s/%(track_number)s - %(title)s.%(ext)s" "${url}"\n` +
        `Show what was downloaded.`
      );
    },
  });

  // ── /mix ───────────────────────────────────────────────────────────────
  pi.registerCommand("mix", {
    description: "Crossfade two tracks. Usage: /mix <a> <b> [secs=4]",
    handler: async (args, ctx) => {
      const parts = (args?.trim() || "").split(/\s+/);
      const [a, b, xfade = "4"] = parts;
      if (!a || !b) { ctx.ui.notify("Usage: /mix <track-a> <track-b> [crossfade-secs]", "warning"); return; }
      if (!tools.ffmpeg) { ctx.ui.notify(`ffmpeg not found. Install: ${installHint()}`, "warning"); return; }
      const out = join(musicDir, "Lyria", `mix_${Date.now()}.mp3`);
      ctx.ui.notify(`🎚️ Crossfading ${xfade}s...`, "info");
      pi.sendUserMessage(
        `Crossfade two tracks with ffmpeg:\n` +
        `A: "${a}"\nB: "${b}"\n` +
        `Run: ffmpeg -i "${a}" -i "${b}" ` +
        `-filter_complex "[0][1]acrossfade=d=${xfade}:c1=tri:c2=tri[out]" ` +
        `-map "[out]" "${out}"\n` +
        `Then play: "${out}"`
      );
    },
  });

  // ── /trim ──────────────────────────────────────────────────────────────
  pi.registerCommand("trim", {
    description: "Trim audio. Usage: /trim <file> <start-sec> [end-sec]",
    handler: async (args, ctx) => {
      const parts = (args?.trim() || "").split(/\s+/);
      const [file, start = "0", end] = parts;
      if (!file) { ctx.ui.notify("Usage: /trim <file> <start> [end] (seconds)", "warning"); return; }
      if (!tools.ffmpeg) { ctx.ui.notify(`ffmpeg not found. Install: ${installHint()}`, "warning"); return; }
      const out = join(musicDir, "Lyria", `trim_${Date.now()}.mp3`);
      ctx.ui.notify(`✂️ Trimming from ${start}s${end ? ` to ${end}s` : ""}...`, "info");
      pi.sendUserMessage(
        `Trim "${file}" from ${start}s${end ? ` to ${end}s` : " to end"}.\n` +
        `Run: ffmpeg -i "${file}" -ss ${start}${end ? ` -to ${end}` : ""} -c copy "${out}"\n` +
        `Show size and play.`
      );
    },
  });

  // ── /bpm ───────────────────────────────────────────────────────────────
  pi.registerCommand("bpm", {
    description: "Detect BPM. Usage: /bpm <file>",
    handler: async (args, ctx) => {
      const file = args?.trim();
      if (!file) { ctx.ui.notify("Usage: /bpm <file>", "warning"); return; }
      const py = tools.python;
      ctx.ui.notify(`🥁 Detecting BPM...`, "info");
      pi.sendUserMessage(
        `Detect BPM of "${file}".\n` +
        `Try in order:\n` +
        `1. librosa (best): ${py || "python3"} -c "import librosa; y,sr=librosa.load('${file}'); t,_=librosa.beat.beat_track(y=y,sr=sr); print(f'BPM: {t:.1f}')"\n` +
        `2. bpm-tools: sox "${file}" -t raw -r 44100 -e float -c 1 - | bpm\n` +
        `3. ffprobe: ffprobe -v quiet -print_format json -show_format "${file}"\n` +
        `Report BPM clearly.`
      );
    },
  });

  // ── /dj-help ───────────────────────────────────────────────────────────
  pi.registerCommand("dj-help", {
    description: "Show all pi-dj commands and tool status",
    handler: async (_args, ctx) => {
      const t = tools || detectTools();
      const ok = (x: string | null) => x ? "✅" : "❌";
      const platformLabel = IS_TERMUX ? "Termux/Android" : IS_RPI ? "Raspberry Pi" : IS_WIN ? "Windows" : IS_MAC ? "macOS" : "Linux";
      ctx.ui.notify(
        `🎧 pi-dj — ${platformLabel}\n\n` +
        `Tools: mpv ${ok(t.mpv)}  yt-dlp ${ok(t.ytdlp)}  ffmpeg ${ok(t.ffmpeg)}\n` +
        `       scdl ${ok(t.scdl)}  socat/nc ${ok(t.socat || t.nc)}\n` +
        `Music dir: ${musicDir}\n\n` +
        `PLAYBACK\n` +
        `/play <query|path>  YouTube or local file\n` +
        `/pause              Toggle pause\n` +
        `/stop               Stop + clear queue\n` +
        `/np                 Now playing\n` +
        `/vol <0-100>        Volume\n` +
        `/queue <query>      Add to queue\n` +
        `/skip               Skip track\n\n` +
        `AI MUSIC\n` +
        `/generate <prompt>  Suno AI song\n` +
        `/dj [1-9]           Lyria RealTime stream\n\n` +
        `DOWNLOADS\n` +
        `/sc <url>           SoundCloud\n` +
        `/bandcamp <url>     Bandcamp\n\n` +
        `PRODUCTION\n` +
        `/mix <a> <b> [s]    Crossfade\n` +
        `/trim <f> <s> [e]   Trim clip\n` +
        `/bpm <file>         Detect BPM\n\n` +
        `Install: ${installHint()}`,
        "info"
      );
    },
  });

  // ── LLM tools ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "play_music",
    label: "Play Music",
    description: "Search YouTube and play music, or play a local file. Works on Windows, macOS, Linux, Termux, and Raspberry Pi.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query, YouTube URL, or local file path" }),
    }),
    async execute(_id, params) {
      if (!tools?.mpv) {
        return {
          content: [{ type: "text", text: `mpv not installed. Run: ${installHint()}` }],
          isError: true,
        };
      }
      const q = params.query;
      const isLocal = existsSync(q);
      if (isLocal) {
        const title = await playTrack(q);
        return { content: [{ type: "text", text: `▶ ${title}` }] };
      }
      if (!tools.ytdlp) {
        return { content: [{ type: "text", text: "yt-dlp not installed. Run: pip install yt-dlp" }], isError: true };
      }
      const track = await resolveTrack(q);
      if (!track) return { content: [{ type: "text", text: `Not found: ${q}` }], isError: true };
      const title = await playTrack(track.url, track.title);
      return { content: [{ type: "text", text: `▶ ${title}` }] };
    },
  });

  pi.registerTool({
    name: "queue_music",
    label: "Queue Music",
    description: "Add a track to the playback queue.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query or YouTube URL" }),
    }),
    async execute(_id, params) {
      const track = await resolveTrack(params.query);
      if (!track) return { content: [{ type: "text", text: `Not found: ${params.query}` }], isError: true };
      if (!isPlaying && tools?.mpv) {
        await playTrack(track.url, track.title);
        return { content: [{ type: "text", text: `▶ ${track.title}` }] };
      }
      trackQueue.push(track);
      return { content: [{ type: "text", text: `Queued #${trackQueue.length}: ${track.title}` }] };
    },
  });
}
