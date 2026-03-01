#!/usr/bin/env node
/**
 * render.mjs — Remotion music video renderer for pi-dj
 *
 * Usage:
 *   node render.mjs --audio song.mp3 --out video.mp4 [options]
 *
 * Options:
 *   --audio  <file>   Audio file (required)
 *   --out    <file>   Output MP4 (default: <title>_<style>.mp4)
 *   --title  <str>    Track title (default: filename)
 *   --artist <str>    Artist name (default: DJ PiGuy)
 *   --genre  <str>    Genre label (default: Electronic)
 *   --style  <str>    bars | wave | circle (default: bars)
 *   --cover  <file>   Cover image (optional)
 *   --fps    <n>      Frames per second (default: 30)
 *   --dur    <n>      Override duration in seconds (default: from audio)
 *   --width  <n>      Width (default: 1080)
 *   --height <n>      Height (default: 1080)
 */

import { bundle }                      from '@remotion/bundler';
import { renderMedia, selectComposition, getAudioDurationInSeconds } from '@remotion/renderer';
import { createServer }                from 'node:http';
import { resolve, dirname, basename, extname } from 'node:path';
import { readFileSync, existsSync }    from 'node:fs';
import { fileURLToPath }               from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const get  = (flag, def) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : def; };

const audioArg  = get('--audio',  null);
const coverArg  = get('--cover',  null);
const style     = get('--style',  'bars');
const fps       = parseInt(get('--fps',    '30'));
const durArg    = get('--dur',    null);
const width     = parseInt(get('--width',  '1080'));
const height    = parseInt(get('--height', '1080'));
const audioFile = audioArg ? resolve(audioArg) : null;
const coverFile = coverArg ? resolve(coverArg) : null;

if (!audioFile || !existsSync(audioFile)) {
  console.error('❌ --audio <file> is required and must exist');
  process.exit(1);
}
if (!['bars', 'wave', 'circle'].includes(style)) {
  console.error('❌ --style must be bars | wave | circle');
  process.exit(1);
}

const rawTitle  = get('--title',  basename(audioFile, extname(audioFile)));
const artist    = get('--artist', 'DJ PiGuy');
const genre     = get('--genre',  'Electronic');
const outFile   = get('--out',    resolve(`${rawTitle.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_')}_${style}.mp4`));

// ── Mini HTTP server for local files ─────────────────────────────────────
const MIME = { mp3:'audio/mpeg', m4a:'audio/mp4', wav:'audio/wav', ogg:'audio/ogg',
               jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp' };

function serveFile(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  const data = readFileSync(filePath);
  const ext  = extname(filePath).slice(1).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length,
                         'Accept-Ranges': 'bytes' });
    res.end(data);
  }).listen(0);
  const { port } = server.address();
  return { url: `http://localhost:${port}/${basename(filePath)}`, server };
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🎬 pi-dj Remotion Renderer`);
  console.log(`   Audio:  ${audioFile}`);
  console.log(`   Style:  ${style}`);
  console.log(`   Title:  ${rawTitle}`);
  console.log(`   Artist: ${artist}`);
  console.log(`   Output: ${outFile}\n`);

  // Serve local files so Remotion (headless Chrome) can fetch them
  const audioServ = serveFile(audioFile);
  const coverServ = coverFile ? serveFile(coverFile) : null;
  const audioSrc  = audioServ?.url ?? null;
  const coverSrc  = coverServ?.url ?? null;

  // Get actual audio duration
  let durationSec = durArg ? parseFloat(durArg) : null;
  if (!durationSec) {
    try {
      durationSec = await getAudioDurationInSeconds(audioFile);
      console.log(`   Duration: ${durationSec.toFixed(1)}s (from audio)`);
    } catch {
      durationSec = 30;
      console.warn(`   Duration: 30s (fallback — could not read audio)`);
    }
  }

  const durationInFrames = Math.round(durationSec * fps);
  const inputProps = { title: rawTitle, artist, genre, style, audioSrc, coverSrc };

  console.log('📦 Bundling compositions...');
  const serveUrl = await bundle({
    entryPoint: resolve(__dirname, 'src/Root.jsx'),
    webpackOverride: (c) => c,
  });

  console.log('🎯 Selecting composition...');
  const composition = await selectComposition({
    serveUrl,
    id: 'MusicVideo',
    inputProps,
  });

  console.log(`🎬 Rendering ${durationInFrames} frames (${durationSec.toFixed(1)}s @ ${fps}fps)...`);
  let lastPct = -1;
  await renderMedia({
    composition: { ...composition, durationInFrames, fps, width, height },
    serveUrl,
    codec: 'h264',
    outputLocation: outFile,
    inputProps,
    onProgress: ({ progress }) => {
      const pct = Math.round(progress * 100);
      if (pct !== lastPct) { process.stdout.write(`\r   ${pct}%`); lastPct = pct; }
    },
  });

  audioServ?.server.close();
  coverServ?.server.close();

  console.log(`\n\n✅ ${outFile}`);
}

main().catch(e => {
  console.error('\n❌', e.message || e);
  process.exit(1);
});
