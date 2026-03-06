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
 * Division of labour:
 *   cliamp v1.15+ → local files, HTTP streams, Lyria AI, Navidrome, SoundCloud search, webm (/play /music)
 *   pi-djvj       → terminal visualizer + fragcoord shaders (/viz /djvj)
 *   pi-dj (this)  → YouTube streaming, downloads, production tools, global radio (/radio)
 *
 * Commands:
 *   /dj-play <query|url>  — YouTube search, URL, or playlist → mpv
 *   /pause /stop /np /vol /queue /skip /repeat — playback control
 *   /history              — recently played
 *   /sc <url>             — download SoundCloud → MP3
 *   /bandcamp <url>       — download Bandcamp → MP3
 *   /bandlab <url>        — download BandLab track/album/collection → MP3
 *   /strudel <pattern> [--bpm N] [--wave saw] — live-coded music (Strudel/TidalCycles, pure CLI)
 *   /strudel-stop              — stop Strudel playback
 *   /render <file|url> [style] — render music video with ffmpeg (bars|wave|circle|cqt)
 *   /subs <file> [style]       — transcribe + burn karaoke subtitles (whisper)
 *   /mix <a> <b> [s]      — crossfade two tracks with ffmpeg
 *   /trim                 — (moved to pi-ffmpeg)
 *   /bpm <file>           — detect BPM
 *   /radio <genre|name|country|url> — global internet radio (Radio Browser)
 *   /radio lyria [preset]           — Lyria AI generative radio
 *   /dj-help              — commands + tool status
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join, basename, extname } from "node:path";
import * as net from "node:net";

// ── Platform ───────────────────────────────────────────────────────────────
const IS_WIN    = platform() === "win32";
const IS_MAC    = platform() === "darwin";
const IS_TERMUX = !IS_WIN && existsSync("/data/data/com.termux");
const IS_RPI    = !IS_WIN && !IS_MAC && !IS_TERMUX && (() => {
  try { return readFileSync("/proc/device-tree/model", "utf-8").toLowerCase().includes("raspberry"); }
  catch { return false; }
})();

const HOME = homedir();
const TMP  = IS_TERMUX ? "/data/data/com.termux/files/usr/tmp" : tmpdir();
const IPC_PATH = IS_WIN ? "\\\\.\\pipe\\mpv-pi-dj" : join(TMP, "mpv-pi-dj.sock");

// ── Config (~/.pi-dj.json) ────────────────────────────────────────────────
interface DjConfig { musicDir?: string; }

function loadConfig(): DjConfig {
  const p = process.env.PI_DJ_CONFIG || join(HOME, ".pi-dj.json");
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf-8")); } catch {} }
  return {};
}

function getMusicDir(cfg: DjConfig): string {
  return cfg.musicDir || process.env.PI_DJ_MUSIC
    || (IS_TERMUX ? join(HOME, "storage/music") : join(HOME, "Music"));
}

// ── Tool detection ────────────────────────────────────────────────────────
function which(cmd: string): string | null {
  // On Windows, also check ~/bin/<cmd>.exe since cmd.exe PATH ≠ Git Bash PATH
  if (IS_WIN) {
    const local = join(HOME, "bin", cmd + ".exe");
    if (existsSync(local)) return local;
  }
  try {
    return execSync(
      IS_WIN ? `where "${cmd}" 2>nul` : `command -v "${cmd}" 2>/dev/null`,
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }
    ).trim().split(/\r?\n/)[0].trim() || null;
  } catch { return null; }
}

function installHint(): string {
  if (IS_TERMUX) return "pkg install mpv ffmpeg python && pip install yt-dlp";
  if (IS_WIN)    return "winget install mpv && winget install ffmpeg && pip install yt-dlp";
  if (IS_MAC)    return "brew install mpv yt-dlp ffmpeg";
  return "sudo apt install mpv ffmpeg -y && pip install yt-dlp";
}

// ── mpv IPC via Node net (all platforms) ──────────────────────────────────
let ipcReady = false;

function mpvIpc(cmd: Record<string, any>): Promise<any> {
  return new Promise(resolve => {
    if (!ipcReady) { resolve(null); return; }
    const client = net.createConnection(IPC_PATH);
    let buf = "";
    client.setTimeout(1500);
    client.on("connect", () => client.write(JSON.stringify(cmd) + "\n"));
    client.on("data", d => { buf += d; });
    client.on("timeout", () => { client.destroy(); resolve(null); });
    client.on("error", () => resolve(null));
    client.on("close", () => {
      try {
        const lines = buf.trim().split("\n").filter(Boolean);
        const parsed = JSON.parse(lines[lines.length - 1] || "{}");
        resolve(parsed.data ?? null);
      } catch { resolve(null); }
    });
  });
}

const mpvGet  = (p: string)     => mpvIpc({ command: ["get_property", p] }).then(v => v != null ? String(v) : null);
const mpvSet  = (p: string, v: any) => mpvIpc({ command: ["set_property", p, v] });
const mpvCycle = (p: string)    => mpvIpc({ command: ["cycle", p] });

// ── Playback state ─────────────────────────────────────────────────────────
let mpvProcess: ChildProcess | null = null;
let mpvPid: number | null = null;
let currentTrack = { title: "", url: "" };
let isPlaying    = false;
let isPaused     = false;
let isLooping    = false;
let cachedDur    = 0;
let trackQueue: { title: string; url: string }[] = [];
let history: { title: string; url: string; playedAt: number }[] = [];
let statusCtx: any = null;
let cfg: DjConfig;
let musicDir: string;
let tools: { mpv: string|null; ytdlp: string|null; ffmpeg: string|null; scdl: string|null; python: string|null; cliamp: string|null };

// ── Status bar ─────────────────────────────────────────────────────────────
function fmt(s: number): string {
  return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,"0")}`;
}

async function updateStatus() {
  if (!statusCtx) return;
  if (!isPlaying || !currentTrack.title) {
    statusCtx.ui.setStatus("pi-dj", statusCtx.ui.theme.fg("dim", "🎵 stopped"));
    return;
  }
  // Only make IPC call when actually playing
  const pos = ipcReady ? await mpvGet("time-pos") : null;
  const theme = statusCtx.ui.theme;
  const icon  = isPaused ? "⏸" : isLooping ? "🔁" : "▶";
  const color = isPaused ? "warning" : "success";
  let title   = currentTrack.title;
  if (title.length > 42) title = title.slice(0, 39) + "...";
  const time  = (pos && cachedDur) ? theme.fg("dim", ` ${fmt(+pos)}/${fmt(cachedDur)}`) : "";
  const q     = trackQueue.length  ? theme.fg("muted", ` [+${trackQueue.length}]`) : "";
  statusCtx.ui.setStatus("pi-dj", theme.fg(color, icon) + " " + theme.fg("text", title) + time + q);
}

function killMpv() {
  ipcReady = false;
  if (mpvProcess) { try { mpvProcess.kill("SIGTERM"); } catch {} mpvProcess = null; }
  mpvPid = null; isPlaying = false; isPaused = false; cachedDur = 0;
  currentTrack = { title: "", url: "" };
}

// ── yt-dlp binary ─────────────────────────────────────────────────────────
function ytdlpBin(): string {
  if (tools?.ytdlp) return tools.ytdlp;
  const candidates = IS_WIN
    ? [`${HOME}\\AppData\\Local\\Programs\\Python\\Python311\\Scripts\\yt-dlp.exe`,
       `${HOME}\\AppData\\Roaming\\Python\\Python311\\Scripts\\yt-dlp.exe`]
    : ["/usr/local/bin/yt-dlp", `${HOME}/.local/bin/yt-dlp`];
  for (const c of candidates) if (existsSync(c)) return c;
  return "yt-dlp";
}

// ── Stream player: mpv preferred, cliamp fallback ─────────────────────────
// Returns the label for now-playing, or throws on no player available.
function playStream(url: string, label: string): void {
  if (tools?.mpv) {
    if (mpvProcess) { try { mpvProcess.kill(); } catch {} }
    mpvProcess = spawn(tools.mpv, [
      "--no-video", "--idle=yes",
      `--input-ipc-server=${IPC_PATH}`,
      `--title=${label}`,
      url,
    ], { stdio: "ignore" });
    mpvProcess.unref();
  } else if (tools?.cliamp) {
    // cliamp opens as a TUI — spawn detached so it gets its own terminal
    spawn(tools.cliamp, [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    throw new Error(`No player found. ${installHint()}`);
  }
  isPlaying = true; isPaused = false;
  updateStatus();
}

// ── Resolve a single track ─────────────────────────────────────────────────
async function resolveTrack(query: string): Promise<{ title: string; url: string } | null> {
  const isUrl = /^https?:\/\//.test(query);
  const arg = isUrl ? `"${query}"` : `"ytsearch:${query.replace(/"/g, '\\"')}"`;
  try {
    const out = execSync(
      `${ytdlpBin()} ${arg} --print title --print webpage_url --no-playlist`,
      { encoding: "utf-8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] }
    ).trim().split(/\r?\n/);
    return out[1] ? { title: out[0] || query, url: out[1] } : null;
  } catch { return null; }
}

// ── Resolve a playlist (up to 50 tracks) ──────────────────────────────────
async function resolvePlaylist(url: string): Promise<{ title: string; url: string }[]> {
  try {
    const out = execSync(
      `${ytdlpBin()} "${url}" --flat-playlist --print title --print webpage_url --playlist-end 50`,
      { encoding: "utf-8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] }
    ).trim().split(/\r?\n/);
    const tracks: { title: string; url: string }[] = [];
    for (let i = 0; i + 1 < out.length; i += 2)
      if (out[i+1]?.startsWith("http")) tracks.push({ title: out[i], url: out[i+1] });
    return tracks;
  } catch { return []; }
}

// ── Play a track ──────────────────────────────────────────────────────────
async function playTrack(url: string, title?: string): Promise<string> {
  killMpv();
  if (!title) {
    try {
      title = execSync(`${ytdlpBin()} --print title "${url}" --no-playlist`,
        { encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim() || url;
    } catch { title = url; }
  }
  currentTrack = { title, url };
  history.unshift({ title, url, playedAt: Date.now() });
  if (history.length > 50) history.length = 50;

  const args = ["--no-video", "--really-quiet", "--ytdl-format=bestaudio/best",
    `--input-ipc-server=${IPC_PATH}`];
  if (IS_TERMUX) args.push("--ao=opensles");
  if (isLooping)  args.push("--loop-file=inf");
  args.push(url);

  mpvProcess = spawn("mpv", args, { stdio: "ignore", detached: true });
  mpvPid = mpvProcess.pid ?? null;
  isPlaying = true; isPaused = false;
  mpvProcess.unref();
  mpvProcess.on("exit", () => {
    ipcReady = false; isPlaying = false; mpvProcess = null; mpvPid = null; cachedDur = 0;
    if (trackQueue.length) { const n = trackQueue.shift()!; playTrack(n.url, n.title); }
    else updateStatus();
  });

  // Wait for IPC socket (poll fast, give up after 5s)
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (existsSync(IPC_PATH)) { ipcReady = true; break; }
  }
  // Query duration once stream loads (retry a few times — mpv may not have it immediately)
  if (ipcReady) {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 200));
      const d = await mpvGet("duration");
      if (d) { cachedDur = parseFloat(d); break; }
    }
  }
  updateStatus();
  return title;
}

async function togglePause() {
  if (ipcReady) { await mpvCycle("pause"); isPaused = !isPaused; }
  else if (mpvPid && !IS_WIN) {
    try { process.kill(mpvPid, isPaused ? "SIGCONT" : "SIGSTOP"); isPaused = !isPaused; } catch {}
  }
}

// ── yt-dlp download helper (module-level — used by /sc, /bandcamp, /bandlab) ──
async function ytdlpDownload(url: string, outDir: string, ctx: any): Promise<boolean> {
  if (!tools.ytdlp) { ctx.ui.notify("yt-dlp not found. pip install yt-dlp", "warning"); return false; }
  try {
    execFileSync(ytdlpBin(), [
      "-x", "--audio-format", "mp3", "--audio-quality", "0",
      "-o", `${outDir}/%(uploader)s/%(album,)s%(track_number& - ,)s%(title)s.%(ext)s`, url,
    ], { timeout: 120000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    ctx.ui.notify(`✅ Downloaded to ${outDir}`, "success");
    return true;
  } catch (e: any) {
    ctx.ui.notify(`Download failed: ${String(e.message || e).slice(0, 200)}`, "error");
    return false;
  }
}

// ── UNC path helper — makes C:/... safe in ffmpeg filter option strings ───
// Colons in Windows paths break ffmpeg's filter option delimiter; UNC avoids it.
function toUnc(p: string): string {
  return IS_WIN ? p.replace(/^([A-Za-z]):\//, "//$1$/").replace(/\\/g, "/") : p;
}

// ── Radio Browser station type ─────────────────────────────────────────────
interface RadioStation { name: string; url_resolved: string; country: string; tags: string; votes: number; }

// Search Radio Browser (https://api.radio-browser.info) — 30k+ stations, no key needed.
// Tries country+tag split for multi-word queries, then falls back to tag+name merge.
async function radioSearch(query: string): Promise<RadioStation[]> {
  const RADIO_APIS = [
    "https://de1.api.radio-browser.info/json",
    "https://nl1.api.radio-browser.info/json",
    "https://at1.api.radio-browser.info/json",
  ];
  const parts = query.split(/\s+/);

  async function search(endpoint: string): Promise<RadioStation[]> {
    for (const api of RADIO_APIS) {
      try {
        const res = await fetch(`${api}${endpoint}&hidebroken=true&order=votes&reverse=true&limit=5`);
        if (res.ok) return await res.json() as RadioStation[];
      } catch { /* try next mirror */ }
    }
    return [];
  }

  // Multi-word: try last word as country, rest as tag
  if (parts.length > 1) {
    const country = parts[parts.length - 1];
    const tag = parts.slice(0, -1).join(" ");
    const byCountry = await search(`/stations/bycountry/${encodeURIComponent(country)}?tag=${encodeURIComponent(tag)}`);
    if (byCountry.length) return byCountry;
  }

  // Single-word (or country filter yielded nothing): merge tag + name results
  const term = query;
  const [byTag, byName] = await Promise.all([
    search(`/stations/bytag/${encodeURIComponent(term)}`),
    search(`/stations/byname/${encodeURIComponent(term)}`),
  ]);
  const seen = new Set<string>();
  const merged: RadioStation[] = [];
  for (const s of [...byTag, ...byName]) {
    if (!seen.has(s.url_resolved)) { seen.add(s.url_resolved); merged.push(s); }
  }
  return merged.sort((a, b) => b.votes - a.votes).slice(0, 5);
}

// ── Audio file detection ──────────────────────────────────────────────────
const AUDIO_EXTS = new Set([".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac", ".opus", ".wma"]);
function isAudioFile(f: string): boolean { return AUDIO_EXTS.has(extname(f).toLowerCase()); }

// ── Extension ─────────────────────────────────────────────────────────────
export default function piDj(pi: ExtensionAPI) {
  let statusInterval: ReturnType<typeof setInterval> | null = null;

  pi.on("session_start", async (_e, ctx) => {
    statusCtx = ctx;
    cfg       = loadConfig();
    musicDir  = getMusicDir(cfg);
    tools     = {
      mpv:    which("mpv"),
      ytdlp:  which("yt-dlp"),
      ffmpeg: which("ffmpeg"),
      scdl:   which("scdl"),
      python: which("python3") || which("python"),
      cliamp: which("cliamp") || (existsSync(join(HOME, "bin", "cliamp.exe")) ? join(HOME, "bin", "cliamp.exe") : null),
    };
    for (const sub of ["Lyria","Suno","SoundCloud","Bandcamp","BandLab","Videos"])
      try { mkdirSync(join(musicDir, sub), { recursive: true }); } catch {}
    updateStatus();
    if (statusInterval) clearInterval(statusInterval);
    statusInterval = setInterval(updateStatus, 3000);
  });

  pi.on("session_shutdown", async () => {
    if (statusInterval) clearInterval(statusInterval);
    killMpv();
  });

  // ── /dj-play ─────────────────────────────────────────────────────────
  pi.registerCommand("dj-play", {
    description: "Stream music via mpv — YouTube search, URL, or playlist. /dj-play <query|url>",
    handler: async (args, ctx) => {
      const query = args?.trim();
      if (!query) {
        if (isPlaying) { await togglePause(); ctx.ui.notify(isPaused ? "⏸ Paused" : "▶ Playing", "info"); updateStatus(); }
        else ctx.ui.notify("Usage: /dj-play <search query, YouTube URL, or playlist URL>", "info");
        return;
      }
      if (!tools.mpv)   { ctx.ui.notify(`mpv not found. ${installHint()}`, "warning"); return; }
      if (!tools.ytdlp) { ctx.ui.notify("yt-dlp not found. pip install yt-dlp", "warning"); return; }

      // Playlist?
      if (/[?&]list=|\/playlist\?|\/sets\//.test(query)) {
        ctx.ui.notify("🎵 Loading playlist...", "info");
        const tracks = await resolvePlaylist(query);
        if (!tracks.length) { ctx.ui.notify("No tracks found", "warning"); return; }
        const [first, ...rest] = tracks;
        trackQueue.unshift(...rest);
        await playTrack(first.url, first.title);
        ctx.ui.notify(`▶ ${first.title} (+${rest.length} queued)`, "success");
        return;
      }

      ctx.ui.notify(`🔍 ${query}...`, "info");
      const track = await resolveTrack(query);
      if (!track) { ctx.ui.notify(`No results: ${query}`, "warning"); return; }
      await playTrack(track.url, track.title);
      ctx.ui.notify(`▶ ${currentTrack.title}`, "success");
    },
  });

  // ── /pause ────────────────────────────────────────────────────────────
  pi.registerCommand("pause", {
    description: "Toggle pause",
    handler: async (_a, ctx) => {
      if (!isPlaying) { ctx.ui.notify("Nothing playing", "info"); return; }
      await togglePause();
      ctx.ui.notify(isPaused ? "⏸ Paused" : "▶ Playing", "info");
      updateStatus();
    },
  });

  // ── /stop ─────────────────────────────────────────────────────────────
  pi.registerCommand("stop", {
    description: "Stop playback and clear queue",
    handler: async (_a, ctx) => {
      trackQueue.length = 0; killMpv(); updateStatus();
      ctx.ui.notify("⏹ Stopped", "info");
    },
  });

  // ── /np ───────────────────────────────────────────────────────────────
  pi.registerCommand("np", {
    description: "Now playing",
    handler: async (_a, ctx) => {
      if (!isPlaying) { ctx.ui.notify("Nothing playing", "info"); return; }
      const pos = ipcReady ? await mpvGet("time-pos") : null;
      let msg = `${isPaused?"⏸":"▶"} ${currentTrack.title}`;
      if (pos && cachedDur) msg += `\n  ${fmt(+pos)} / ${fmt(cachedDur)}`;
      if (isLooping) msg += "  🔁";
      if (trackQueue.length) msg += `\n  Next: ${trackQueue[0].title}`;
      ctx.ui.notify(msg, "info");
    },
  });

  // ── /vol ──────────────────────────────────────────────────────────────
  pi.registerCommand("vol", {
    description: "Set volume 0-100. /vol 75",
    handler: async (args, ctx) => {
      const vol = parseInt(args?.trim() ?? "");
      if (isNaN(vol) || vol < 0 || vol > 100) {
        const cur = ipcReady ? await mpvGet("volume") : null;
        ctx.ui.notify(`🔊 ${cur ? Math.round(+cur)+"%" : "volume unknown"}`, "info"); return;
      }
      await mpvSet("volume", vol);
      ctx.ui.notify(`🔊 ${vol}%`, "info");
    },
  });

  // ── /queue ────────────────────────────────────────────────────────────
  pi.registerCommand("queue", {
    description: "Queue a track. /queue <search query|URL>",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        if (!trackQueue.length) { ctx.ui.notify("Queue empty", "info"); return; }
        ctx.ui.notify(`📋 Queue (${trackQueue.length}):\n` +
          trackQueue.map((t,i) => `${i+1}. ${t.title}`).join("\n"), "info");
        return;
      }
      if (!tools.ytdlp) { ctx.ui.notify("yt-dlp required. pip install yt-dlp", "warning"); return; }
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

  // ── /skip ─────────────────────────────────────────────────────────────
  pi.registerCommand("skip", {
    description: "Skip to next track",
    handler: async (_a, ctx) => {
      if (!trackQueue.length) { killMpv(); updateStatus(); ctx.ui.notify("Queue empty — stopped", "info"); return; }
      killMpv();
      const next = trackQueue.shift()!;
      await playTrack(next.url, next.title);
      ctx.ui.notify(`⏭ ${next.title}${trackQueue.length ? ` (+${trackQueue.length})` : ""}`, "success");
    },
  });

  // ── /repeat ───────────────────────────────────────────────────────────
  pi.registerCommand("repeat", {
    description: "Toggle loop current track",
    handler: async (_a, ctx) => {
      isLooping = !isLooping;
      if (ipcReady) await mpvSet("loop-file", isLooping ? "inf" : "no");
      ctx.ui.notify(isLooping ? "🔁 Repeat ON" : "Repeat OFF", "info");
      updateStatus();
    },
  });

  // ── /history ──────────────────────────────────────────────────────────
  pi.registerCommand("history", {
    description: "Recently played tracks",
    handler: async (_a, ctx) => {
      if (!history.length) { ctx.ui.notify("No history yet", "info"); return; }
      const list = history.slice(0, 10).map((t, i) => {
        const ago = Math.round((Date.now() - t.playedAt) / 60000);
        const time = ago < 1 ? "just now" : ago < 60 ? `${ago}m ago` : `${Math.round(ago/60)}h ago`;
        return `${i+1}. ${t.title} (${time})`;
      }).join("\n");
      ctx.ui.notify(`📜 Recent:\n${list}`, "info");
    },
  });

  // ── /dj-lib — browse local music library ────────────────────────────
  pi.registerCommand("dj-lib", {
    description: "Browse local music library. /dj-lib [subdirectory]",
    handler: async (args, ctx) => {
      const sub = args?.trim();
      const dir = sub ? join(musicDir, sub) : musicDir;
      if (!existsSync(dir)) { ctx.ui.notify(`Music dir not found: ${dir}`, "warning"); return; }

      let entries: string[];
      try { entries = readdirSync(dir); } catch { ctx.ui.notify(`Cannot read: ${dir}`, "warning"); return; }

      const subdirs = entries.filter(e => { try { return statSync(join(dir, e)).isDirectory(); } catch { return false; } });
      const files = entries.filter(e => isAudioFile(e));

      if (!subdirs.length && !files.length) { ctx.ui.notify(`No music found in: ${dir}`, "info"); return; }

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
    },
  });

  // ── /dj-viz — launch terminal visualizer ──────────────────────────────
  pi.registerCommand("dj-viz", {
    description: "Terminal audio visualizer. /dj-viz [file]",
    handler: async (args, ctx) => {
      const file = args?.trim();
      ctx.ui.notify(
        "🎨 Starting visualizer...\nUse /djvj in pi-djvj for 100+ shader modes.\n" +
        (file ? `For this file: try /djvj or ffplay -showmode 1 "${file}"` : "Run /djvj to launch the full visualizer."),
        "info"
      );
    },
  });

  // ── /sc — actually runs scdl/yt-dlp, no LLM delegation ───────────────
  pi.registerCommand("sc", {
    description: "Download from SoundCloud → MP3. /sc <url>",
    handler: async (args, ctx) => {
      const url = args?.trim();
      if (!url) { ctx.ui.notify("Usage: /sc <soundcloud url>", "warning"); return; }
      const outDir = join(musicDir, "SoundCloud");
      ctx.ui.notify("☁️ Downloading...", "info");
      try {
        if (tools.scdl) {
          execFileSync("scdl", ["-l", url, "--path", outDir, "--mp3", "--onlymp3"], { timeout: 120000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
        } else if (tools.ytdlp) {
          execFileSync(ytdlpBin(), [url, "-x", "--audio-format", "mp3", "--audio-quality", "0", "-o", `${outDir}/%(uploader)s/%(title)s.%(ext)s`], { timeout: 120000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
        } else {
          ctx.ui.notify("Neither scdl nor yt-dlp found. pip install scdl", "warning"); return;
        }
        ctx.ui.notify(`✅ Downloaded to ${outDir}`, "success");
      } catch (e: any) {
        ctx.ui.notify(`Download failed: ${String(e.message || e).slice(0, 200)}`, "error");
      }
    },
  });

  // ── /bandcamp ─────────────────────────────────────────────────────────
  pi.registerCommand("bandcamp", {
    description: "Download from Bandcamp → MP3. /bandcamp <url>",
    handler: async (args, ctx) => {
      const url = args?.trim();
      if (!url) { ctx.ui.notify("Usage: /bandcamp <url>", "warning"); return; }
      ctx.ui.notify("🎸 Downloading from Bandcamp...", "info");
      await ytdlpDownload(url, join(musicDir, "Bandcamp"), ctx);
    },
  });

  // ── /bandlab ──────────────────────────────────────────────────────────
  // Supports: track, post, revision, album, collection URLs
  // bandlab.com/track/<id>           → single track
  // bandlab.com/post/<id>            → single post
  // bandlab.com/<user>/albums/<id>   → full album
  // bandlab.com/<user>/collections/<id> → playlist
  pi.registerCommand("bandlab", {
    description: "Download from BandLab → MP3. /bandlab <url>",
    handler: async (args, ctx) => {
      const url = args?.trim();
      if (!url) {
        ctx.ui.notify(
          "Usage: /bandlab <url>\n\n" +
          "Supported URLs:\n" +
          "  bandlab.com/track/<id>           — single track\n" +
          "  bandlab.com/post/<id>            — single post\n" +
          "  bandlab.com/revision/<id>        — specific revision\n" +
          "  bandlab.com/<user>/albums/<id>   — full album\n" +
          "  bandlab.com/<user>/collections/<id> — collection",
          "info"
        );
        return;
      }
      if (!url.includes("bandlab.com")) {
        ctx.ui.notify("Not a BandLab URL. Expected bandlab.com/...", "warning"); return;
      }
      const isPlaylist = /\/albums\/|\/collections\//.test(url);
      ctx.ui.notify(isPlaylist ? "💿 Downloading BandLab album/collection..." : "🎵 Downloading from BandLab...", "info");
      await ytdlpDownload(url, join(musicDir, "BandLab"), ctx);
    },
  });

  // ── /mix — runs ffmpeg directly ───────────────────────────────────────
  pi.registerCommand("mix", {
    description: "Crossfade two tracks. /mix <a> <b> [secs=4]",
    handler: async (args, ctx) => {
      const parts = (args?.trim() || "").split(/\s+/);
      const [a, b, xfade = "4"] = parts;
      if (!a || !b) { ctx.ui.notify("Usage: /mix <track-a> <track-b> [crossfade-secs]", "warning"); return; }
      if (!tools.ffmpeg) { ctx.ui.notify(`ffmpeg not found. ${installHint()}`, "warning"); return; }
      const out = join(musicDir, "Lyria", `mix_${Date.now()}.mp3`);
      ctx.ui.notify(`🎚️ Crossfading ${xfade}s...`, "info");
      try {
        execFileSync("ffmpeg", [
          "-i", a, "-i", b, "-filter_complex",
          `[0][1]acrossfade=d=${xfade}:c1=tri:c2=tri[out]`,
          "-map", "[out]", out, "-y",
        ], { timeout: 120000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
        ctx.ui.notify(`✅ Saved: ${basename(out)}`, "success");
      } catch (e: any) {
        ctx.ui.notify(`Mix failed: ${String(e.message || e).slice(0, 200)}`, "error");
      }
    },
  });

  // /trim removed — use pi-ffmpeg's /trim instead (cross-platform, more features)

  // ── /bpm — runs librosa/sox directly ─────────────────────────────────
  pi.registerCommand("bpm", {
    description: "Detect BPM. /bpm <file>",
    handler: async (args, ctx) => {
      const file = args?.trim();
      if (!file) { ctx.ui.notify("Usage: /bpm <file>", "warning"); return; }
      ctx.ui.notify("🥁 Detecting BPM...", "info");
      try {
        // Try librosa first
        const py = tools.python || "python3";
        const result = execSync(
          `${py} -c "import librosa; y,sr=librosa.load('${file}'); t,_=librosa.beat.beat_track(y=y,sr=sr); print(f'{t:.1f}')"`,
          { encoding: "utf-8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] }
        ).trim();
        if (result) { ctx.ui.notify(`🥁 BPM: ${result}`, "success"); return; }
      } catch {}
      try {
        // bpm-tools fallback
        const result = execSync(
          `sox "${file}" -t raw -r 44100 -e float -c 1 - | bpm`,
          { encoding: "utf-8", timeout: 30000, shell: IS_WIN ? "cmd.exe" : "/bin/sh" }
        ).trim();
        if (result) { ctx.ui.notify(`🥁 BPM: ${result}`, "success"); return; }
      } catch {}
      ctx.ui.notify("BPM detection failed. Install librosa: pip install librosa", "warning");
    },
  });

  // ── /render — ffmpeg music video (bars|wave|circle|cqt) ─────────────
  pi.registerCommand("render", {
    description: "Render a music video with ffmpeg. /render <file|url> [bars|wave|circle|cqt]",
    handler: async (args, ctx) => {
      const parts = (args?.trim() || "").split(/\s+/);
      const [audioArg, styleArg = "bars"] = parts;
      const STYLES = ["bars", "wave", "circle", "cqt"];

      if (!audioArg) {
        ctx.ui.notify(
          "Usage: /render <audio-file|youtube-url> [style]\n\n" +
          "Styles:\n" +
          "  bars   — scrolling FFT spectrum (default)\n" +
          "  wave   — waveform lines\n" +
          "  circle — L/R vectorscope Lissajous\n" +
          "  cqt    — piano-roll CQT (best looking)\n\n" +
          "Examples:\n" +
          "  /render ~/Music/track.mp3\n" +
          "  /render ~/Music/track.mp3 cqt\n" +
          "  /render https://youtu.be/xxx circle",
          "info"
        );
        return;
      }
      if (!STYLES.includes(styleArg)) {
        ctx.ui.notify(`Unknown style "${styleArg}". Use: ${STYLES.join(" | ")}`, "warning"); return;
      }
      if (!tools.ffmpeg) { ctx.ui.notify(`ffmpeg not found. ${installHint()}`, "warning"); return; }

      // Resolve: if URL, download audio first
      let audioFile = audioArg;
      if (/^https?:\/\//.test(audioArg)) {
        if (!tools.ytdlp) { ctx.ui.notify("yt-dlp required for URL. pip install yt-dlp", "warning"); return; }
        ctx.ui.notify("⬇️ Downloading audio...", "info");
        try {
          const dlOut = execSync(
            `${ytdlpBin()} -x --audio-format mp3 --audio-quality 0` +
            ` -o "${join(musicDir, "Videos")}/%(title)s.%(ext)s"` +
            ` --print after_move:filepath "${audioArg}"`,
            { encoding: "utf-8", timeout: 120000, stdio: ["ignore", "pipe", "ignore"] }
          ).trim().split(/\r?\n/).pop() || "";
          if (!dlOut || !existsSync(dlOut)) { ctx.ui.notify("Download failed", "error"); return; }
          audioFile = dlOut;
        } catch (e: any) {
          ctx.ui.notify(`Download failed: ${String(e.message).slice(0, 200)}`, "error"); return;
        }
      } else {
        audioFile = audioFile.replace(/^~/, HOME);
        if (!existsSync(audioFile)) { ctx.ui.notify(`File not found: ${audioFile}`, "warning"); return; }
      }

      // Font — bundled in assets/ next to this extension
      // jiti injects __dirname as the real extension directory — use it directly.
      // eslint-disable-next-line no-undef
      const extDir: string = __dirname;
      const fontB = join(extDir, "..", "assets", "Inter-Bold.ttf").replace(/\\/g, "/").replace(/^\/([a-z])\//i, "$1:/");
      const fontR = join(extDir, "..", "assets", "Inter-Regular.ttf").replace(/\\/g, "/").replace(/^\/([a-z])\//i, "$1:/");

      // Extract title/artist from filename: "Artist - Title.mp3" or "Title.mp3"
      const stem = basename(audioFile, extname(audioFile));
      const [titlePart, artistPart] = stem.includes(" - ")
        ? [stem.split(" - ").slice(1).join(" - "), stem.split(" - ")[0]]
        : [stem, ""];

      // Escape text for ffmpeg drawtext (: and ' are special)
      const esc = (s: string) => s.replace(/'/g, "\u2019").replace(/:/g, "\\:").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
      const title  = esc(titlePart.slice(0, 50));
      const artist = esc(artistPart.slice(0, 40));

      const outFile = join(musicDir, "Videos", `${stem}_${styleArg}.mp4`);
      mkdirSync(join(musicDir, "Videos"), { recursive: true });

      // Build ffmpeg filtergraph per style
      const textOverlay =
        `drawtext=text='${title}':fontfile='${fontB}':fontsize=64:fontcolor=white:x=60:y=60:shadowcolor=black:shadowx=2:shadowy=2` +
        (artist ? `,drawtext=text='${artist}':fontfile='${fontR}':fontsize=26:fontcolor=0x888888:x=60:y=138:shadowcolor=black:shadowx=1:shadowy=1` : "");

      const filters: Record<string, string> = {
        bars:   `[0:a]showspectrum=s=1080x1080:mode=combined:color=rainbow:scale=cbrt:slide=scroll[v];[v]${textOverlay}[out]`,
        wave:   `[0:a]showwaves=s=1080x1080:mode=cline:scale=sqrt:colors=0x5566ff|0xaa44ff:draw=full[v];[v]${textOverlay}[out]`,
        circle: `[0:a]avectorscope=s=1080x1080:zoom=2:draw=line:scale=sqrt:rc=0:gc=200:bc=255:rf=0:gf=40:bf=80[v];[v]${textOverlay}[out]`,
        cqt:    `[0:a]showcqt=s=1080x1080:count=6:csp=bt709:bar_g=2:sono_g=4[v];[v]${textOverlay}[out]`,
      };

      ctx.ui.notify(`🎬 Rendering ${styleArg}...\n${basename(outFile)}`, "info");
      try {
        execSync(
          `ffmpeg -y -i "${audioFile}" -filter_complex "${filters[styleArg]}"` +
          ` -map "[out]" -map 0:a -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k -shortest "${outFile}"`,
          { encoding: "utf-8", timeout: 600000 }
        );
        ctx.ui.notify(`✅ Saved: ${basename(outFile)}`, "success");
      } catch (e: any) {
        ctx.ui.notify(`Render failed: ${String(e.message || e).slice(0, 300)}`, "error");
      }
    },
  });

  // ── SRT → ASS converter ─────────────────────────────────────────────
  function srtToAss(srt: string, style: string): string {
    const header = [
      "[Script Info]",
      "ScriptType: v4.00+",
      "PlayResX: 1920",
      "PlayResY: 1080",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      style === "outline"
        ? "Style: Default,Inter,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,2,60,60,60,1"
        : style === "simple"
        ? "Style: Default,Inter,56,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,60,60,80,1"
        : "Style: Default,Inter,64,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,2,60,60,60,1",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ].join("\n");

    // Parse SRT blocks
    const blocks = srt.trim().split(/\r?\n\r?\n/).filter(Boolean);
    const events: string[] = [];
    for (const block of blocks) {
      const lines = block.trim().split(/\r?\n/);
      if (lines.length < 3) continue;
      const timeMatch = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
      if (!timeMatch) continue;
      const [, sh, sm, ss, sms, eh, em, es, ems] = timeMatch;
      const start = `${sh}:${sm}:${ss}.${sms.slice(0, 2)}`;
      const end   = `${eh}:${em}:${es}.${ems.slice(0, 2)}`;
      const text  = lines.slice(2).join("\\N");

      if (style === "karaoke") {
        // Calculate duration in centiseconds for karaoke effect
        const durMs = (+eh * 3600 + +em * 60 + +es) * 1000 + +ems - ((+sh * 3600 + +sm * 60 + +ss) * 1000 + +sms);
        const durCs = Math.round(durMs / 10);
        events.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,{\\kf${durCs}}${text}`);
      } else {
        events.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`);
      }
    }

    return header + "\n" + events.join("\n") + "\n";
  }

  // ── /subs ─────────────────────────────────────────────────────────────
  // Transcribe audio → SRT → burn as karaoke ASS subtitles into music video
  // Pipeline: audio → ffmpeg whisper filter → .srt → convert to .ass (karaoke) → burn
  // Uses ggml-base.en.bin (142MB) from whisper.cpp — auto-downloads if missing
  // Windows trick: use //localhost/C$/... UNC path to avoid C: colon in ffmpeg filter options
  pi.registerCommand("subs", {
    description: [
      "Transcribe + burn karaoke subtitles into a music video.",
      "Usage: /subs <audio-or-video-file> [style]",
      "Styles: karaoke (default) | simple | outline",
      "Output: ~/Music/Videos/<name>_subs.mp4",
      "",
      "Auto-downloads ggml-base.en.bin (~142MB) if not found.",
      "Examples:",
      "  /subs ~/Music/track.mp3",
      "  /subs ~/Music/Videos/track_bars.mp4 karaoke",
    ].join("\n"),
    handler: async (args, ctx) => {
      const parts = (args?.trim() || "").split(/\s+/);
      const [inputArg, styleArg = "karaoke"] = parts;
      const STYLES = ["karaoke", "simple", "outline"];

      if (!inputArg) {
        ctx.ui.notify(
          "Usage: /subs <audio-or-video-file> [style]\n\nStyles: karaoke | simple | outline",
          "info"
        );
        return;
      }
      if (!STYLES.includes(styleArg)) {
        ctx.ui.notify(`Unknown style "${styleArg}". Use: ${STYLES.join(" | ")}`, "warning"); return;
      }
      if (!tools.ffmpeg) { ctx.ui.notify(`ffmpeg not found. ${installHint()}`, "warning"); return; }

      const inputFile = inputArg.replace(/^~/, HOME);
      if (!existsSync(inputFile)) { ctx.ui.notify(`File not found: ${inputFile}`, "warning"); return; }

      // Whisper model path — download if missing
      const modelPath = join(HOME, "Music", "ggml-base.en.bin");
      if (!existsSync(modelPath)) {
        ctx.ui.notify("⬇️ Downloading whisper ggml-base.en.bin (~142MB)...", "info");
        try {
          execSync(
            `curl -L -o "${modelPath}" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"`,
            { timeout: 300_000, stdio: "ignore" }
          );
        } catch {
          ctx.ui.notify("Download failed. Place ggml-base.en.bin in ~/Music/", "error"); return;
        }
      }

      const stem = basename(inputFile, extname(inputFile));
      mkdirSync(join(musicDir, "Videos"), { recursive: true });
      const srtPath = join(musicDir, "Videos", `${stem}.srt`);
      const assPath = join(musicDir, "Videos", `${stem}.ass`);
      const outFile = join(musicDir, "Videos", `${stem}_subs.mp4`);

      // Step 1: transcribe → SRT
      ctx.ui.notify("🎙️ Transcribing audio with Whisper...", "info");
      const uncModel = toUnc(modelPath);
      const uncSrt   = toUnc(srtPath);
      const uncInput = toUnc(inputFile);
      try {
        execSync(
          `ffmpeg -y -hide_banner -loglevel error` +
          ` -i "${uncInput}"` +
          ` -af "whisper=model=${uncModel}:format=srt:destination=${uncSrt}"` +
          ` -f null -`,
          { timeout: 300_000, encoding: "utf-8" }
        );
      } catch (e: any) {
        ctx.ui.notify(`Transcription failed: ${String(e.stderr || e.message).slice(0, 200)}`, "error"); return;
      }
      if (!existsSync(srtPath)) { ctx.ui.notify("Whisper produced no output — try a longer file", "warning"); return; }

      // Step 2: convert SRT → ASS with karaoke styling
      const srtContent = readFileSync(srtPath, "utf-8");
      const assContent = srtToAss(srtContent, styleArg);
      writeFileSync(assPath, assContent, "utf-8");

      // Step 3: render output — burn subs onto audio visualization (bars style)
      ctx.ui.notify(`🎬 Burning subtitles (${styleArg})...`, "info");
      const extDir: string = __dirname;
      const fontB = join(extDir, "..", "assets", "Inter-Bold.ttf").replace(/\\/g, "/").replace(/^\/([a-z])\//i, "$1:/");
      const stem2 = basename(inputFile, extname(inputFile));
      const [titlePart, artistPart] = stem2.includes(" - ")
        ? [stem2.split(" - ").slice(1).join(" - "), stem2.split(" - ")[0]]
        : [stem2, ""];
      const esc = (s: string) => s.replace(/'/g, "\u2019").replace(/:/g, "\\:").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
      const title = esc(titlePart.slice(0, 50));

      // Check if input is video or audio-only
      let hasVideo = false;
      try {
        const probe = execSync(`ffprobe -v error -select_streams v -show_entries stream=codec_type -of csv=p=0 "${uncInput}"`, { encoding: "utf-8", timeout: 5000 }).trim();
        hasVideo = probe.includes("video");
      } catch {}

      const uncAss = IS_WIN ? assPath.replace(/^([A-Za-z]):\//, "//localhost/$1$/").replace(/\\/g, "/") : assPath;

      try {
        if (hasVideo) {
          // Burn ASS onto existing video
          execSync(
            `ffmpeg -y -hide_banner -loglevel error` +
            ` -i "${uncInput}"` +
            ` -vf "ass=${uncAss.replace(/:/g, "\\:")}"` +
            ` -c:v libx264 -preset fast -crf 20 -c:a copy "${toUnc(outFile)}"`,
            { timeout: 600_000, encoding: "utf-8" }
          );
        } else {
          // Audio-only: generate spectrum viz + burn subs
          const vizFilter =
            `[0:a]showspectrum=s=1920x1080:mode=combined:color=rainbow:scale=cbrt:slide=scroll[v];` +
            `[v]drawtext=text='${title}':fontfile='${fontB}':fontsize=64:fontcolor=white:x=60:y=60:shadowcolor=black:shadowx=2:shadowy=2,` +
            `ass=${uncAss.replace(/:/g, "\\:")}[out]`;
          execSync(
            `ffmpeg -y -hide_banner -loglevel error` +
            ` -i "${uncInput}"` +
            ` -filter_complex "${vizFilter}"` +
            ` -map "[out]" -map 0:a -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k -shortest "${toUnc(outFile)}"`,
            { timeout: 600_000, encoding: "utf-8" }
          );
        }
        ctx.ui.notify(`✅ Done! ${basename(outFile)}\nSRT: ${basename(srtPath)}`, "success");
      } catch (e: any) {
        ctx.ui.notify(`Render failed: ${String(e.stderr || e.message).slice(0, 300)}`, "error");
      }
    },
  });

  // ── /radio ────────────────────────────────────────────────────────────
  // Radio Browser API (https://api.radio-browser.info) — 30k+ stations, no key needed
  // Supports: genre/tag, station name, country, or raw stream URL
  // Also routes "lyria" to cliamp's Lyria AI radio
  pi.registerCommand("radio", {
    description: [
      "Global internet radio or Lyria AI radio.",
      "/radio lofi               — find & play lofi stations",
      "/radio jazz japan         — jazz stations from Japan",
      "/radio <http url>         — play stream URL directly",
      "/radio lyria              — Lyria AI generative radio (preset 1)",
      "/radio lyria chill        — Lyria with preset name",
      "/radio lyria <1-9>        — Lyria by preset number",
    ].join("\n"),
    handler: async (args, ctx) => {
      // No args → play curated default (lofi, top station by votes)
      const query = args.trim() || "lofi";

      // ── Lyria AI radio → delegate to lyria-cli (same as cliamp) ─────────
      if (query.toLowerCase().startsWith("lyria")) {
        const lyriaPath = join(HOME, "Music", "lyria-cli", "index.js");
        if (!existsSync(lyriaPath)) {
          ctx.ui.notify(
            "lyria-cli not found.\nSetup:\n  cd ~/Music && git clone https://github.com/arosstale/lyria-cli && cd lyria-cli && npm install",
            "warning"
          );
          return;
        }
        const preset = query.replace(/^lyria\s*/i, "").trim() || "1";
        const args2 = /^\d$/.test(preset) ? [preset] : ["--prompt", preset];
        ctx.ui.notify(`🤖 Lyria AI radio — ${preset || "preset 1"}`, "info");
        spawn("node", [lyriaPath, ...args2], { detached: true, stdio: "ignore" }).unref();
        return;
      }

      // ── Raw HTTP stream URL ──────────────────────────────────────────────
      if (query.startsWith("http")) {
        if (!tools?.mpv && !tools?.cliamp) { ctx.ui.notify(`No player found. ${installHint()}`, "error"); return; }
        ctx.ui.notify(`📻 Streaming: ${query}`, "info");
        try { playStream(query, query); } catch (e: any) { ctx.ui.notify(String(e.message), "error"); }
        return;
      }

      // ── Radio Browser API search ─────────────────────────────────────────
      if (!tools?.mpv && !tools?.cliamp) { ctx.ui.notify(`No player found. ${installHint()}`, "error"); return; }

      ctx.ui.notify(`📻 Searching Radio Browser for "${query}"…`, "info");

      const stations = await radioSearch(query);
      if (!stations.length) {
        ctx.ui.notify(`No stations found for "${query}". Try a genre like: jazz, lofi, classical, pop, rock`, "warning");
        return;
      }
      const station = stations[0];
      const label = `${station.name}${station.country ? ` (${station.country})` : ""}`;
      ctx.ui.notify(
        `📻 ${label}` +
        (stations.length > 1 ? `\nOther matches: ${stations.slice(1).map(s => s.name).join(", ")}` : ""),
        "info"
      );
      try { playStream(station.url_resolved, label); }
      catch (e: any) { ctx.ui.notify(String(e.message), "error"); }
    },
  });

  // ── Strudel (live coding — pure CLI, no browser) ────────────────────
  let strudelProc: ChildProcess | null = null;
  // Try local sibling project first, then fall back to npx
  const STRUDEL_CLI = join(HOME, "Projects", "strudel-cli", "index.mjs");

  function strudelPlay(pattern: string, opts: { bpm?: number; wave?: string; cycles?: number } = {}): Promise<string> {
    return new Promise((resolve) => {
      // Kill previous if still running
      if (strudelProc) { try { strudelProc.kill(); } catch {} strudelProc = null; }

      const args = [STRUDEL_CLI, pattern];
      if (opts.bpm) args.push("--bpm", String(opts.bpm));
      if (opts.wave) args.push("--wave", opts.wave);
      args.push("--cycles", String(opts.cycles ?? 0)); // 0 = loop forever

      // Check if strudel-cli exists locally, fallback to npx
      const cmd = existsSync(STRUDEL_CLI) ? "node" : "npx";
      const cliArgs = existsSync(STRUDEL_CLI) ? args : ["strudel-cli", pattern, ...(opts.bpm ? ["--bpm", String(opts.bpm)] : []), ...(opts.wave ? ["--wave", opts.wave] : []), "--cycles", String(opts.cycles ?? 0)];

      strudelProc = spawn(cmd, cliArgs, { stdio: ["ignore", "pipe", "pipe"], shell: IS_WIN });
      let out = "";
      strudelProc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      strudelProc.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
      strudelProc.on("close", () => { strudelProc = null; resolve(out.trim()); });
      strudelProc.on("error", (e) => { strudelProc = null; resolve(`Error: ${e.message}`); });

      // Resolve immediately with "playing" since it's streaming audio
      setTimeout(() => resolve(`▶ Playing: ${pattern}`), 500);
    });
  }

  pi.registerCommand("strudel", {
    description: "Live code music with Strudel mini-notation. Usage: /strudel <pattern> [--bpm N] [--wave sine|saw|square|triangle]",
    handler: async (args, ctx) => {
      const input = (args || "").trim();
      if (!input) { ctx.ui.notify("Usage: /strudel bd*4, ~ cp ~ cp, hh*8  [--bpm 140] [--wave saw]", "info"); return; }

      // Parse --flags from the pattern
      let bpm: number | undefined;
      let wave: string | undefined;
      let cycles: number | undefined;
      let pattern = input;

      const bpmMatch = pattern.match(/--bpm\s+(\d+)/);
      if (bpmMatch) { bpm = parseInt(bpmMatch[1]); pattern = pattern.replace(bpmMatch[0], "").trim(); }
      const waveMatch = pattern.match(/--wave\s+(\w+)/);
      if (waveMatch) { wave = waveMatch[1]; pattern = pattern.replace(waveMatch[0], "").trim(); }
      const cyclesMatch = pattern.match(/--cycles\s+(\d+)/);
      if (cyclesMatch) { cycles = parseInt(cyclesMatch[1]); pattern = pattern.replace(cyclesMatch[0], "").trim(); }

      ctx.ui.notify(`🎹 Strudel: ${pattern}${bpm ? ` @ ${bpm} BPM` : ""}${wave ? ` (${wave})` : ""}`, "info");
      await strudelPlay(pattern, { bpm, wave, cycles });
    },
  });

  pi.registerCommand("strudel-stop", {
    description: "Stop Strudel playback",
    handler: async (_a, ctx) => {
      if (strudelProc) { try { strudelProc.kill(); } catch {} strudelProc = null; }
      ctx.ui.notify("🎹 Strudel stopped", "info");
    },
  });

  // ── /dj-help ──────────────────────────────────────────────────────────
  pi.registerCommand("dj-help", {
    description: "Show pi-dj commands and tool status",
    handler: async (_a, ctx) => {
      const ok  = (x: string|null) => x ? "✅" : "❌";
      const plat = IS_TERMUX ? "Termux" : IS_RPI ? "Raspberry Pi" : IS_WIN ? "Windows" : IS_MAC ? "macOS" : "Linux";
      const ipc  = ipcReady ? "Node IPC ✅" : "not connected";
      ctx.ui.notify(
        `🎧 pi-dj — ${plat}\n` +
        `mpv ${ok(tools?.mpv)}  yt-dlp ${ok(tools?.ytdlp)}  ffmpeg ${ok(tools?.ffmpeg)}  scdl ${ok(tools?.scdl)}\n` +
        `IPC: ${ipc}  |  Music: ${musicDir}\n\n` +
        `STREAMING (YouTube / mpv)\n` +
        `/dj-play <query|url>  search, URL, or playlist\n` +
        `/pause /stop /np      playback control\n` +
        `/vol <0-100>          volume\n` +
        `/queue <query>        add to queue\n` +
        `/skip                 next track\n` +
        `/repeat               toggle loop\n` +
        `/history              recently played\n` +
        `/dj-lib [dir]         browse local music library\n` +
        `/dj-viz [file]        terminal visualizer (→ /djvj for 100+ modes)\n\n` +
        `RADIO\n` +
        `/radio <genre|name>   internet radio (Radio Browser, 30k+ stations)\n` +
        `/radio jazz japan     genre + country filter\n` +
        `/radio lyria          Lyria AI generative radio\n` +
        `/radio lyria chill    Lyria with preset\n` +
        `/radio <http url>     stream URL directly\n\n` +
        `LOCAL FILES → /play (cliamp v1.15 TUI — file browser, Navidrome, SoundCloud search, webm)\n\n` +
        `DOWNLOADS\n` +
        `/sc <url>             SoundCloud → MP3\n` +
        `/bandcamp <url>       Bandcamp → MP3\n` +
        `/bandlab <url>        BandLab track/album/collection → MP3\n\n` +
        `LIVE CODING (Strudel — no browser, pure CLI)\n` +
        `/strudel <pattern> [--bpm N] [--wave saw]  play mini-notation\n` +
        `/strudel-stop                               stop playback\n` +
        `  patterns: bd*4, ~ cp ~ cp, hh*8  |  c3 e3 g3 b3  |  <c3 e3>(3,8)\n` +
        `  drums: bd sd/sn cp hh oh rim ride  |  waves: sine saw square triangle\n\n` +
        `PRODUCTION\n` +
        `/render <f> [style]   music video via ffmpeg (bars|wave|circle|cqt)\n` +
        `/subs <f> [style]     transcribe + karaoke subtitles (whisper)\n` +
        `/mix <a> <b> [s]      crossfade with ffmpeg\n` +
        `/bpm <file>           detect BPM\n` +
        `  (trim → /trim via pi-ffmpeg)\n\n` +
        `Missing tools? ${installHint()}`,
        "info"
      );
    },
  });

  // ── LLM tools ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "dj_play_music",
    label: "DJ Stream Music",
    description: "Stream music from YouTube via mpv. For local files use play_music (cliamp). For AI radio use play_music with target='lyria'.",
    parameters: Type.Object({
      query: Type.String({ description: "YouTube search query, URL, or playlist URL" }),
    }),
    async execute(_id, params) {
      if (!tools?.mpv)   return { content: [{ type: "text", text: `mpv not installed. ${installHint()}` }], isError: true };
      if (!tools?.ytdlp) return { content: [{ type: "text", text: "yt-dlp not installed. pip install yt-dlp" }], isError: true };
      const track = await resolveTrack(params.query);
      if (!track) return { content: [{ type: "text", text: `Not found: ${params.query}` }], isError: true };
      const title = await playTrack(track.url, track.title);
      return { content: [{ type: "text", text: `▶ ${title}` }] };
    },
  });

  pi.registerTool({
    name: "dj_queue_music",
    label: "DJ Queue Music",
    description: "Add a YouTube track to the mpv playback queue.",
    parameters: Type.Object({
      query: Type.String({ description: "YouTube search query or URL" }),
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

  pi.registerTool({
    name: "dj_strudel",
    label: "DJ Strudel",
    description:
      "Play live-coded algorithmic music via Strudel mini-notation (TidalCycles port). " +
      "Pure CLI — no browser, synthesizes directly to audio via ffplay. " +
      "Drum sounds: bd (kick), sd/sn (snare), cp (clap), hh (hat), oh (open hat), rim, ride. " +
      "Notes: c3, d#4, eb2, etc. Waveforms: sine, saw, square, triangle. " +
      "Use dj_strudel_stop to stop playback.",
    parameters: Type.Object({
      pattern: Type.String({ description: 'Strudel mini-notation pattern, e.g. "bd*4, ~ cp ~ cp, hh*8" or "c3 e3 g3 b3"' }),
      bpm: Type.Optional(Type.Number({ description: "Tempo in BPM (default: 120)" })),
      wave: Type.Optional(Type.String({ description: "Waveform for notes: sine, saw, square, triangle (default: sine)" })),
      cycles: Type.Optional(Type.Number({ description: "Number of cycles to play (default: 4, 0 = loop)" })),
    }),
    async execute(_id, params) {
      const r = await strudelPlay(params.pattern, { bpm: params.bpm, wave: params.wave, cycles: params.cycles });
      return { content: [{ type: "text" as const, text: `🎹 ${r}` }] };
    },
  });

  pi.registerTool({
    name: "dj_strudel_stop",
    label: "DJ Strudel Stop",
    description: "Stop the currently playing Strudel pattern.",
    parameters: Type.Object({}),
    async execute() {
      if (strudelProc) { try { strudelProc.kill(); } catch {} strudelProc = null; }
      return { content: [{ type: "text" as const, text: "🎹 Strudel stopped" }] };
    },
  });

  pi.registerTool({
    name: "dj_radio",
    label: "DJ Radio",
    description:
      "Search and play global internet radio stations via Radio Browser (30k+ stations, no API key). " +
      "Search by genre (jazz, lofi, classical), station name, or country. " +
      "Use 'lyria' for AI generative radio, or pass a direct HTTP stream URL.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Genre, station name, or country (e.g. 'lofi', 'jazz japan', 'classical germany'). " +
          "Or 'lyria' / 'lyria chill' for AI radio. Or a direct HTTP stream URL.",
      }),
    }),
    async execute(_id, params) {
      if (!tools?.mpv) return { content: [{ type: "text", text: `mpv not installed. ${installHint()}` }], isError: true };
      const q = params.query.trim();

      // Lyria
      if (q.toLowerCase().startsWith("lyria")) {
        const lyriaPath = join(HOME, "Music", "lyria-cli", "index.js");
        if (!existsSync(lyriaPath)) return { content: [{ type: "text", text: "lyria-cli not found. Run /radio lyria for setup." }], isError: true };
        const preset = q.replace(/^lyria\s*/i, "").trim() || "1";
        const args2 = /^\d$/.test(preset) ? [preset] : ["--prompt", preset];
        spawn("node", [lyriaPath, ...args2], { detached: true, stdio: "ignore" }).unref();
        return { content: [{ type: "text", text: `🤖 Lyria AI radio — ${preset}` }] };
      }

      // Direct URL
      if (q.startsWith("http")) {
        try { playStream(q, q); }
        catch (e: any) { return { content: [{ type: "text", text: String(e.message) }], isError: true }; }
        return { content: [{ type: "text", text: `📻 Streaming: ${q}` }] };
      }

      // Radio Browser search
      const stations = await radioSearch(q);
      if (!stations.length) return { content: [{ type: "text", text: `No stations found for "${q}"` }], isError: true };

      const station = stations[0];
      const label = `${station.name}${station.country ? ` (${station.country})` : ""}`;
      try { playStream(station.url_resolved, label); }
      catch (e: any) { return { content: [{ type: "text", text: String(e.message) }], isError: true }; }

      const others = stations.slice(1).map(s => s.name).join(", ");
      return {
        content: [{ type: "text", text: `📻 ${label}${others ? `\nOther matches: ${others}` : ""}` }],
      };
    },
  });
}
