#!/usr/bin/env node
// render.mjs — CLI for rendering music videos with Remotion
// Usage: node render.mjs --title "Song" --artist "Artist" --genre "Trap Soul" --audio song.mp3 --out video.mp4

import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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

async function main() {
  console.log('📦 Bundling...');
  const bundled = await bundle({
    entryPoint: resolve(__dirname, 'src/Root.jsx'),
    webpackOverride: (config) => config,
  });

  console.log('🎯 Selecting composition...');
  const composition = await selectComposition({
    serveUrl: bundled,
    id: 'MusicVideo',
    inputProps: {
      title,
      artist,
      genre,
      audioFile: audio ? resolve(audio) : null,
      coverImage: cover ? resolve(cover) : null,
    },
  });

  // Override duration based on audio length or --dur flag
  const durationInFrames = dur * fps;

  console.log(`🎬 Rendering ${durationInFrames} frames...`);
  await renderMedia({
    composition: { ...composition, durationInFrames, fps },
    serveUrl: bundled,
    codec: 'h264',
    outputLocation: out,
    inputProps: {
      title,
      artist,
      genre,
      audioFile: audio ? resolve(audio) : null,
      coverImage: cover ? resolve(cover) : null,
    },
    onProgress: ({ progress }) => {
      const pct = Math.round(progress * 100);
      process.stdout.write(`\r   Progress: ${pct}%`);
    },
  });

  console.log(`\n\n✅ Done! Saved: ${out}`);
}

main().catch((e) => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
