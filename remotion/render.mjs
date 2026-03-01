#!/usr/bin/env node
// render.mjs — CLI for rendering music videos with Remotion
// Usage: node render.mjs --title "Song" --artist "Artist" --genre "Trap Soul" --audio song.mp3 --out video.mp4

import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse args
const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};

const title  = get('--title')  || 'Untitled';
const artist = get('--artist') || 'DJ PiGuy';
const genre  = get('--genre')  || 'Hip-Hop';
const audio  = get('--audio')  || null;
const cover  = get('--cover')  || null;
const out    = get('--out')    || `${title.replace(/\s+/g, '_')}.mp4`;
const fps    = parseInt(get('--fps') || '30');
const dur    = parseInt(get('--dur') || '30'); // seconds

console.log(`\n🎬 pi-dj Remotion Renderer`);
console.log(`   Title:  ${title}`);
console.log(`   Artist: ${artist}`);
console.log(`   Genre:  ${genre}`);
console.log(`   Audio:  ${audio || 'none'}`);
console.log(`   Output: ${out}`);
console.log(`   Duration: ${dur}s @ ${fps}fps\n`);

// Serve local files via HTTP so Remotion can access them
function serveFile(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  const server = createServer((req, res) => {
    try {
      const data = readFileSync(filePath);
      const ext = filePath.split('.').pop();
      const mime = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length });
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  server.listen(0);
  const port = server.address().port;
  return { url: `http://localhost:${port}/${basename(filePath)}`, server };
}

async function main() {
  console.log('📦 Bundling...');
  const bundled = await bundle({
    entryPoint: resolve(__dirname, 'src/Root.jsx'),
    webpackOverride: (config) => config,
  });

  // Serve local audio/cover via HTTP
  const audioServ = audio ? serveFile(resolve(audio)) : null;
  const coverServ = cover ? serveFile(resolve(cover)) : null;
  const audioUrl = audioServ?.url || null;
  const coverUrl = coverServ?.url || null;

  if (audioUrl) console.log(`🌐 Serving audio: ${audioUrl}`);
  if (coverUrl) console.log(`🌐 Serving cover: ${coverUrl}`);

  const props = { title, artist, genre, audioFile: audioUrl, coverImage: coverUrl };

  console.log('🎯 Selecting composition...');
  const composition = await selectComposition({
    serveUrl: bundled,
    id: 'MusicVideo',
    inputProps: props,
  });

  const durationInFrames = dur * fps;

  console.log(`🎬 Rendering ${durationInFrames} frames...`);
  await renderMedia({
    composition: { ...composition, durationInFrames, fps },
    serveUrl: bundled,
    codec: 'h264',
    outputLocation: out,
    inputProps: props,
    onProgress: ({ progress }) => {
      const pct = Math.round(progress * 100);
      process.stdout.write(`\r   Progress: ${pct}%`);
    },
  });

  // Cleanup servers
  audioServ?.server.close();
  coverServ?.server.close();

  console.log(`\n\n✅ Done! Saved: ${out}`);
}

main().catch((e) => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
