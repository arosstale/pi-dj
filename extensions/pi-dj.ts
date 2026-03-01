/**
 * pi-dj — AI Music Production Suite for pi
 *
 * Works on: Windows · macOS · Linux · Raspberry Pi · Termux (Android)
 *
 * Install deps:
 *   Windows:  winget install mpv; pip install yt-dlp; winget install ffmpeg
 *   macOS:    brew install mpv yt-dlp ffmpeg
 *   Linux/Pi: sudo apt install mpv ffmpeg -y; pip install yt-dlp
 *   Termux:   pkg install mpv ffmpeg python; pip install yt-dlp
 *
 * Commands:
 *   /dj-play <query|path> — YouTube search, URL, playlist, or local file
 *   /pause               — Toggle pause
 *   /stop                — Stop playback + clear queue
 *   /np                  — Now playing
 *   /vol <0-100>         — Volume
 *   /queue <query>       — Queue a track
 *   /skip                — Skip track
 *   /repeat              — Toggle loop current track
 *   /search <query>      — Search without playing, show results
 *   /dj-lib [dir]        — Browse local music library
 *   /history             — Recently played tracks
 *   /dj-viz [file]       — Terminal audio visualizer
 *   /generate <prompt>   — Suno AI song generation
 *   /dj [1-9]            — Lyria RealTime AI stream
 *   /sc <url>            — SoundCloud download
 *   /bandcamp <url>      — Bandcamp download
 *   /mix <a> <b> [s]     — Crossfade two tracks
 *   /trim <f> <s> [e]    — Trim audio clip
 *   /bpm <file>          — Detect BPM
 *   /dj-help             — All commands + system status
 *
 * Note: /play and /music are owned by cliamp (local TUI player).
 *       /dj-play handles YouTube/URL streaming via mpv.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join, extname, basename } from "node:path";
import * as net from "node:net";

// ── Platform ───────────────────────────────────────────────────────────────
const OS       = platform();
const IS_WIN   = OS === "win32";
const IS_MAC   = OS === "darwin";
const IS_TERMUX = !IS_WIN && existsSync("/data/data/com.termux");
const IS_RPI   = !IS_WIN && !IS_MAC && !IS_TERMUX && (() => {
  try { return readFileSync("/proc/device-tree/model", "utf-8").toLowerCase().includes("raspberry"); }
  catch { return false; }
})();

const HOME = homedir();
const TMP  = IS_TERMUX ? "/data/data/com.termux/files/usr/tmp" : tmpdir();

// mpv IPC: named pipe on Windows, Unix socket elsewhere
const IPC_PATH = IS_WIN ? "\\\\.\\pipe\\mpv-pi-dj" : join(TMP, "mpv-pi-dj.sock");

// ── Config (~/.pi-dj.json or PI_DJ_CONFIG env) ────────────────────────────
interface DjConfig {
  musicDir?: string;
  sunoApiKey?: string;
  googleApiKey?: string;
  libraries?: Record<string, string>; // label -> path
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

// ── Tool detection ────────────────────────────────────────────────────────
function which(cmd: string): string | null {
  try {
    const r = execSync(
      IS_WIN ? `where "${cmd}" 2>nul` : `command -v "${cmd}" 2>/dev/null`,
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }
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
  nc: string | null;
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
  if (IS_TERMUX) return "pkg install mpv ffmpeg python && pip install yt-dlp";
  if (IS_WIN)    return "winget install mpv && pip install yt-dlp && winget install ffmpeg";
  if (IS_MAC)    return "brew install mpv yt-dlp ffmpeg";
  if (IS_RPI)    return "sudo apt install mpv ffmpeg -y && pip install yt-dlp";
  return "sudo apt install mpv ffmpeg -y && pip install yt-dlp";
}

// ── IPC via Node.js net (works on all platforms, no socat/nc needed) ───────
let ipcReady = false;

function mpvIpc(cmd: Record<string, any>): Promise<any> {
  return new Promise((resolve) => {
    if (!ipcReady) { resolve(null); return; }
    const payload = JSON.stringify(cmd) + "\n";
    const client = net.createConnection(IPC_PATH);
    let data = "";
    client.setTimeout(1500);
    client.on("connect", () => client.write(payload));
    client.on("data", (chunk) => { data += chunk.toString(); });
    client.on("timeout", () => { client.destroy(); resolve(null); });
    client.on("error", () => resolve(null));
    client.on("close", () => {
      try {
        // mpv sends multiple JSON lines; take the last complete one
        const lines = data.trim().split("\n").filter(Boolean);
        const parsed = JSON.parse(lines[lines.length - 1] || "{}");
        resolve(parsed.data ?? null);
      } catch { resolve(null); }
    });
  });
}

async function mpvGet(prop: string): Promise<string | null> {
  const val = await mpvIpc({ command: ["get_property", prop] });
  return val != null ? String(val) : null;
}

async function mpvSet(prop: string, val: any): Promise<void> {
  await mpvIpc({ command: ["set_property", prop, val] });
}

async function mpvCycle(prop: string): Promise<void> {
  await mpvIpc({ command: ["cycle", prop] });
}

// ── Playback state ────────────────────────────────────────────────────────
let mpvProcess: ChildProcess | null = null;
let mpvPid: number | null = null;
let currentTrack = { title: "", url: "" };
let isPlaying    = false;
let isPaused     = false;
let isLooping    = false;
let cachedDur    = 0; // cache duration (doesn't change mid-track)
let trackQueue: { title: string; url: string }[] = [];
let history: { title: string; url: string; playedAt: number }[] = [];
let statusCtx: any = null;
let tools: Tools;
let cfg: DjConfig;
let musicDir: string;

// ── Status bar ────────────────────────────────────────────────────────────
function fmt(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

async function updateStatus() {
  if (!statusCtx) return;
  const theme = statusCtx.ui.theme;

  if (!isPlaying || !currentTrack.title) {
    statusCtx.ui.setStatus("pi-dj", theme.fg("dim", "🎵 stopped"));
    return;
  }

  // Only query time-pos each tick — pause/duration tracked locally
  const pos = ipcReady ? await mpvGet("time-pos") : null;
  const icon  = isPaused ? "⏸" : (isLooping ? "🔁" : "▶");
  const color = isPaused ? "warning" : "success";
  let title = currentTrack.title;
  if (title.length > 42) title = title.slice(0, 39) + "...";
  const time = (pos && cachedDur)
    ? theme.fg("dim", ` ${fmt(+pos)}/${fmt(cachedDur)}`)
    : "";
  const q = trackQueue.length ? theme.fg("muted", ` [+${trackQueue.length}]`) : "";
  statusCtx.ui.setStatus("pi-dj",
    theme.fg(color, icon) + " " + theme.fg("text", title) + time + q);
}

// ── Kill mpv ───────────────────────────────────────────────────────────────
function killMpv() {
  ipcReady = false;
  if (mpvProcess) {
    try { mpvProcess.kill("SIGTERM"); } catch {}
    mpvProcess = null;
  }
  mpvPid   = null;
  isPlaying = false;
  isPaused  = false;
  cachedDur = 0;
  currentTrack = { title: "", url: "" };
}

// ── Find yt-dlp ────────────────────────────────────────────────────────────
function ytdlpBin(): string {
  if (tools?.ytdlp) return tools.ytdlp;
  const candidates = IS_WIN
    ? [`${HOME}\\AppData\\Local\\Programs\\Python\\Python311\\Scripts\\yt-dlp.exe`,
       `${HOME}\\AppData\\Roaming\\Python\\Python311\\Scripts\\yt-dlp.exe`]
    : IS_TERMUX
    ? ["/data/data/com.termux/files/usr/bin/yt-dlp", join(HOME, ".local/bin/yt-dlp")]
    : ["/usr/local/bin/yt-dlp", join(HOME, ".local/bin/yt-dlp")];
  for (const c of candidates) if (existsSync(c)) return c;
  return "yt-dlp";
}

// ── Resolve track (search or URL, with playlist support) ──────────────────
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

// Resolve a playlist into multiple tracks (capped at 50)
async function resolvePlaylist(url: string): Promise<{ title: string; url: string }[]> {
  const bin = ytdlpBin();
  try {
    const out = execSync(
      `${bin} "${url}" --flat-playlist --print title --print webpage_url --playlist-end 50 2>/dev/null`,
      { encoding: "utf-8", timeout: 30000 }
    ).trim().split(/\r?\n/);
    const tracks: { title: string; url: string }[] = [];
    for (let i = 0; i + 1 < out.length; i += 2) {
      if (out[i + 1]?.startsWith("http")) tracks.push({ title: out[i], url: out[i + 1] });
    }
    return tracks;
  } catch { return []; }
}

// ── Play a track with mpv ─────────────────────────────────────────────────
async function playTrack(url: string, title?: string): Promise<string> {
  killMpv();

  if (!title) {
    try {
      title = execSync(
        `${ytdlpBin()} --print title "${url}" --no-playlist 2>/dev/null`,
        { encoding: "utf-8", timeout: 10000 }
      ).trim() || url;
    } catch { title = url; }
  }

  currentTrack = { title, url };

  // Add to history (keep last 50)
  history.unshift({ title, url, playedAt: Date.now() });
  if (history.length > 50) history.length = 50;

  const mpvArgs = [
    "--no-video",
    "--really-quiet",
    "--ytdl-format=bestaudio/best",
    `--input-ipc-server=${IPC_PATH}`,
  ];

  if (IS_TERMUX) mpvArgs.push("--ao=opensles");
  if (isLooping)  mpvArgs.push("--loop-file=inf");

  mpvArgs.push(url);

  mpvProcess = spawn("mpv", mpvArgs, {
    stdio: "ignore",
    detached: true,
    ...(IS_WIN ? { shell: false } : {}),
  });
  mpvPid    = mpvProcess.pid ?? null;
  isPlaying = true;
  isPaused  = false;
  mpvProcess.unref();

  mpvProcess.on("exit", () => {
    ipcReady  = false;
    isPlaying = false;
    mpvProcess = null;
    mpvPid    = null;
    cachedDur = 0;
    if (trackQueue.length > 0) {
      const next = trackQueue.shift()!;
      playTrack(next.url, next.title);
    } else {
      updateStatus();
    }
  });

  // Wait for IPC socket/pipe to appear then cache duration
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (IS_WIN ? true : existsSync(IPC_PATH)) { // named pipe not in filesystem on Windows
      ipcReady = true;
      break;
    }
  }

  // Give mpv a moment to load the stream before querying duration
  if (ipcReady) {
    await new Promise(r => setTimeout(r, 1000));
    const dur = await mpvGet("duration");
    cachedDur = dur ? parseFloat(dur) : 0;
  }

  updateStatus();
  return title;
}

// ── Toggle pause ──────────────────────────────────────────────────────────
async function togglePause(): Promise<void> {
  if (ipcReady) {
    await mpvCycle("pause");
    isPaused = !isPaused;
  } else if (mpvPid) {
    // SIGSTOP/SIGCONT fallback — Linux/RPi/Termux only (not Windows)
    try {
      process.kill(mpvPid, isPaused ? "SIGCONT" : "SIGSTOP");
      isPaused = !isPaused;
    } catch {}
  }
}

// ── Open with system default player (mpv fallback) ────────────────────────
function openSystemPlayer(path: string): void {
  try {
    if (IS_WIN)        execSync(`cmd.exe /c start "" "${path}"`, { stdio: "ignore" });
    else if (IS_MAC)   execSync(`open "${path}"`, { stdio: "ignore" });
    else if (IS_TERMUX) execSync(`am start --user 0 -a android.intent.action.VIEW -d "file://${path}" -t audio/* 2>/dev/null`, { stdio: "ignore" });
    else               execSync(`xdg-open "${path}" 2>/dev/null &`, { stdio: "ignore" });
  } catch {}
}

// ── Audio file extensions ─────────────────────────────────────────────────
const AUDIO_EXTS = new Set([".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac", ".opus", ".wma"]);

function isAudioFile(f: string): boolean {
  return AUDIO_EXTS.has(extname(f).toLowerCase());
}

function listAudioFiles(dir: string, max = 20): string[] {
  try {
    return readdirSync(dir)
      .filter(f => isAudioFile(f))
      .slice(0, max)
      .map(f => join(dir, f));
  } catch { return []; }
}

// ── Lyria presets ─────────────────────────────────────────────────────────
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

    for (const sub of ["Lyria", "Suno", "Videos", "SoundCloud", "Bandcamp"]) {
      try { mkdirSync(join(musicDir, sub), { recursive: true }); } catch {}
    }

    updateStatus();
    if (statusInterval) clearInterval(statusInterval);
    statusInterval = setInterval(() => updateStatus(), 3000);
  });

  pi.on("session_shutdown", async () => {
    if (statusInterval) clearInterval(statusInterval);
    killMpv();
  });

  // ── /play ──────────────────────────────────────────────────────────────
  pi.registerCommand("dj-play", {
    description: "Stream music via mpv — YouTube search, URL, or playlist. /dj-play <query|url>",
    handler: async (args, ctx) => {
      const query = args?.trim();

      // No args: toggle pause if playing, else show usage
      if (!query) {
        if (isPlaying) {
          await togglePause();
          ctx.ui.notify(isPaused ? "⏸ Paused" : "▶ Resumed", "info");
          updateStatus();
        } else {
          ctx.ui.notify("Usage: /play <search query, YouTube URL, playlist URL, or file path>", "info");
        }
        return;
      }

      if (!tools.mpv) {
        ctx.ui.notify(`mpv not found. Install: ${installHint()}`, "warning");
        if (existsSync(query)) { openSystemPlayer(query); }
        return;
      }

      // Local file
      if (existsSync(query)) {
        ctx.ui.notify(`▶ ${basename(query)}`, "info");
        const title = await playTrack(query, basename(query));
        ctx.ui.notify(`▶ ${title}`, "success");
        return;
      }

      if (!tools.ytdlp) {
        ctx.ui.notify("yt-dlp not found. Install: pip install yt-dlp", "warning");
        return;
      }

      // Detect playlist URL (youtube.com/playlist, /watch?list=, soundcloud sets, etc.)
      const isPlaylistUrl = /[?&]list=|\/playlist\?|\/sets\//.test(query);
      if (isPlaylistUrl) {
        ctx.ui.notify("🎵 Loading playlist...", "info");
        const tracks = await resolvePlaylist(query);
        if (!tracks.length) { ctx.ui.notify("No tracks found in playlist", "warning"); return; }
        const [first, ...rest] = tracks;
        trackQueue.unshift(...rest);
        await playTrack(first.url, first.title);
        ctx.ui.notify(`▶ ${first.title} (+${rest.length} queued)`, "success");
        return;
      }

      ctx.ui.notify(`🔍 Searching: ${query}...`, "info");
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
      await togglePause();
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
      const pos = ipcReady ? await mpvGet("time-pos") : null;
      let msg = `${isPaused ? "⏸" : "▶"} ${currentTrack.title}`;
      if (pos && cachedDur) msg += `\n  ${fmt(+pos)} / ${fmt(cachedDur)}`;
      if (isLooping) msg += "  🔁";
      if (trackQueue.length) msg += `\n  Up next: ${trackQueue[0].title}${trackQueue.length > 1 ? ` (+${trackQueue.length - 1} more)` : ""}`;
      ctx.ui.notify(msg, "info");
    },
  });

  // ── /vol ───────────────────────────────────────────────────────────────
  pi.registerCommand("vol", {
    description: "Set volume 0-100. /vol 75",
    handler: async (args, ctx) => {
      const vol = parseInt(args?.trim() ?? "");
      if (isNaN(vol) || vol < 0 || vol > 100) {
        const cur = ipcReady ? await mpvGet("volume") : null;
        ctx.ui.notify(`🔊 Volume: ${cur ? Math.round(+cur) + "%" : "unknown (mpv IPC not ready)"}`, "info");
        return;
      }
      await mpvSet("volume", vol);
      ctx.ui.notify(`🔊 ${vol}%`, "info");
    },
  });

  // ── /queue ─────────────────────────────────────────────────────────────
  pi.registerCommand("queue", {
    description: "Queue a track. /queue <search query|URL>",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        if (!trackQueue.length) { ctx.ui.notify("Queue is empty", "info"); return; }
        const list = trackQueue.map((t, i) => `${i + 1}. ${t.title}`).join("\n");
        ctx.ui.notify(`📋 Queue (${trackQueue.length}):\n${list}`, "info");
        return;
      }
      if (!tools.ytdlp) { ctx.ui.notify("yt-dlp required for queuing", "warning"); return; }
      ctx.ui.notify(`🔍 Queuing: ${args.trim()}...`, "info");
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
      ctx.ui.notify(`⏭ ${next.title}${trackQueue.length ? ` (+${trackQueue.length} left)` : ""}`, "success");
    },
  });

  // ── /repeat ────────────────────────────────────────────────────────────
  pi.registerCommand("repeat", {
    description: "Toggle loop on current track",
    handler: async (_args, ctx) => {
      isLooping = !isLooping;
      if (ipcReady) await mpvSet("loop-file", isLooping ? "inf" : "no");
      ctx.ui.notify(isLooping ? "🔁 Repeat ON" : "Repeat OFF", "info");
      updateStatus();
    },
  });

  // ── /search ────────────────────────────────────────────────────────────
  pi.registerCommand("search", {
    description: "Search YouTube without playing. /search <query>",
    handler: async (args, ctx) => {
      const query = args?.trim();
      if (!query) { ctx.ui.notify("Usage: /search <query>", "info"); return; }
      if (!tools.ytdlp) { ctx.ui.notify("yt-dlp required. Install: pip install yt-dlp", "warning"); return; }
      ctx.ui.notify(`🔍 Searching: ${query}...`, "info");
      pi.sendUserMessage(
        `Search YouTube for: "${query}"\n` +
        `Run: ${ytdlpBin()} "ytsearch5:${query}" --print title --print webpage_url --no-playlist 2>/dev/null\n` +
        `Show the results as a numbered list (title + URL).\n` +
        `Tell the user they can play any result with /play <url> or /queue <url>.`
      );
    },
  });

  // ── /music ─────────────────────────────────────────────────────────────
  pi.registerCommand("dj-lib", {
    description: "Browse local music library. /dj-lib [subdirectory]",
    handler: async (args, ctx) => {
      const sub = args?.trim();
      const dir = sub ? join(musicDir, sub) : musicDir;

      if (!existsSync(dir)) {
        ctx.ui.notify(`Music dir not found: ${dir}`, "warning");
        return;
      }

      // List audio files and subdirs
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        ctx.ui.notify(`Cannot read: ${dir}`, "warning"); return;
      }

      const subdirs = entries.filter(e => {
        try { return statSync(join(dir, e)).isDirectory(); } catch { return false; }
      });
      const files = entries.filter(e => isAudioFile(e));

      if (!subdirs.length && !files.length) {
        ctx.ui.notify(`No music found in: ${dir}`, "info"); return;
      }

      let msg = `🎵 ${dir}\n`;
      if (subdirs.length) {
        msg += `\nFolders:\n` + subdirs.slice(0, 10).map(d => `  📁 ${d}`).join("\n");
        if (subdirs.length > 10) msg += `\n  ... +${subdirs.length - 10} more`;
      }
      if (files.length) {
        msg += `\n\nTracks (${files.length}):\n` + files.slice(0, 15).map(f => `  🎵 ${f}`).join("\n");
        if (files.length > 15) msg += `\n  ... +${files.length - 15} more`;
      }

      ctx.ui.notify(msg, "info");

      // If files exist, ask LLM to offer to play
      if (files.length && tools.mpv) {
        pi.sendUserMessage(
          `The user browsed their music library at "${dir}".\n` +
          `Found ${files.length} audio file(s) and ${subdirs.length} folder(s).\n` +
          `Files: ${files.slice(0, 5).join(", ")}${files.length > 5 ? "..." : ""}\n` +
          `Ask the user if they want to play something from this folder, ` +
          `or just acknowledge what they found. Don't play anything automatically.`
        );
      }
    },
  });

  // ── /history ───────────────────────────────────────────────────────────
  pi.registerCommand("history", {
    description: "Show recently played tracks",
    handler: async (_args, ctx) => {
      if (!history.length) { ctx.ui.notify("No history yet", "info"); return; }
      const list = history.slice(0, 10).map((t, i) => {
        const ago = Math.round((Date.now() - t.playedAt) / 60000);
        const time = ago < 1 ? "just now" : ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
        return `${i + 1}. ${t.title} (${time})`;
      }).join("\n");
      ctx.ui.notify(`📜 Recent (${history.length}):\n${list}`, "info");
    },
  });

  // ── /viz ───────────────────────────────────────────────────────────────
  pi.registerCommand("dj-viz", {
    description: "Terminal audio visualizer. /dj-viz [file]",
    handler: async (args, ctx) => {
      const file = args?.trim();
      ctx.ui.notify("🎨 Starting visualizer...", "info");
      pi.sendUserMessage(
        file
          ? `Show a terminal audio visualization for: "${file}"\n` +
            `Try in order:\n` +
            `1. ffplay spectrum: ffplay -showmode 1 "${file}"\n` +
            `2. cava (if installed): play the file with mpv in background, then run cava\n` +
            `Open in a new window if possible.`
          : `Start a terminal audio visualizer for the currently playing audio.\n` +
            `Check if cava is installed (which cava). If yes, run it in interactive_shell.\n` +
            `If not: suggest install (${IS_TERMUX ? "pkg install cava" : IS_WIN ? "not available natively" : IS_MAC ? "brew install cava" : "apt install cava"}).\n` +
            `Alternative: use ffplay -showmode 1 on a local file with /viz [path].`
      );
    },
  });

  // ── /generate — Suno AI ────────────────────────────────────────────────
  pi.registerCommand("generate", {
    description: "Generate an AI song with Suno. /generate <prompt>",
    handler: async (args, ctx) => {
      const prompt = args?.trim() || "lo-fi hip hop trap soul beat, 808s, vinyl texture";
      const key    = cfg.sunoApiKey || process.env.SUNO_API_KEY;
      const outDir = join(musicDir, "Suno");
      ctx.ui.notify(`🤖 Generating: "${prompt}"`, "info");
      if (!key) ctx.ui.notify("Tip: set SUNO_API_KEY or add sunoApiKey to ~/.pi-dj.json", "warning");
      pi.sendUserMessage(
        `Generate a Suno AI song.\n` +
        `Prompt: "${prompt}"\n` +
        `SUNO_API_KEY: ${key ? "(set)" : "(missing — tell user to set it)"}\n` +
        `Output dir: ${outDir}\n\n` +
        `Steps:\n` +
        `1. POST https://api.suno.ai/api/generate\n` +
        `   Body: {"prompt":"${prompt}","mv":"chirp-v3-5","make_instrumental":false}\n` +
        `   Header: Authorization: Bearer $SUNO_API_KEY\n` +
        `2. Poll GET https://api.suno.ai/api/feed?ids=<id> until status="complete"\n` +
        `3. Download audio_url → ${outDir}/<title>.mp3\n` +
        `4. Play the file. Show progress throughout.`
      );
    },
  });

  // ── /dj — Lyria RealTime ───────────────────────────────────────────────
  pi.registerCommand("dj", {
    description: "Live AI music stream with Lyria RealTime. /dj [1-9]",
    handler: async (args, ctx) => {
      const num = args?.trim() || "1";
      const p   = PRESETS[num] || PRESETS["1"];
      const key = cfg.googleApiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
      const outDir = join(musicDir, "Lyria");
      ctx.ui.notify(`🎛️ ${p.name} — ${p.style} @ ${p.bpm} BPM`, "info");
      if (!key) ctx.ui.notify("Tip: set GOOGLE_API_KEY or GEMINI_API_KEY", "warning");

      const lyriaCli = join(musicDir, "lyria-cli/index.js");
      pi.sendUserMessage(
        `Start a Lyria RealTime music stream.\n` +
        `Style: "${p.style}" at ${p.bpm} BPM\n` +
        `API key: ${key ? "found in env" : "not set — check GOOGLE_API_KEY"}\n` +
        `Output: ${outDir}/session_${Date.now()}.mp3\n\n` +
        (existsSync(lyriaCli)
          ? `lyria-cli found at ${lyriaCli}. Run it in interactive_shell interactive mode:\n  node "${lyriaCli}"\n`
          : `lyria-cli not found. Use Gemini API directly:\n` +
            `  Model: lyria-realtime-exp\n` +
            `  Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/lyria-realtime-exp:streamGenerateContent\n` +
            `  Stream PCM chunks → ffmpeg → write MP3 + play live.\n`) +
        `Tell user: Ctrl+C to stop and save.`
      );
    },
  });

  // ── /sc — SoundCloud ───────────────────────────────────────────────────
  pi.registerCommand("sc", {
    description: "Download from SoundCloud. /sc <url>",
    handler: async (args, ctx) => {
      const url = args?.trim();
      if (!url) { ctx.ui.notify("Usage: /sc <soundcloud url>", "warning"); return; }
      const outDir = join(musicDir, "SoundCloud");
      ctx.ui.notify("☁️ Downloading from SoundCloud...", "info");
      if (tools.scdl) {
        pi.sendUserMessage(
          `Download SoundCloud: ${url}\n` +
          `Run: scdl -l "${url}" --path "${outDir}" --mp3 --onlymp3\n` +
          `Show files downloaded.`
        );
      } else {
        pi.sendUserMessage(
          `Download SoundCloud: ${url}\n` +
          `scdl not found — falling back to yt-dlp:\n` +
          `Run: ${ytdlpBin()} "${url}" -x --audio-format mp3 --audio-quality 0 ` +
          `-o "${outDir}/%(uploader)s/%(title)s.%(ext)s"\n` +
          `Note: pip install scdl for better SoundCloud support.`
        );
      }
    },
  });

  // ── /bandcamp ──────────────────────────────────────────────────────────
  pi.registerCommand("bandcamp", {
    description: "Download from Bandcamp. /bandcamp <url>",
    handler: async (args, ctx) => {
      const url = args?.trim();
      if (!url) { ctx.ui.notify("Usage: /bandcamp <url>", "warning"); return; }
      const outDir = join(musicDir, "Bandcamp");
      ctx.ui.notify("🎸 Downloading from Bandcamp...", "info");
      pi.sendUserMessage(
        `Download Bandcamp: ${url}\n` +
        `Run: ${ytdlpBin()} -x --audio-format mp3 --audio-quality 0 ` +
        `-o "${outDir}/%(artist)s/%(album)s/%(track_number)s - %(title)s.%(ext)s" "${url}"\n` +
        `Show files downloaded.`
      );
    },
  });

  // ── /mix ───────────────────────────────────────────────────────────────
  pi.registerCommand("mix", {
    description: "Crossfade two tracks. /mix <a> <b> [secs=4]",
    handler: async (args, ctx) => {
      const parts = (args?.trim() || "").split(/\s+/);
      const [a, b, xfade = "4"] = parts;
      if (!a || !b) { ctx.ui.notify("Usage: /mix <track-a> <track-b> [crossfade-secs]", "warning"); return; }
      if (!tools.ffmpeg) { ctx.ui.notify(`ffmpeg not found. Install: ${installHint()}`, "warning"); return; }
      const out = join(musicDir, "Lyria", `mix_${Date.now()}.mp3`);
      ctx.ui.notify(`🎚️ Crossfading with ${xfade}s overlap...`, "info");
      pi.sendUserMessage(
        `Crossfade two audio tracks:\nA: "${a}"\nB: "${b}"\n` +
        `Run: ffmpeg -i "${a}" -i "${b}" ` +
        `-filter_complex "[0][1]acrossfade=d=${xfade}:c1=tri:c2=tri[out]" ` +
        `-map "[out]" "${out}"\n` +
        `Then play: "${out}"`
      );
    },
  });

  // ── /trim ──────────────────────────────────────────────────────────────
  pi.registerCommand("trim", {
    description: "Trim audio clip. /trim <file> <start-sec> [end-sec]",
    handler: async (args, ctx) => {
      const parts = (args?.trim() || "").split(/\s+/);
      const [file, start = "0", end] = parts;
      if (!file) { ctx.ui.notify("Usage: /trim <file> <start> [end] (seconds)", "warning"); return; }
      if (!tools.ffmpeg) { ctx.ui.notify(`ffmpeg not found. Install: ${installHint()}`, "warning"); return; }
      const out = join(musicDir, "Lyria", `trim_${Date.now()}.mp3`);
      ctx.ui.notify(`✂️ Trimming ${start}s${end ? `–${end}s` : "+"}...`, "info");
      pi.sendUserMessage(
        `Trim "${file}" from ${start}s${end ? ` to ${end}s` : " to end"}.\n` +
        `Run: ffmpeg -i "${file}" -ss ${start}${end ? ` -to ${end}` : ""} -c copy "${out}"\n` +
        `Show file size and play.`
      );
    },
  });

  // ── /bpm ───────────────────────────────────────────────────────────────
  pi.registerCommand("bpm", {
    description: "Detect BPM of a track. /bpm <file>",
    handler: async (args, ctx) => {
      const file = args?.trim();
      if (!file) { ctx.ui.notify("Usage: /bpm <file>", "warning"); return; }
      ctx.ui.notify("🥁 Detecting BPM...", "info");
      pi.sendUserMessage(
        `Detect BPM of "${file}".\n` +
        `Try in order:\n` +
        `1. librosa: ${tools.python || "python3"} -c "import librosa; y,sr=librosa.load('${file}'); t,_=librosa.beat.beat_track(y=y,sr=sr); print(f'BPM: {t:.1f}')"\n` +
        `2. bpm-tools: sox "${file}" -t raw -r 44100 -e float -c 1 - | bpm\n` +
        `3. ffprobe metadata: ffprobe -v quiet -print_format json -show_format "${file}"\n` +
        `Report BPM clearly.`
      );
    },
  });

  // ── /dj-help ───────────────────────────────────────────────────────────
  pi.registerCommand("dj-help", {
    description: "Show all commands + system status",
    handler: async (_args, ctx) => {
      const t = tools || detectTools();
      const ok  = (x: string | null) => x ? "✅" : "❌";
      const platform = IS_TERMUX ? "Termux/Android" : IS_RPI ? "Raspberry Pi" : IS_WIN ? "Windows" : IS_MAC ? "macOS" : "Linux";
      const ipcMethod = ipcReady ? "Node IPC ✅" : (t.socat ? "socat" : t.nc ? "nc fallback" : IS_WIN ? "Windows pipe" : "SIGSTOP");
      ctx.ui.notify(
        `🎧 pi-dj — ${platform}\n\n` +
        `mpv ${ok(t.mpv)}  yt-dlp ${ok(t.ytdlp)}  ffmpeg ${ok(t.ffmpeg)}  scdl ${ok(t.scdl)}\n` +
        `IPC: ${ipcMethod}  Music: ${musicDir}\n\n` +
        `STREAMING (mpv / YouTube)\n` +
        `/dj-play <query|url> YouTube search, URL, or playlist\n` +
        `/pause               Toggle pause\n` +
        `/stop                Stop + clear queue\n` +
        `/np                  Now playing\n` +
        `/vol <0-100>         Volume\n` +
        `/queue <query>       Add to queue\n` +
        `/skip                Skip track\n` +
        `/repeat              Toggle loop\n` +
        `/search <query>      Search without playing\n` +
        `/history             Recently played\n` +
        `/dj-lib [dir]        Browse local library\n` +
        `/dj-viz [file]       Terminal visualizer\n` +
        `\n` +
        `LOCAL FILES → use /play (cliamp TUI)\n` +
        `/play [path]         Open cliamp player (EQ, keys, Winamp UI)\n` +
        `/music               Play ~/Music in cliamp\n\n` +
        `AI MUSIC\n` +
        `/generate <prompt>   Suno AI song\n` +
        `/dj [1-9]            Lyria RealTime stream\n\n` +
        `DOWNLOADS\n` +
        `/sc <url>            SoundCloud\n` +
        `/bandcamp <url>      Bandcamp\n\n` +
        `PRODUCTION\n` +
        `/mix <a> <b> [s]     Crossfade tracks\n` +
        `/trim <f> <s> [e]    Trim clip\n` +
        `/bpm <file>          Detect BPM\n\n` +
        `Missing tools? ${installHint()}`,
        "info"
      );
    },
  });

  // ── LLM tools ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "dj_play_music",
    label: "DJ Play Music",
    description: "Search YouTube and stream music via mpv. For local files use play_music (cliamp) instead. Works on Windows, macOS, Linux, Termux, Raspberry Pi.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query, YouTube URL, playlist URL, or local file path" }),
    }),
    async execute(_id, params) {
      if (!tools?.mpv) {
        return { content: [{ type: "text", text: `mpv not installed. Run: ${installHint()}` }], isError: true };
      }
      const q = params.query;
      if (existsSync(q)) {
        const title = await playTrack(q, basename(q));
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
    name: "dj_queue_music",
    label: "DJ Queue Music",
    description: "Add a YouTube/URL track to the mpv playback queue.",
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
