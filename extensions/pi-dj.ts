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
 *   cliamp      → local files, HTTP streams, Lyria AI radio (/play /music /radio)
 *   pi-djvj     → terminal visualizer + WebGL shaders (/viz /djvj)
 *   pi-dj (this)→ YouTube streaming, downloads, production tools
 *
 * Commands:
 *   /dj-play <query|url>  — YouTube search, URL, or playlist → mpv
 *   /pause /stop /np /vol /queue /skip /repeat — playback control
 *   /history              — recently played
 *   /sc <url>             — download SoundCloud → MP3
 *   /bandcamp <url>       — download Bandcamp → MP3
 *   /bandlab <url>        — download BandLab track/album/collection → MP3
 *   /render <file|url> [style] — render music video with Remotion (bars|wave|circle)
 *   /mix <a> <b> [s]      — crossfade two tracks with ffmpeg
 *   /trim <f> <s> [e]     — trim audio clip
 *   /bpm <file>           — detect BPM
 *   /dj-help              — commands + tool status
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join, basename, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
let tools: { mpv: string|null; ytdlp: string|null; ffmpeg: string|null; scdl: string|null; python: string|null };

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

// ── Resolve a single track ─────────────────────────────────────────────────
async function resolveTrack(query: string): Promise<{ title: string; url: string } | null> {
  const isUrl = /^https?:\/\//.test(query);
  const arg = isUrl ? `"${query}"` : `"ytsearch:${query.replace(/"/g, '\\"')}"`;
  try {
    const out = execSync(
      `${ytdlpBin()} ${arg} --print title --print webpage_url --no-playlist 2>/dev/null`,
      { encoding: "utf-8", timeout: 20000 }
    ).trim().split(/\r?\n/);
    return out[1] ? { title: out[0] || query, url: out[1] } : null;
  } catch { return null; }
}

// ── Resolve a playlist (up to 50 tracks) ──────────────────────────────────
async function resolvePlaylist(url: string): Promise<{ title: string; url: string }[]> {
  try {
    const out = execSync(
      `${ytdlpBin()} "${url}" --flat-playlist --print title --print webpage_url --playlist-end 50 2>/dev/null`,
      { encoding: "utf-8", timeout: 30000 }
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
      title = execSync(`${ytdlpBin()} --print title "${url}" --no-playlist 2>/dev/null`,
        { encoding: "utf-8", timeout: 10000 }).trim() || url;
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
          execSync(`scdl -l "${url}" --path "${outDir}" --mp3 --onlymp3 2>&1`, { timeout: 120000, encoding: "utf-8" });
        } else if (tools.ytdlp) {
          execSync(`${ytdlpBin()} "${url}" -x --audio-format mp3 --audio-quality 0 -o "${outDir}/%(uploader)s/%(title)s.%(ext)s" 2>&1`, { timeout: 120000, encoding: "utf-8" });
        } else {
          ctx.ui.notify("Neither scdl nor yt-dlp found. pip install scdl", "warning"); return;
        }
        ctx.ui.notify(`✅ Downloaded to ${outDir}`, "success");
      } catch (e: any) {
        ctx.ui.notify(`Download failed: ${String(e.message || e).slice(0, 200)}`, "error");
      }
    },
  });

  // ── shared yt-dlp download helper ────────────────────────────────────
  async function ytdlpDownload(url: string, outDir: string, ctx: any): Promise<boolean> {
    if (!tools.ytdlp) { ctx.ui.notify("yt-dlp not found. pip install yt-dlp", "warning"); return false; }
    try {
      execSync(
        `${ytdlpBin()} -x --audio-format mp3 --audio-quality 0 -o "${outDir}/%(uploader)s/%(album,)s%(track_number& - ,)s%(title)s.%(ext)s" "${url}" 2>&1`,
        { timeout: 120000, encoding: "utf-8" }
      );
      ctx.ui.notify(`✅ Downloaded to ${outDir}`, "success");
      return true;
    } catch (e: any) {
      ctx.ui.notify(`Download failed: ${String(e.message || e).slice(0, 200)}`, "error");
      return false;
    }
  }

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
        execSync(
          `ffmpeg -i "${a}" -i "${b}" -filter_complex "[0][1]acrossfade=d=${xfade}:c1=tri:c2=tri[out]" -map "[out]" "${out}" -y 2>&1`,
          { timeout: 120000, encoding: "utf-8" }
        );
        ctx.ui.notify(`✅ Saved: ${basename(out)}`, "success");
      } catch (e: any) {
        ctx.ui.notify(`Mix failed: ${String(e.message || e).slice(0, 200)}`, "error");
      }
    },
  });

  // ── /trim — runs ffmpeg directly ──────────────────────────────────────
  pi.registerCommand("trim", {
    description: "Trim audio clip. /trim <file> <start-sec> [end-sec]",
    handler: async (args, ctx) => {
      const parts = (args?.trim() || "").split(/\s+/);
      const [file, start = "0", end] = parts;
      if (!file) { ctx.ui.notify("Usage: /trim <file> <start> [end] (seconds)", "warning"); return; }
      if (!tools.ffmpeg) { ctx.ui.notify(`ffmpeg not found. ${installHint()}`, "warning"); return; }
      const out = join(musicDir, "Lyria", `trim_${Date.now()}.mp3`);
      ctx.ui.notify(`✂️ Trimming ${start}s${end ? `–${end}s` : "+"}...`, "info");
      try {
        execSync(
          `ffmpeg -i "${file}" -ss ${start}${end ? ` -to ${end}` : ""} -c copy "${out}" -y 2>&1`,
          { timeout: 60000, encoding: "utf-8" }
        );
        ctx.ui.notify(`✅ Saved: ${basename(out)}`, "success");
      } catch (e: any) {
        ctx.ui.notify(`Trim failed: ${String(e.message || e).slice(0, 200)}`, "error");
      }
    },
  });

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
          `${py} -c "import librosa; y,sr=librosa.load('${file}'); t,_=librosa.beat.beat_track(y=y,sr=sr); print(f'{t:.1f}')" 2>/dev/null`,
          { encoding: "utf-8", timeout: 30000 }
        ).trim();
        if (result) { ctx.ui.notify(`🥁 BPM: ${result}`, "success"); return; }
      } catch {}
      try {
        // bpm-tools fallback
        const result = execSync(
          `sox "${file}" -t raw -r 44100 -e float -c 1 - 2>/dev/null | bpm`,
          { encoding: "utf-8", timeout: 30000 }
        ).trim();
        if (result) { ctx.ui.notify(`🥁 BPM: ${result}`, "success"); return; }
      } catch {}
      ctx.ui.notify("BPM detection failed. Install librosa: pip install librosa", "warning");
    },
  });

  // ── /render — Remotion music video ───────────────────────────────────
  pi.registerCommand("render", {
    description: "Render a music video with Remotion. /render <audio-file> [bars|wave|circle]",
    handler: async (args, ctx) => {
      const parts = (args?.trim() || "").split(/\s+/);
      const [audioArg, styleArg = "bars"] = parts;
      if (!audioArg) {
        ctx.ui.notify(
          "Usage: /render <audio-file|youtube-url> [style]\n\n" +
          "Styles:\n" +
          "  bars   — FFT spectrum bars (default)\n" +
          "  wave   — scrolling waveform\n" +
          "  circle — radial spectrum ring\n\n" +
          "Examples:\n" +
          "  /render ~/Music/track.mp3\n" +
          "  /render ~/Music/track.mp3 circle\n" +
          "  /render https://youtu.be/xxx bars",
          "info"
        );
        return;
      }
      if (!["bars", "wave", "circle"].includes(styleArg)) {
        ctx.ui.notify(`Unknown style "${styleArg}". Use: bars | wave | circle`, "warning"); return;
      }

      // Resolve: if it's a URL, download first
      let audioFile = audioArg;
      if (/^https?:\/\//.test(audioArg)) {
        if (!tools.ytdlp) { ctx.ui.notify("yt-dlp required for URL. pip install yt-dlp", "warning"); return; }
        const outDir = join(musicDir, "Videos");
        ctx.ui.notify(`⬇️ Downloading audio for render...`, "info");
        try {
          const dlOut = execSync(
            `${ytdlpBin()} -x --audio-format mp3 --audio-quality 0 -o "${outDir}/%(title)s.%(ext)s" --print after_move:filepath "${audioArg}" 2>/dev/null`,
            { encoding: "utf-8", timeout: 120000 }
          ).trim().split(/\r?\n/).pop() || "";
          if (!dlOut || !existsSync(dlOut)) { ctx.ui.notify("Download failed", "error"); return; }
          audioFile = dlOut;
        } catch (e: any) {
          ctx.ui.notify(`Download failed: ${String(e.message).slice(0, 200)}`, "error"); return;
        }
      } else {
        // Expand ~ manually (Windows-safe)
        audioFile = audioFile.replace(/^~/, HOME);
        if (!existsSync(audioFile)) { ctx.ui.notify(`File not found: ${audioFile}`, "warning"); return; }
      }

      // Resolve extension dir → repo root → remotion/render.mjs
      const extDir = (typeof import.meta !== "undefined" && (import.meta as any).url)
        ? dirname(fileURLToPath((import.meta as any).url))
        : __dirname;
      const renderScript = join(extDir, "..", "remotion", "render.mjs");
      if (!existsSync(renderScript)) {
        ctx.ui.notify(`Remotion renderer not found at:\n${renderScript}`, "error"); return;
      }

      const outFile = join(musicDir, "Videos",
        `${basename(audioFile, extname(audioFile))}_${styleArg}.mp4`);

      ctx.ui.notify(`🎬 Rendering ${styleArg} video...\nThis takes a few minutes.`, "info");

      try {
        execSync(
          `node "${renderScript}" --audio "${audioFile}" --style ${styleArg} --out "${outFile}"`,
          { encoding: "utf-8", timeout: 600000, stdio: "inherit" }
        );
        ctx.ui.notify(`✅ Video saved:\n${outFile}`, "success");
      } catch (e: any) {
        ctx.ui.notify(`Render failed: ${String(e.message || e).slice(0, 300)}`, "error");
      }
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
        `/history              recently played\n\n` +
        `LOCAL FILES → /play (cliamp TUI)\n` +
        `AI RADIO    → /radio lyria (cliamp extension)\n\n` +
        `DOWNLOADS\n` +
        `/sc <url>             SoundCloud → MP3\n` +
        `/bandcamp <url>       Bandcamp → MP3\n` +
        `/bandlab <url>        BandLab track/album/collection → MP3\n\n` +
        `PRODUCTION\n` +
        `/render <f> [style]   music video (bars|wave|circle) via Remotion\n` +
        `/mix <a> <b> [s]      crossfade with ffmpeg\n` +
        `/trim <f> <s> [e]     trim clip\n` +
        `/bpm <file>           detect BPM\n\n` +
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
}
