/**
 * pi-djvj — Terminal audio-reactive visualizer
 *
 * Audio sources (in priority order):
 *   1. mpv PCM tap  — reads from mpv's --ao=pcm named pipe (actual music)
 *   2. ffmpeg mic   — fallback to mic/loopback capture
 *   3. demo mode    — sinusoidal animation when no audio device
 *
 * /viz [full]      — open visualizer (full=fullscreen alt-screen mode)
 * /djvj [path]     — launch cliamp + open visualizer
 *
 * Keys:
 *   Q / Esc   quit             Space     pause
 *   F         fullscreen toggle
 *   N / P     next/prev shader (within mode)
 *   v         cycle modes: halfblock → braille → ascii → halfblock
 *   a         toggle ascii mode
 *   b         next braille shader
 *   1-9 0     jump to half-block shader by number
 *   + -       sensitivity
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { TUI, truncateToWidth } from "@mariozechner/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

const IS_WIN = platform() === "win32";
const TMP    = tmpdir();

// ─────────────────────────────────────────────────────────────────────────────
// MPV PCM TAP — reads raw PCM from mpv's ao=pcm named pipe
// Lets /viz react to the actual music playing in mpv (pi-dj's /dj-play)
// ─────────────────────────────────────────────────────────────────────────────

// Named pipe / socket path — must match pi-dj's IPC_PATH
const MPV_IPC  = IS_WIN ? "\\\\.\\pipe\\mpv-pi-dj"   : join(TMP, "mpv-pi-dj.sock");
const PCM_PIPE = IS_WIN ? "\\\\.\\pipe\\mpv-pcm-tap"  : join(TMP, "mpv-pcm-tap.pcm");

/** Poll mpv IPC for current media-title (ICY StreamTitle or filename) */
function mpvGetTitle(): Promise<string | null> {
  return new Promise(resolve => {
    try {
      const client = net.createConnection(MPV_IPC as any);
      client.setTimeout(300);
      let buf = "";
      client.on("connect", () => {
        client.write(JSON.stringify({ command: ["get_property", "media-title"], request_id: 99 }) + "\n");
      });
      client.on("data", (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split("\n");
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.request_id === 99) {
              client.destroy();
              resolve(typeof obj.data === "string" ? obj.data : null);
              return;
            }
          } catch {}
        }
      });
      client.on("error", () => resolve(null));
      client.on("timeout", () => { client.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO CAPTURE — mpv PCM tap → ffmpeg dshow mic → demo
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_RATE  = 44100;
const CHUNK_SAMPLES = 2048;
const CHUNK_BYTES   = CHUNK_SAMPLES * 2; // s16le

interface AudioCapture {
  proc: ChildProcess | null;
  alive: boolean;
  source: "mpv" | "mic" | "demo";
}

// ── Ring buffer Tap (bjarneo player/tap.go — exact port) ───────────────────
const TAP_SIZE = 8192;
const tapBuf   = new Float32Array(TAP_SIZE);
let   tapPos   = 0;
let   tapFilled = false;

function tapPush(chunk: Float32Array, n: number) {
  for (let i = 0; i < n; i++) {
    tapBuf[tapPos] = chunk[i];
    tapPos = (tapPos + 1) % TAP_SIZE;
  }
  tapFilled = true;
}

function tapRead(n: number): Float32Array {
  if (!tapFilled) return new Float32Array(0);
  const out   = new Float32Array(n);
  const start = (tapPos - n + TAP_SIZE) % TAP_SIZE;
  for (let i = 0; i < n; i++) out[i] = tapBuf[(start + i) % TAP_SIZE];
  return out;
}

function spawnPcmCapture(source: string): ChildProcess | null {
  // ffmpeg s16le mono → tapBuf
  const args = source === "mpv-pipe" ? [
    "-hide_banner", "-loglevel", "error",
    "-f", IS_WIN ? "s16le" : "s16le",
    "-ar", String(SAMPLE_RATE), "-ac", "1",
    "-i", IS_WIN ? `\\\\.\\pipe\\mpv-pcm-tap` : PCM_PIPE,
    "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1",
  ] : [
    "-hide_banner", "-loglevel", "error",
    "-f", "dshow",
    "-i", `audio=${source}`,
    "-ac", "1", "-ar", String(SAMPLE_RATE),
    "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1",
  ];
  try {
    return spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch { return null; }
}

function startAudioCapture(): AudioCapture {
  const samples = new Float32Array(CHUNK_SAMPLES);
  const rawBuf  = Buffer.alloc(CHUNK_BYTES);
  let rawPos = 0;

  function wire(proc: ChildProcess, source: AudioCapture["source"], cap: AudioCapture) {
    proc.stdout?.on("data", (data: Buffer) => {
      for (let i = 0; i < data.length; i++) {
        rawBuf[rawPos++] = data[i];
        if (rawPos >= CHUNK_BYTES) {
          for (let j = 0; j < CHUNK_SAMPLES; j++)
            samples[j] = rawBuf.readInt16LE(j * 2) / 32768;
          tapPush(samples, CHUNK_SAMPLES);
          rawPos = 0;
        }
      }
    });
    proc.on("error", () => { cap.alive = false; });
    proc.on("exit",  () => { cap.alive = false; });
  }

  // 1. Try mpv PCM pipe (actual music)
  const mpvProc = spawnPcmCapture("mpv-pipe");
  if (mpvProc) {
    const cap: AudioCapture = { proc: mpvProc, alive: true, source: "mpv" };
    wire(mpvProc, "mpv", cap);
    // give it 400ms — if it exits quickly it means no pipe is ready
    return cap;
  }

  // 2. Try mic/loopback devices
  const MIC_DEVICES = [
    "CABLE Output (VB-Audio Virtual Cable)",
    "Stereo Mix",
    "Microphone Array (Realtek(R) Audio)",
    "Microphone",
  ];
  for (const dev of MIC_DEVICES) {
    const p = spawnPcmCapture(dev);
    if (p) {
      const cap: AudioCapture = { proc: p, alive: true, source: "mic" };
      wire(p, "mic", cap);
      return cap;
    }
  }

  // 3. Demo mode
  return { proc: null, alive: false, source: "demo" };
}

// ─────────────────────────────────────────────────────────────────────────────
// REAL FFT (Cooley-Tukey, pure JS — no deps)
// ─────────────────────────────────────────────────────────────────────────────

const FFT_SIZE = 2048;

const HANN = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++)
  HANN[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));

const BIT_REV = new Uint16Array(FFT_SIZE);
(function () {
  const bits = Math.log2(FFT_SIZE) | 0;
  for (let i = 0; i < FFT_SIZE; i++) {
    let j = 0;
    for (let b = 0; b < bits; b++) j = (j << 1) | ((i >> b) & 1);
    BIT_REV[i] = j;
  }
})();

const fftReal = new Float32Array(FFT_SIZE);
const fftImag = new Float32Array(FFT_SIZE);

function fftMagnitudes(signal: Float32Array): Float32Array {
  for (let i = 0; i < FFT_SIZE; i++) {
    fftReal[i] = i < signal.length ? signal[i] * HANN[i] : 0;
    fftImag[i] = 0;
  }
  for (let i = 0; i < FFT_SIZE; i++) {
    const j = BIT_REV[i];
    if (j > i) {
      let t = fftReal[i]; fftReal[i] = fftReal[j]; fftReal[j] = t;
      t = fftImag[i]; fftImag[i] = fftImag[j]; fftImag[j] = t;
    }
  }
  for (let len = 2; len <= FFT_SIZE; len <<= 1) {
    const half = len >> 1, step = (2 * Math.PI) / len;
    for (let i = 0; i < FFT_SIZE; i += len) {
      for (let j = 0; j < half; j++) {
        const wr = Math.cos(step * j), wi = -Math.sin(step * j);
        const tr = wr * fftReal[i+j+half] - wi * fftImag[i+j+half];
        const ti = wr * fftImag[i+j+half] + wi * fftReal[i+j+half];
        fftReal[i+j+half] = fftReal[i+j] - tr; fftImag[i+j+half] = fftImag[i+j] - ti;
        fftReal[i+j] += tr; fftImag[i+j] += ti;
      }
    }
  }
  const mags = new Float32Array(FFT_SIZE / 2);
  for (let i = 0; i < FFT_SIZE / 2; i++)
    mags[i] = Math.sqrt(fftReal[i] * fftReal[i] + fftImag[i] * fftImag[i]);
  return mags;
}

function bandEdgesHz(n: number): number[] {
  const lo = Math.log2(20), hi = Math.log2(20000);
  return Array.from({ length: n + 1 }, (_, i) => Math.pow(2, lo + (hi - lo) * i / n));
}

// ─────────────────────────────────────────────────────────────────────────────
// CAVA 2-STAGE SMOOTHING (gravity falloff + IIR integral)
// ─────────────────────────────────────────────────────────────────────────────

const prevBands  = new Float32Array(64);
const peakBands  = new Float32Array(64);
const fallVel    = new Float32Array(64);
const smoothMem  = new Float32Array(64);

const GRAVITY_BASE    = 1.54;
const FALL_INC        = 0.028;
const NOISE_REDUCTION = 0.77;
const TARGET_FPS      = 30;

function computeBands(samples: Float32Array, numBands: number): Float32Array {
  if (!samples.length) {
    const out = new Float32Array(numBands);
    for (let b = 0; b < numBands; b++) { peakBands[b] *= 0.85; out[b] = prevBands[b] = peakBands[b]; }
    return out;
  }
  const mags  = fftMagnitudes(samples);
  const binHz = SAMPLE_RATE / FFT_SIZE;
  const edges = bandEdgesHz(numBands);
  const bands = new Float32Array(numBands);
  for (let b = 0; b < numBands; b++) {
    const lo = Math.max(1, Math.floor(edges[b] / binHz));
    const hi = Math.min(mags.length - 1, Math.floor(edges[b+1] / binHz));
    let sum = 0, count = 0;
    for (let i = lo; i <= hi; i++) { sum += mags[i]; count++; }
    if (count) sum /= count;
    let v = sum > 0 ? (20 * Math.log10(sum) + 10) / 50 : 0;
    v = Math.max(0, Math.min(1, v));
    // Stage 1: CAVA gravity — instant attack, quadratic decay
    if (v >= prevBands[b]) { peakBands[b] = v; fallVel[b] = 0; }
    else {
      const grav = Math.pow(60 / TARGET_FPS, 2.5) * GRAVITY_BASE / NOISE_REDUCTION;
      v = peakBands[b] * (1 - fallVel[b] * fallVel[b] * grav);
      if (v < 0) v = 0;
      fallVel[b] += FALL_INC;
    }
    prevBands[b] = v;
    // Stage 2: CAVA IIR integral low-pass
    v = smoothMem[b] * NOISE_REDUCTION + v;
    smoothMem[b] = v;
    bands[b] = Math.min(1, v);
  }
  return bands;
}

// ─────────────────────────────────────────────────────────────────────────────
// BEAT DETECTION — spectral flux
// ─────────────────────────────────────────────────────────────────────────────

const FLUX_HISTORY = 43;
const fluxHistory  = new Float32Array(FLUX_HISTORY);
let   fluxPos      = 0;
let   prevMags: Float32Array | null = null;

function detectBeat(samples: Float32Array): number {
  if (!samples.length) return 0;
  const mags = fftMagnitudes(samples);
  let flux = 0;
  if (prevMags) {
    for (let i = 0; i < mags.length; i++) { const d = mags[i] - prevMags[i]; if (d > 0) flux += d; }
    flux /= mags.length;
  }
  prevMags = mags.slice();
  fluxHistory[fluxPos] = flux; fluxPos = (fluxPos + 1) % FLUX_HISTORY;
  let mean = 0; for (let i = 0; i < FLUX_HISTORY; i++) mean += fluxHistory[i]; mean /= FLUX_HISTORY;
  let variance = 0; for (let i = 0; i < FLUX_HISTORY; i++) variance += (fluxHistory[i] - mean) ** 2;
  const threshold = mean + 1.5 * Math.sqrt(variance / FLUX_HISTORY);
  return flux > threshold ? Math.min(1, (flux - threshold) / (threshold + 0.001)) : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// PIXEL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function clamp(v: number): number { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
function setPixel(fb: Uint8Array, w: number, x: number, y: number, r: number, g: number, b: number) {
  if (x < 0 || x >= w || y < 0) return;
  const i = (y * w + x) * 3; if (i + 2 >= fb.length) return;
  fb[i] = clamp(r); fb[i+1] = clamp(g); fb[i+2] = clamp(b);
}
function hsl(h: number, s: number, l: number): [number,number,number] {
  const c = (1 - Math.abs(2*l-1)) * s, x = c * (1 - Math.abs((h*6) % 2 - 1)), m = l - c/2;
  let r=0,g=0,b=0;
  if      (h<1/6){r=c;g=x;}else if(h<2/6){r=x;g=c;}else if(h<3/6){g=c;b=x;}
  else if (h<4/6){g=x;b=c;}else if(h<5/6){r=x;b=c;}else{r=c;b=x;}
  return [(r+m)*255,(g+m)*255,(b+m)*255];
}

// ─────────────────────────────────────────────────────────────────────────────
// HALF-BLOCK SHADERS (52 total)
// ─────────────────────────────────────────────────────────────────────────────

type ShaderFn = (fb: Uint8Array, w: number, h: number, t: number,
  bands: Float32Array, bass: number, mid: number, treble: number, beat: number,
  samples?: Float32Array) => void;

const shaderSpectrum: ShaderFn = (fb,w,h,_t,bands,_b,_m,_tr,beat) => {
  fb.fill(0); const n=bands.length, bw=Math.max(1,Math.floor(w/n));
  for(let i=0;i<n;i++){const level=Math.min(1,bands[i]*5),barH=Math.floor(level*h),x0=i*bw;
    for(let y=h-barH;y<h;y++){const t=(h-y)/h;const r=t>0.6?255:t>0.3?255:t/0.3*255;const g=t>0.6?(1-(t-0.6)/0.4)*255:255;
      for(let x=x0;x<x0+bw-1&&x<w;x++)setPixel(fb,w,x,y,r,g,beat*80*(1-t));}}};

const shaderRadial: ShaderFn = (fb,w,h,t,bands,_b,_m,_tr,beat) => {
  for(let i=0;i<fb.length;i++)fb[i]=(fb[i]*0.82)|0;
  const cx=w/2,cy=h/2,n=bands.length;
  for(let i=0;i<n;i++){const angle=(i/n)*Math.PI*2+t*0.5,level=Math.min(1,bands[i]*4),radius=4+level*Math.min(cx,cy)*0.7;
    const x=Math.floor(cx+Math.cos(angle)*radius),y=Math.floor(cy+Math.sin(angle)*radius*0.5);
    if(y<0||y>=h)continue;const[r,g,b]=hsl((i/n+t*0.1)%1,1,0.5),bright=0.6+beat*0.4;
    for(let dy=-1;dy<=1;dy++)for(let dx=-2;dx<=2;dx++)setPixel(fb,w,x+dx,y+dy,r*bright,g*bright,b*bright);}};

const shaderScope: ShaderFn = (fb,w,h,t,bands,bass) => {
  fb.fill(0);const cy=h/2;
  for(let x=0;x<w;x++){const bi=Math.floor((x/w)*bands.length),level=bands[bi]||0;
    const y=Math.max(0,Math.min(h-1,Math.floor(cy+level*cy*3*Math.sin(x*0.1+t*3))));
    for(let py=Math.min(cy|0,y);py<=Math.max(cy|0,y);py++){const tl=Math.abs(py-cy)/cy;setPixel(fb,w,x,py,50+205*tl,255*(1-tl),100+155*bass);}}
  for(let x=0;x<w;x++)setPixel(fb,w,x,cy|0,30,30,50);};

const shaderFire: ShaderFn = (fb,w,h,_t,bands,bass,_m,treble,beat) => {
  for(let y=0;y<h-1;y++)for(let x=0;x<w;x++){const s=((y+1)*w+x)*3,d=(y*w+x)*3;fb[d]=(fb[s]*0.9)|0;fb[d+1]=(fb[s+1]*0.82)|0;fb[d+2]=(fb[s+2]*0.7)|0;}
  for(let x=0;x<w;x++){const bi=Math.floor((x/w)*bands.length),level=Math.min(1,(bands[bi]||0)*5),intensity=level*(0.7+beat*0.3);
    setPixel(fb,w,x,h-1,255*intensity,120*intensity*(1-bass*0.5),30*intensity*treble);}};

const shaderMatrix: ShaderFn = (fb,w,h,t,bands,_b,_m,_tr,beat) => {
  for(let i=0;i<fb.length;i++)fb[i]=(fb[i]*0.88)|0;const n=bands.length;
  for(let i=0;i<n;i++){const level=Math.min(1,(bands[i]||0)*4);if(level>0.1){const x=Math.floor((i/n)*w),dropY=Math.floor((t*15*(0.5+level)+i*7.3)%h);
    for(let dy=0;dy<4;dy++){const y=(dropY+dy)%h,bright=(4-dy)/4;setPixel(fb,w,x,y,0,255*level*bright,50*bright);}}}
  if(beat>0.4)for(let x=0;x<w;x++)setPixel(fb,w,x,0,0,120*beat,0);};

const shaderEQ: ShaderFn = (fb,w,h,_t,bands,_b,_m,_tr,beat) => {
  fb.fill(0);const nBars=10,gap=2,bw=Math.max(2,Math.floor((w-gap*(nBars+1))/nBars)),mirrorY=Math.floor(h*0.7);
  for(let i=0;i<nBars;i++){const bi=Math.floor((i/nBars)*bands.length),level=Math.min(1,(bands[bi]||0)*6),barH=Math.floor(level*mirrorY*0.9),x0=gap+i*(bw+gap);
    const[r,g,b]=hsl(i/nBars,1,0.55);
    for(let y=mirrorY-barH;y<mirrorY;y++){const tl=(mirrorY-y)/mirrorY,glow=1+beat*0.4;for(let x=x0;x<x0+bw&&x<w;x++)setPixel(fb,w,x,y,r*glow*(0.5+tl*0.5),g*glow*(0.5+tl*0.5),b*glow*(0.5+tl*0.5));}
    if(barH>2){const py=Math.max(0,mirrorY-barH-2);for(let x=x0;x<x0+bw&&x<w;x++)setPixel(fb,w,x,py,255,255,200);}
    const reflH=Math.floor(barH*0.4);for(let dy=0;dy<reflH&&mirrorY+dy<h;dy++){const fade=0.3*(1-dy/reflH);for(let x=x0;x<x0+bw&&x<w;x++)setPixel(fb,w,x,mirrorY+dy,r*fade,g*fade,b*fade);}}
  for(let x=0;x<w;x++)setPixel(fb,w,x,mirrorY,40,40,50);};

const shaderRings: ShaderFn = (fb,w,h,t,bands,_b,_m,_tr,beat) => {
  for(let i=0;i<fb.length;i++)fb[i]=(fb[i]*0.78)|0;const cx=w/2,cy=h/2,maxR=Math.min(cx,cy)*0.9;
  for(let ring=0;ring<8;ring++){const bi=Math.floor((ring/8)*bands.length),level=Math.min(1,(bands[bi]||0)*5);
    const r2=(ring+1)/9*maxR+level*6*Math.sin(t*2+ring);const[cr,cg,cb]=hsl((ring/8+t*0.05)%1,1,0.5);const bright=0.4+level*0.6+beat*0.3;
    const steps=Math.max(60,Math.floor(r2*4));for(let s=0;s<steps;s++){const angle=(s/steps)*Math.PI*2;setPixel(fb,w,Math.floor(cx+Math.cos(angle)*r2),Math.floor(cy+Math.sin(angle)*r2*0.45),cr*bright,cg*bright,cb*bright);}}
  if(beat>0.3){const pulseR=beat*4|0;for(let dy=-pulseR;dy<=pulseR;dy++)for(let dx=-pulseR*2;dx<=pulseR*2;dx++)setPixel(fb,w,cx+dx|0,cy+dy|0,255*beat,255*beat,255);}};

const shaderPlasma: ShaderFn = (fb,w,h,t,bands,bass,mid,treble,beat) => {
  const energy=(bass+mid+treble)/3;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const nx=x/w*4,ny=y/h*4;
    let v=Math.sin(nx*2+t*1.5+bass*4)+Math.sin(ny*3+t*0.8+mid*3)+Math.sin((nx+ny+t)*1.2+treble*5)+Math.sin(Math.sqrt(nx*nx+ny*ny)*2-t*2+beat*6);v/=4;
    const bm=1+(bands[Math.floor((x/w)*bands.length)]||0)*3;
    setPixel(fb,w,x,y,(Math.sin(v*Math.PI*bm)*0.5+0.5)*255*(0.5+energy),(Math.sin(v*Math.PI*bm+2.094)*0.5+0.5)*255*(0.5+energy),(Math.sin(v*Math.PI*bm+4.188)*0.5+0.5)*255*(0.5+energy));}};

const WAVE_HIST: Float32Array[] = [];
const shaderWaveform: ShaderFn = (fb,w,h,_t,bands,bass,_m,_tr,beat,samples) => {
  fb.fill(0);if(samples){const chunk=new Float32Array(w);for(let x=0;x<w;x++)chunk[x]=samples[Math.floor((x/w)*samples.length)]||0;WAVE_HIST.push(chunk);if(WAVE_HIST.length>256)WAVE_HIST.shift();}
  const cy=h/2|0;for(let hi=0;hi<WAVE_HIST.length;hi++){const age=1-hi/WAVE_HIST.length,alpha=(1-age)*0.6,chunk=WAVE_HIST[hi];
    for(let x=0;x<w&&x<chunk.length;x++){const val=chunk[x]*(0.5+bass*2),y=Math.max(0,Math.min(h-1,cy+Math.floor(val*cy*0.8)));
      const freq=x/w;let r=0,g=0,b=0;if(freq<0.33){r=255*alpha;g=100*freq*3*alpha;b=20*alpha;}else if(freq<0.66){const tf=(freq-0.33)*3;r=80*(1-tf)*alpha;g=255*alpha;b=50*tf*alpha;}else{const tf=(freq-0.66)*3;r=20*alpha;g=200*(1-tf)*alpha;b=255*alpha;}
      for(let py=Math.min(cy,y);py<=Math.max(cy,y);py++){const dist=Math.abs(py-cy)/cy;setPixel(fb,w,x,py,r*(0.3+dist*0.7),g*(0.3+dist*0.7),b*(0.3+dist*0.7));}}}
  const lc=beat>0.3?255:60;for(let x=0;x<w;x++)setPixel(fb,w,x,cy,lc,beat>0.3?200:60,80);
  if(beat>0.4)for(let y=0;y<h;y++){setPixel(fb,w,0,y,255*beat,50,50);setPixel(fb,w,w-1,y,255*beat,50,50);}};

const shaderDJDeck: ShaderFn = (fb,w,h,_t,bands,bass,_m,_tr,beat,samples) => {
  fb.fill(0);const cy=h/2|0;
  if(samples){for(let x=0;x<w;x++){const val=(samples[Math.floor((x/w)*samples.length)]||0)*1.5,topCy=Math.floor(h*0.25),amp=Math.floor(val*h*0.2);
    const y=Math.max(0,Math.min(cy-2,topCy+amp));const intensity=0.5+Math.abs(val)*0.5;for(let py=Math.min(topCy,y);py<=Math.max(topCy,y);py++)setPixel(fb,w,x,py,80*intensity,120*intensity,255*intensity);}}
  for(let x=0;x<w;x++){setPixel(fb,w,x,cy,50+beat*100,50+beat*100,60);if(x%4<2)setPixel(fb,w,x,cy,120,120,140);}
  const nBars=Math.min(bands.length,24),bw=Math.max(1,Math.floor(w/nBars)),botTop=cy+2,botH=h-botTop;
  for(let i=0;i<nBars;i++){const level=Math.min(1,(bands[i]||0)*5),barH=Math.floor(level*botH*0.85),x0=i*bw;
    for(let dy=0;dy<barH;dy++){const y=h-1-dy,tl=dy/botH;let r=0,g=0,b=0;if(tl<0.5){g=200+55*(tl*2);r=40;}else if(tl<0.8){const p=(tl-0.5)/0.3;r=255*p;g=255;}else{r=255;g=255*(1-(tl-0.8)/0.2);}for(let x=x0;x<x0+bw-1&&x<w;x++)setPixel(fb,w,x,y,r*(0.7+beat*0.3),g*(0.7+beat*0.3),b);}
    if(barH>3){const py=h-1-barH-1;if(py>botTop)for(let x=x0;x<x0+bw-1&&x<w;x++)setPixel(fb,w,x,py,255,255,255);}}};

const shaderTunnel: ShaderFn = (fb,w,h,t,bands,bass,_m,_tr,beat) => {
  const cx=w/2,cy=h/2;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const dx=(x-cx)/cx,dy=(y-cy)/cy*2,dist=Math.sqrt(dx*dx+dy*dy),angle=Math.atan2(dy,dx);
    const tunnel=(dist+t*0.3)%1,bi=Math.floor(tunnel*bands.length),level=(bands[Math.min(bi,bands.length-1)]||0)*3;
    const[r,g,b]=hsl((angle/(Math.PI*2)+0.5+t*0.1)%1,0.8+bass*0.2,0.2+tunnel*0.5*level);setPixel(fb,w,x,y,r*(dist<0.1?beat*2:1),g*(dist<0.1?beat*2:1),b*(dist<0.1?beat*2:1));}};

const STARS=Array.from({length:200},()=>({x:Math.random()*2-1,y:Math.random()*2-1,z:Math.random()}));
const shaderStarfield: ShaderFn = (fb,w,h,_t,_bands,bass,_m,_tr,beat) => {
  for(let i=0;i<fb.length;i++)fb[i]=(fb[i]*0.85)|0;const cx=w/2,cy=h/2,speed=0.008+bass*0.04+beat*0.02;
  for(const star of STARS){star.z-=speed;if(star.z<=0){star.x=Math.random()*2-1;star.y=Math.random()*2-1;star.z=1;}
    const sx=Math.floor(cx+star.x/star.z*cx),sy=Math.floor(cy+star.y/star.z*cy*0.5),size=Math.max(0,(1-star.z)*3|0),bright=Math.floor((1-star.z)*255*(0.7+beat*0.3));
    for(let dy=-size;dy<=size;dy++)for(let dx=-size*2;dx<=size*2;dx++)setPixel(fb,w,sx+dx,sy+dy,bright,bright,Math.floor(bright*0.8+50));}};

const shaderLissajous: ShaderFn = (fb,w,h,t,bands,bass,_m,treble,beat) => {
  for(let i=0;i<fb.length;i++)fb[i]=(fb[i]*0.88)|0;const cx=w/2,cy=h/2,ax=3+Math.floor(bass*4),ay=2+Math.floor(treble*3);
  for(let i=0;i<2000;i++){const theta=(i/2000)*Math.PI*2,px=Math.floor(cx+Math.sin(ax*theta+t)*cx*0.85),py=Math.floor(cy+Math.sin(ay*theta)*cy*0.45);
    const[r,g,b]=hsl((i/2000+t*0.05)%1,1,0.5+beat*0.3);setPixel(fb,w,px,py,r,g,b);}};

const shaderKaleidoscope: ShaderFn = (fb,w,h,t,bands,bass,mid,treble,beat) => {
  const cx=w/2,cy=h/2;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){let angle=Math.atan2((y-cy)/h,(x-cx)/w);const dist=Math.sqrt(((x-cx)/w)**2+((y-cy)/h)**2);
    angle=Math.abs(((angle%(Math.PI/4))+Math.PI/4)%(Math.PI/4)-Math.PI/8);const bi=Math.floor(dist*bands.length),level=(bands[Math.min(bi,bands.length-1)]||0)*4;
    let v=Math.sin(dist*8-t*2+bass*4)*Math.sin(angle*8+t+mid*3)+level;v=v*0.5+0.5;
    const[r,g,b]=hsl((v+t*0.1+treble*0.2)%1,0.9,0.3+v*0.4*(0.7+beat*0.3));setPixel(fb,w,x,y,r,g,b);}};

const shaderVortex: ShaderFn = (fb,w,h,t,bands,bass,_m,_tr,beat) => {
  for(let i=0;i<fb.length;i++)fb[i]=(fb[i]*0.80)|0;const cx=w/2,cy=h/2,arms=5;
  for(let arm=0;arm<arms;arm++){const armAngle=(arm/arms)*Math.PI*2;for(let i=0;i<150;i++){const frac=i/150,bi=Math.floor(frac*bands.length),level=(bands[Math.min(bi,bands.length-1)]||0)*3;
    const r2=frac*Math.min(cx,cy)*0.9*(0.5+level*0.5),angle=armAngle+frac*Math.PI*4+t*(1+bass);
    const px=Math.floor(cx+Math.cos(angle)*r2),py=Math.floor(cy+Math.sin(angle)*r2*0.45);
    const[cr,cg,cb]=hsl((arm/arms+frac*0.3+t*0.05)%1,1,(0.5+frac*0.5+beat*0.3)*0.5);
    for(let d=-1;d<=1;d++)setPixel(fb,w,px+d,py,cr,cg,cb);}}};

interface Particle{x:number;y:number;vx:number;vy:number;life:number;r:number;g:number;b:number;}
const PARTICLES: Particle[]=[];
const shaderParticles: ShaderFn = (fb,w,h,_t,bands,bass,_m,_tr,beat) => {
  for(let i=0;i<fb.length;i++)fb[i]=(fb[i]*0.84)|0;
  if(beat>0.3){const count=Math.floor(beat*20);for(let i=0;i<count&&PARTICLES.length<300;i++){const angle=Math.random()*Math.PI*2,speed=2+beat*8+Math.random()*4,bi=Math.floor(Math.random()*bands.length);const[r,g,b]=hsl(bi/bands.length,1,0.6);PARTICLES.push({x:w/2+Math.random()*20-10,y:h/2+Math.random()*10-5,vx:Math.cos(angle)*speed*2,vy:Math.sin(angle)*speed*0.5,life:0.8+Math.random()*0.2,r,g,b});}}
  if(bass>0.1&&PARTICLES.length<300){for(let i=0;i<Math.floor(bass*5);i++){const bi=Math.floor(Math.random()*bands.length),level=(bands[bi]||0);const[r,g,b]=hsl(bi/bands.length,1,0.5+level*0.3);PARTICLES.push({x:Math.random()*w,y:h-1,vx:(Math.random()-0.5)*4,vy:-(2+level*8+Math.random()*3),life:0.6+Math.random()*0.4,r,g,b});}}
  for(let i=PARTICLES.length-1;i>=0;i--){const p=PARTICLES[i];p.vy+=0.15;p.x+=p.vx;p.y+=p.vy;p.life-=0.02;if(p.y>=h-1){p.y=h-1;p.vy*=-0.5;p.vx*=0.9;}if(p.x<0){p.x=0;p.vx*=-0.8;}if(p.x>=w){p.x=w-1;p.vx*=-0.8;}if(p.life<=0){PARTICLES.splice(i,1);continue;}const alpha=p.life;setPixel(fb,w,p.x|0,p.y|0,p.r*alpha,p.g*alpha,p.b*alpha);setPixel(fb,w,(p.x-p.vx*0.5)|0,(p.y-p.vy*0.5)|0,p.r*alpha*0.4,p.g*alpha*0.4,p.b*alpha*0.4);}};

// ── fragcoord.xyz-inspired shaders (CPU raymarching / SDF / volumetric) ────

// Shared math for advanced shaders
function fhash(n: number): number { return ((Math.sin(n) * 43758.5453) % 1 + 1) % 1; }
function fhash2(x: number, y: number): number { return fhash(x * 127.1 + y * 311.7); }
function fnoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = fhash2(ix, iy), b = fhash2(ix + 1, iy), c = fhash2(ix, iy + 1), d = fhash2(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function ffbm(x: number, y: number, oct: number): number {
  let v = 0, a = 0.5, px = x, py = y;
  for (let i = 0; i < oct; i++) { v += a * fnoise(px, py); px *= 2; py *= 2; a *= 0.5; }
  return v;
}
// Fast 2-octave fbm for hot paths (raymarching inner loops)
function ffbm2(x: number, y: number): number {
  return 0.5 * fnoise(x, y) + 0.25 * fnoise(x * 2, y * 2);
}
function acesTonemap(r: number, g: number, b: number): [number, number, number] {
  // ACES filmic tone mapping (simple fit)
  const tm = (x: number) => { const a = x * (2.51 * x + 0.03); const d = x * (2.43 * x + 0.59) + 0.14; return Math.max(0, Math.min(1, a / d)); };
  return [tm(r) * 255, tm(g) * 255, tm(b) * 255];
}

// 17: Black Hole — gravitational lensing + accretion disk
const shaderBlackHole: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const cx = w / 2, cy = h / 2, aspect = w / (h * 2); // terminal chars are ~2:1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let ux = (x - cx) / cx, uy = (y - cy) / cy / aspect;
    const dist = Math.sqrt(ux * ux + uy * uy);
    const angle = Math.atan2(uy, ux);

    // Gravitational lensing — bend UV toward center
    const rs = 0.15 + bass * 0.05; // Schwarzschild radius
    const bendFactor = dist > rs ? rs * rs / (dist * dist) : 1;
    const lensedDist = dist + bendFactor * 0.3;
    const lensedAngle = angle + bendFactor * 2.0 / (dist + 0.01) * 0.15;

    let r = 0, g = 0, b2 = 0;

    // Accretion disk — thin ring with doppler shift
    const diskR = 0.25 + bass * 0.08;
    const diskWidth = 0.12 + mid * 0.06;
    const diskDist = Math.abs(lensedDist - diskR);
    if (diskDist < diskWidth && Math.abs(uy) < 0.15 + treble * 0.05) {
      const diskIntensity = (1 - diskDist / diskWidth) * (1 - Math.abs(uy) / 0.2);
      const doppler = 0.5 + 0.5 * Math.cos(lensedAngle - t * 2); // blueshift/redshift
      const diskSpec = (bands[Math.floor((lensedAngle / Math.PI + 1) * 0.5 * bands.length) % bands.length] || 0) * 2;
      r += diskIntensity * (1.8 + doppler * 1.5 + diskSpec) * (0.8 + beat * 0.5);
      g += diskIntensity * (0.4 + doppler * 0.3 + diskSpec * 0.3);
      b2 += diskIntensity * (0.2 + (1 - doppler) * 0.8);
    }

    // Photon ring — bright ring at ~1.5× Schwarzschild
    const photonR = rs * 2.5;
    const photonGlow = Math.exp(-Math.pow((lensedDist - photonR) * 12, 2)) * (0.8 + beat * 0.6);
    r += photonGlow * 1.2; g += photonGlow * 0.6; b2 += photonGlow * 0.3;

    // Event horizon — pure black
    if (dist < rs) { r = 0; g = 0; b2 = 0; }

    // Starfield background (warped)
    if (dist > rs * 1.2) {
      const starX = Math.floor(lensedAngle * 20 + t * 0.1);
      const starY = Math.floor(lensedDist * 30);
      if (fhash2(starX, starY) > 0.985) {
        const starBright = 0.3 + treble * 0.4;
        r += starBright; g += starBright; b2 += starBright * 1.2;
      }
    }

    // Jet — vertical plasma jets
    if (Math.abs(ux) < 0.03 + bass * 0.02 && Math.abs(uy) > rs) {
      const jetIntensity = Math.exp(-Math.abs(ux) * 30) * Math.exp(-Math.abs(uy) * 2) * (0.5 + mid);
      r += jetIntensity * 0.3; g += jetIntensity * 0.5; b2 += jetIntensity * 1.5;
    }

    const [tr, tg, tb] = acesTonemap(r, g, b2);
    setPixel(fb, w, x, y, tr, tg, tb);
  }
};

// 18: Nebula — volumetric gas clouds with domain warping
const shaderNebula: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ux = x / w * 4 - 2, uy = y / h * 4 - 2;
    const t2 = t * 0.2;

    // Domain warping — the fragcoord.xyz secret sauce (3+3+2 octaves, profiled for 30fps)
    const warp1 = ffbm(ux + t2 + bass * 2, uy + t2 * 0.7, 3);
    const warp2 = ffbm(ux + warp1 * 2 + treble * 1.5, uy + warp1 * 1.5 + mid, 3);
    const warp3 = ffbm2(ux + warp2 * 1.5 + t2, uy + warp2 + t2 * 0.3);

    // Band-reactive detail
    const bi = Math.floor(((ux + 2) / 4) * bands.length);
    const bandVal = (bands[Math.max(0, Math.min(bi, bands.length - 1))] || 0) * 2;

    // Color layers — deep space nebula palette
    let r = 0, g = 0, b2 = 0;
    r += warp1 * 0.8 * (0.6 + bass * 0.8);
    g += warp2 * 0.4 * (0.3 + mid * 0.6);
    b2 += warp3 * 1.2 * (0.5 + treble * 0.8);

    // Hot gas emission
    const emission = Math.pow(Math.max(0, warp2 * 2 - 0.5), 2) * (1 + bandVal);
    r += emission * 1.5; g += emission * 0.3;

    // Cool gas absorption
    const absorption = Math.pow(Math.max(0, warp3), 3);
    b2 += absorption * 0.8; g += absorption * 0.2;

    // Star seeds in low-density regions
    if (warp1 < 0.3 && fhash2(Math.floor(x * 0.5), Math.floor(y * 0.5)) > 0.992) {
      const bright = 0.5 + treble * 0.5;
      r += bright; g += bright; b2 += bright;
    }

    // Beat pulse
    r *= 1 + beat * 0.3; g *= 1 + beat * 0.2; b2 *= 1 + beat * 0.15;

    const [tr, tg, tb] = acesTonemap(r * 0.7, g * 0.7, b2 * 0.7);
    setPixel(fb, w, x, y, tr, tg, tb);
  }
};

// 19: Cymatics — wave interference patterns (Chladni plates)
const shaderCymatics: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ux = (x - cx) / cx, uy = (y - cy) / cy;

    // 4 wave sources driven by audio bands (profiled: 5→4, negligible visual diff)
    let wave = 0;
    for (let i = 0; i < 4; i++) {
      const fi = i;
      const srcAngle = fi * 1.2566 + t * 0.3;
      const srcR = 0.3 + bass * 0.2;
      const srcX = Math.cos(srcAngle) * srcR, srcY = Math.sin(srcAngle) * srcR;
      const dx = ux - srcX, dy = uy - srcY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const freq = 8 + fi * 4 + treble * 20;
      wave += Math.sin(dist * freq - t * (2 + mid * 4)) / (1 + dist * 6);
    }

    // Spectrum modulation
    const bi = Math.floor(((Math.atan2(uy, ux) / Math.PI + 1) * 0.5) * bands.length);
    const bandVal = (bands[Math.max(0, Math.min(bi, bands.length - 1))] || 0) * 3;
    wave += bandVal * 0.3;

    const v = wave * 0.5 + 0.5;

    // Interference color mapping — cyan/magenta/white nodes
    let r = 0, g = 0, b2 = 0;
    if (v > 0.6) { // constructive — hot
      const t2 = (v - 0.6) / 0.4;
      r = 1.0 * t2 * (1 + beat); g = 0.2 * t2; b2 = 0.6 * t2;
    } else if (v > 0.3) { // mid
      const t2 = (v - 0.3) / 0.3;
      r = 0.1 * t2; g = 0.4 * t2; b2 = 0.8 * t2;
    } else { // destructive — dark cyan
      r = 0; g = 0.8 * v; b2 = 1.0 * v * 0.3;
    }

    r *= 0.8 + bass * 0.6; g *= 0.8 + mid * 0.4; b2 *= 0.8 + treble * 0.4;

    // Vignette
    const vdist = Math.sqrt(ux * ux + uy * uy);
    const vignette = 1 - vdist * 0.4;
    setPixel(fb, w, x, y, r * vignette * 255, g * vignette * 255, b2 * vignette * 255);
  }
};

// 20: Aurora — flowing ribbons of light with fbm displacement
const shaderAurora: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ux = x / w, uy = y / h;
    let r = 0.02, g = 0.01, b2 = 0.05; // dark sky base

    // 4 aurora layers with fbm displacement
    for (let i = 0; i < 4; i++) {
      const fi = i;
      const yDisp = fnoise(ux * (2 + fi) + t * 0.3, fi * 10 + t * 0.15) * (0.3 + bass * 0.2);
      const bandY = uy + yDisp;
      const bandDist = Math.abs(bandY - 0.5 - fi * 0.05);
      const band = Math.max(0, 1 - bandDist * 10);

      const spec = (bands[Math.floor(ux * bands.length) % bands.length] || 0) * 2;

      const cr = i === 0 ? 0 : i === 1 ? 0 : i === 2 ? 0.5 : 1.0;
      const cg = i === 0 ? 1.0 : i === 1 ? 0.5 : i === 2 ? 0 : 0;
      const cb = i === 0 ? 0.5 : i === 1 ? 1.0 : i === 2 ? 1.0 : 0.5;

      const intensity = band * (0.5 + spec * 0.8 + mid * 0.3);
      r += cr * intensity; g += cg * intensity; b2 += cb * intensity;
    }

    // Stars
    if (fhash2(Math.floor(x * 0.5), Math.floor(y * 0.5)) > 0.997) {
      const sb = 0.5 + treble * 0.5;
      r += sb; g += sb; b2 += sb;
    }

    // Beat pulse
    r += 0.1 * beat; g += 0.05 * beat; b2 += 0.15 * beat;

    const [tr, tg, tb] = acesTonemap(r, g, b2);
    setPixel(fb, w, x, y, tr, tg, tb);
  }
};

// 21: Voronoi — reactive tessellation (fragcoord-style, not my simpler rings)
const shaderVoronoi: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ux = x / w * (4 + bass * 2), uy = y / h * (4 + bass * 2);
    const cellX = Math.floor(ux), cellY = Math.floor(uy);

    let minDist = 10, minDist2 = 10, closestHash = 0;

    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cellX + dx, ny = cellY + dy;
      const px = nx + fhash2(nx * 1.1, ny * 2.3) * (0.5 + 0.5 * Math.sin(t + fhash2(nx, ny) * 6.28));
      const py = ny + fhash2(nx * 3.7, ny * 1.9) * (0.5 + 0.5 * Math.cos(t * 0.7 + fhash2(ny, nx) * 6.28));
      const ddx = ux - px, ddy = uy - py;
      const d2 = ddx * ddx + ddy * ddy; // skip sqrt — compare squared distances
      if (d2 < minDist) { minDist2 = minDist; minDist = d2; closestHash = fhash2(nx, ny); }
      else if (d2 < minDist2) { minDist2 = d2; }
    }

    const edge = Math.sqrt(minDist2) - Math.sqrt(minDist); // sqrt only once for edge
    const bi = Math.floor(Math.sqrt(minDist) * bands.length) % bands.length;
    const spec = (bands[bi] || 0) * 3;

    // Cell color
    const cr = 0.5 * closestHash + 0.5 * (1 - closestHash);
    const cg = 0.3 * (1 - closestHash);
    const cb = 0.6 * closestHash;

    let r = cr * spec * (0.5 + mid);
    let g = cg * spec * (0.5 + mid);
    let b2 = cb * spec * (0.5 + mid);

    // Edge glow
    const edgeGlow = Math.max(0, 1 - edge * 20) * (0.5 + beat);
    r += 0.8 * edgeGlow; g += 0.9 * edgeGlow; b2 += 1.0 * edgeGlow;

    r += 0.2 * beat; g += 0.1 * beat; b2 += 0.3 * beat;
    setPixel(fb, w, x, y, Math.min(255, r * 255), Math.min(255, g * 255), Math.min(255, b2 * 255));
  }
};

// 22: Fractal Flame — mandelbrot with audio-reactive zoom/color
const shaderFractal: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ux = (x - w / 2) / (w / 2), uy = (y - h / 2) / (h / 2);
    const zoom = 2.5 - bass * 0.5;
    const cr = ux * zoom + (-0.745 + Math.sin(t * 0.05) * 0.005);
    const ci = uy * zoom + (0.186 + Math.cos(t * 0.07) * 0.005);

    let zr = 0, zi = 0, iter = 0;
    const maxIter = 60;
    for (let i = 0; i < maxIter; i++) {
      const zr2 = zr * zr - zi * zi + cr;
      const zi2 = 2 * zr * zi + ci;
      zr = zr2; zi = zi2;
      if (zr * zr + zi * zi > 4) { iter = i; break; }
      iter = i;
    }

    const frac = iter / maxIter;
    // Smooth coloring with audio modulation
    const hue = frac * 6.28 + t * 0.3 + bass * 3;
    const rr = 0.5 + 0.5 * Math.cos(hue);
    const gg = 0.5 + 0.5 * Math.cos(hue + 2.094 + mid * 3);
    const bb = 0.5 + 0.5 * Math.cos(hue + 4.189 + treble * 3);
    const brightness = (1 - frac) * (1 + beat * 0.5);

    setPixel(fb, w, x, y, rr * brightness * 255, gg * brightness * 255, bb * brightness * 255);
  }
};

// 23: Raymarched Sphere — 3D SDF sphere with reactive surface
const shaderSphere: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const aspect = w / (h * 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // Ray direction
    const ux = (2 * x / w - 1) * aspect, uy = -(2 * y / h - 1);
    const rdx = ux, rdy = uy, rdz = -1.5;
    const rdLen = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz);
    const dx = rdx / rdLen, dy = rdy / rdLen, dz = rdz / rdLen;

    // Camera
    let px = 0, py = 0, pz = 3;
    let totalDist = 0;
    let hit = false;
    let steps = 0;

    // Raymarch (20 steps, 2-oct fbm — profiled for 15+ fps)
    for (let i = 0; i < 20; i++) {
      const cx = px + dx * totalDist, cy = py + dy * totalDist, cz = pz + dz * totalDist;
      const sLen = Math.sqrt(cx * cx + cy * cy + cz * cz);
      const theta = Math.atan2(cy, cx), phi = Math.asin(cz / (sLen || 1));
      const disp = ffbm2(theta * 2 + t * 0.5 + bass, phi * 3 + t * 0.3) * 0.15 * (1 + mid * 2);
      const bandIdx = Math.floor(((theta / Math.PI + 1) * 0.5) * bands.length);
      const bandDisp = (bands[Math.max(0, Math.min(bandIdx, bands.length - 1))] || 0) * 0.12;
      const d = sLen - 1.0 - disp - bandDisp;

      if (d < 0.015) { hit = true; steps = i; break; }
      if (totalDist > 6) break;
      totalDist += Math.max(d, 0.03); // min step prevents crawling near surface
    }

    let r = 0, g = 0, b2 = 0;
    if (hit) {
      const hx = px + dx * totalDist, hy = py + dy * totalDist, hz = pz + dz * totalDist;
      // Normal (approximate via gradient)
      const nLen = Math.sqrt(hx * hx + hy * hy + hz * hz);
      const nx = hx / nLen, ny = hy / nLen, nz = hz / nLen;

      // Lighting — key + fill + rim
      const lx = 0.5, ly = 0.7, lz = 0.3, lLen = Math.sqrt(lx * lx + ly * ly + lz * lz);
      const ndotl = Math.max(0, nx * lx / lLen + ny * ly / lLen + nz * lz / lLen);
      const fill = Math.max(0, ny * 0.3 + 0.2);
      const rim = Math.pow(1 - Math.max(0, -(nx * dx + ny * dy + nz * dz)), 3) * 0.6;

      // Surface color from audio
      const theta2 = Math.atan2(hy, hx);
      const hue = (theta2 / Math.PI + 1) * 0.5 + t * 0.05;
      r = (0.5 + 0.5 * Math.cos(hue * 6.28)) * (ndotl + fill) + rim * (0.5 + beat);
      g = (0.5 + 0.5 * Math.cos(hue * 6.28 + 2.094)) * (ndotl + fill) + rim * 0.3;
      b2 = (0.5 + 0.5 * Math.cos(hue * 6.28 + 4.189)) * (ndotl + fill) + rim * (0.8 + treble);

      // AO approximation
      const ao = 1 - steps / 40 * 0.5;
      r *= ao; g *= ao; b2 *= ao;
    } else {
      // Background — dark gradient
      r = 0.02; g = 0.01 + uy * 0.02; b2 = 0.05 + uy * 0.03;
    }

    const [tr, tg, tb] = acesTonemap(r, g, b2);
    setPixel(fb, w, x, y, tr, tg, tb);
  }
};

// 24: Liquid Metal — chrome-like reflections with domain warping
const shaderLiquidMetal: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let ux = x / w * 3, uy = y / h * 3;
    const t2 = t * 0.4;

    // Triple domain warp — creates liquid metal look (3+2+2 octaves, profiled)
    const n1 = ffbm(ux + t2, uy + t2 * 0.7 + bass, 3);
    const n2 = ffbm2(ux + n1 * 2 + mid, uy - n1 * 1.5 + treble);
    const n3 = ffbm2(ux - n2 + t2 * 0.3, uy + n2 * 2 + t2 * 0.5);

    // Spectrum modulation
    const bi = Math.floor(ux / 3 * bands.length);
    const bandVal = (bands[Math.max(0, Math.min(bi, bands.length - 1))] || 0) * 2;

    // Chrome gradient — silver with colored highlights
    const v = n3 * (1 + bandVal * 0.5);
    const edge = Math.abs(n2 - 0.5) * 4; // sharp edges = chrome reflections

    let r = 0.6 + edge * 0.4 + n1 * 0.3;
    let g = 0.6 + edge * 0.35 + n2 * 0.2;
    let b2 = 0.7 + edge * 0.3 + n3 * 0.4;

    // Color tint from audio
    r += bass * 0.3 * v; g += mid * 0.2 * v; b2 += treble * 0.4 * v;

    // Specular highlights
    if (edge > 0.8) { r += 0.4; g += 0.4; b2 += 0.4; }

    r *= 0.5 + beat * 0.2; g *= 0.5 + beat * 0.15; b2 *= 0.5 + beat * 0.1;

    const [tr, tg, tb] = acesTonemap(r, g, b2);
    setPixel(fb, w, x, y, tr, tg, tb);
  }
};

// 25: DNA Helix — rotating double helix with audio-reactive base pairs
const shaderDNA: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  for (let i = 0; i < fb.length; i++) fb[i] = (fb[i] * 0.75) | 0;
  const cx = w / 2;
  for (let y = 0; y < h; y++) {
    const phase = y / h * Math.PI * 6 + t * 2;
    const bi = Math.floor((y / h) * bands.length);
    const level = (bands[Math.min(bi, bands.length - 1)] || 0) * 3;
    const radius = (cx * 0.35 + level * cx * 0.15) * (1 + beat * 0.15);

    // Two helix strands
    const x1 = Math.floor(cx + Math.cos(phase) * radius);
    const x2 = Math.floor(cx - Math.cos(phase) * radius);
    const depth1 = Math.sin(phase); // -1 to 1, controls brightness
    const depth2 = -depth1;

    // Strand 1 (cyan)
    const b1 = Math.max(0.2, 0.5 + depth1 * 0.5);
    for (let dx = -1; dx <= 1; dx++) setPixel(fb, w, x1 + dx, y, 30 * b1, 200 * b1, 255 * b1);

    // Strand 2 (magenta)
    const b2a = Math.max(0.2, 0.5 + depth2 * 0.5);
    for (let dx = -1; dx <= 1; dx++) setPixel(fb, w, x2 + dx, y, 255 * b2a, 50 * b2a, 200 * b2a);

    // Base pair rungs — only draw when both strands are at similar depth (visible)
    if (y % 3 === 0 && Math.abs(depth1) < 0.6) {
      const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
      const rungBright = (0.3 + level * 0.2) * (1 - Math.abs(depth1));
      const [cr, cg, cb] = hsl((y / h + t * 0.05) % 1, 0.8, 0.4);
      for (let x = minX + 2; x < maxX - 1; x += 2)
        setPixel(fb, w, x, y, cr * rungBright, cg * rungBright, cb * rungBright);
    }
  }
  // Beat flash at center
  if (beat > 0.4) for (let y = 0; y < h; y++) setPixel(fb, w, cx | 0, y, 60 * beat, 60 * beat, 80 * beat);
};

// 26: Rain — digital rainfall with audio-reactive density and splash
const RAIN_DROPS: { x: number; y: number; speed: number; len: number; hue: number }[] = [];
const shaderRain: ShaderFn = (fb, w, h, _t, bands, bass, _m, treble, beat) => {
  for (let i = 0; i < fb.length; i++) fb[i] = (fb[i] * 0.82) | 0;
  // Spawn drops — density scales with bass
  const spawnRate = 2 + Math.floor(bass * 10 + beat * 8);
  for (let i = 0; i < spawnRate && RAIN_DROPS.length < 400; i++) {
    const bi = Math.floor(Math.random() * bands.length);
    RAIN_DROPS.push({
      x: Math.floor(Math.random() * w), y: -Math.floor(Math.random() * 5),
      speed: 1 + Math.random() * 2 + treble * 2, len: 3 + Math.floor(Math.random() * 5),
      hue: bi / bands.length,
    });
  }
  // Update + render drops
  for (let i = RAIN_DROPS.length - 1; i >= 0; i--) {
    const d = RAIN_DROPS[i];
    d.y += d.speed;
    if (d.y > h + d.len) { RAIN_DROPS.splice(i, 1); continue; }
    const [cr, cg, cb] = hsl(d.hue, 0.6, 0.5);
    for (let dy = 0; dy < d.len; dy++) {
      const py = Math.floor(d.y) - dy;
      const fade = 1 - dy / d.len;
      setPixel(fb, w, d.x, py, cr * fade, cg * fade, cb * fade);
    }
    // Splash at bottom
    if (d.y >= h - 1 && d.y < h + 1) {
      const splash = 3 + Math.floor(bass * 4);
      for (let sx = -splash; sx <= splash; sx++) {
        const sy = h - 1 - Math.abs(sx) * 0.3;
        setPixel(fb, w, d.x + sx, sy | 0, cr * 0.5, cg * 0.5, cb * 0.5);
      }
    }
  }
  // Puddle reflections at bottom
  for (let x = 0; x < w; x++) {
    const bi = Math.floor((x / w) * bands.length);
    const level = (bands[Math.min(bi, bands.length - 1)] || 0) * 2;
    setPixel(fb, w, x, h - 1, 20 + level * 40, 30 + level * 60, 50 + level * 80);
  }
};

// 27: Oscilloscope XY — classic analog scope Lissajous with phosphor decay
const shaderOscXY: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat, samples) => {
  // Slow phosphor decay — green CRT look
  for (let i = 0; i < fb.length; i += 3) { fb[i] = (fb[i] * 0.6) | 0; fb[i + 1] = (fb[i + 1] * 0.85) | 0; fb[i + 2] = (fb[i + 2] * 0.6) | 0; }
  const cx = w / 2, cy = h / 2;
  // Graticule
  for (let x = 0; x < w; x++) setPixel(fb, w, x, cy | 0, 10, 30, 10);
  for (let y = 0; y < h; y++) setPixel(fb, w, cx | 0, y, 10, 30, 10);
  // Beam
  if (samples && samples.length > 1) {
    const step = Math.max(1, Math.floor(samples.length / 1200));
    for (let i = 0; i < samples.length - step; i += step) {
      const xSig = samples[i] || 0, ySig = samples[Math.min(i + Math.floor(samples.length * 0.25), samples.length - 1)] || 0;
      const px = Math.floor(cx + xSig * cx * 0.85 * (1 + bass * 0.3));
      const py = Math.floor(cy + ySig * cy * 0.42 * (1 + treble * 0.3));
      // Bright center dot + bloom
      setPixel(fb, w, px, py, 40, 255, 40);
      setPixel(fb, w, px - 1, py, 20, 150, 20);
      setPixel(fb, w, px + 1, py, 20, 150, 20);
      setPixel(fb, w, px, py - 1, 20, 100, 20);
    }
  } else {
    // Demo: Lissajous with band-driven frequencies
    const fx = 3 + Math.floor(bass * 5), fy = 2 + Math.floor(treble * 4);
    for (let i = 0; i < 3000; i++) {
      const theta = (i / 3000) * Math.PI * 2;
      const px = Math.floor(cx + Math.sin(fx * theta + t * 0.8) * cx * 0.8);
      const py = Math.floor(cy + Math.sin(fy * theta + mid * 3) * cy * 0.4);
      setPixel(fb, w, px, py, 30, 255 * (0.5 + beat * 0.5), 30);
    }
  }
};

// 28: Terrain — 3D heightmap flyover driven by audio bands
const shaderTerrain: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  fb.fill(0);
  // Perspective ground plane — scanline from bottom to horizon
  const horizon = Math.floor(h * 0.35);
  for (let screenY = h - 1; screenY > horizon; screenY--) {
    const depth = (h - screenY) / (h - horizon); // 0 at bottom, 1 at horizon
    const z = 0.2 / (depth + 0.01) + t * 3; // world-Z, scrolling forward
    const scale = 1 / (depth + 0.01);
    for (let screenX = 0; screenX < w; screenX++) {
      const worldX = (screenX - w / 2) / scale * 0.15;
      // Height from noise + audio
      const bi = Math.floor(Math.abs(worldX) * bands.length * 0.2) % bands.length;
      const bandH = (bands[Math.min(bi, bands.length - 1)] || 0) * 3;
      const noise = fnoise(worldX * 2 + 0.5, z * 0.5) * 0.6 + bandH * 0.4;
      const terrainH = noise * (1 + bass * 0.8);
      // Project height to screen
      const projY = screenY - Math.floor(terrainH * scale * 2);
      if (projY < 0 || projY >= screenY) continue;
      // Color: green valleys, brown peaks, snow tops
      let r, g, b2;
      if (terrainH > 0.7) { r = 200 + beat * 55; g = 200 + beat * 55; b2 = 220; } // snow
      else if (terrainH > 0.4) { r = 120 + mid * 80; g = 80 + mid * 40; b2 = 40; } // brown
      else { r = 30; g = 100 + terrainH * 300; b2 = 30 + treble * 60; } // green
      const fog = Math.max(0, 1 - depth * 0.6);
      for (let py = projY; py <= screenY; py++)
        setPixel(fb, w, screenX, py, r * fog, g * fog, b2 * fog);
    }
  }
  // Sky gradient
  for (let y = 0; y <= horizon; y++) {
    const skyT = y / horizon;
    for (let x = 0; x < w; x++)
      setPixel(fb, w, x, y, 10 + skyT * 30, 10 + skyT * 20, 40 + skyT * 60 + beat * 30);
  }
};

// 29: Supernova — expanding shockwave explosion triggered by beat
const NOVA_RINGS: { age: number; maxAge: number; hue: number }[] = [];
const shaderSupernova: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  for (let i = 0; i < fb.length; i++) fb[i] = (fb[i] * 0.88) | 0;
  const cx = w / 2, cy = h / 2, maxR = Math.min(cx, cy) * 1.2;
  // Spawn new ring on strong beat
  if (beat > 0.5 && (NOVA_RINGS.length === 0 || NOVA_RINGS[NOVA_RINGS.length - 1].age > 8)) {
    NOVA_RINGS.push({ age: 0, maxAge: 60 + Math.floor(bass * 40), hue: (t * 0.1) % 1 });
  }
  // Render rings
  for (let ri = NOVA_RINGS.length - 1; ri >= 0; ri--) {
    const ring = NOVA_RINGS[ri];
    ring.age++;
    if (ring.age > ring.maxAge) { NOVA_RINGS.splice(ri, 1); continue; }
    const frac = ring.age / ring.maxAge;
    const radius = frac * maxR;
    const thickness = 2 + (1 - frac) * 6;
    const bright = (1 - frac) * (0.8 + beat * 0.4);
    const steps = Math.max(80, Math.floor(radius * 3));
    for (let s = 0; s < steps; s++) {
      const angle = (s / steps) * Math.PI * 2;
      const bIdx = Math.floor((s / steps) * bands.length);
      const bVal = (bands[Math.min(bIdx, bands.length - 1)] || 0) * 2;
      const r2 = radius + bVal * 3 * (1 - frac);
      const px = Math.floor(cx + Math.cos(angle) * r2 * 2); // 2x for aspect
      const py = Math.floor(cy + Math.sin(angle) * r2);
      const [cr, cg, cb] = hsl((ring.hue + frac * 0.3 + s / steps * 0.1) % 1, 1, 0.5);
      for (let dt = -thickness; dt <= thickness; dt++) {
        const fade = (1 - Math.abs(dt) / thickness) * bright;
        setPixel(fb, w, px + dt, py, cr * fade, cg * fade, cb * fade);
      }
    }
    // Core glow (early frames)
    if (frac < 0.3) {
      const coreR = (0.3 - frac) * 10;
      for (let dy = -coreR; dy <= coreR; dy++)
        for (let dx = -coreR * 2; dx <= coreR * 2; dx++)
          setPixel(fb, w, cx + dx | 0, cy + dy | 0, 255 * (1 - frac * 3), 200 * (1 - frac * 3), 100);
    }
  }
  // Background stars
  for (let s = 0; s < 40; s++) {
    const sx = Math.floor(fhash(s * 17.3) * w), sy = Math.floor(fhash(s * 31.7) * h);
    const flicker = 0.5 + 0.5 * Math.sin(t * 3 + s);
    setPixel(fb, w, sx, sy, 120 * flicker, 120 * flicker, 150 * flicker);
  }
};

// 30: Glitch — data corruption / scan line distortion aesthetic
const shaderGlitch: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  // Base: color bars / test pattern
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const bi = Math.floor((x / w) * bands.length);
    const level = (bands[Math.min(bi, bands.length - 1)] || 0) * 4;
    const barH = Math.floor(level * h);
    if (h - y < barH) {
      const [cr, cg, cb] = hsl(bi / bands.length, 0.8, 0.4);
      setPixel(fb, w, x, y, cr, cg, cb);
    } else {
      setPixel(fb, w, x, y, 8, 8, 12);
    }
  }
  // Glitch blocks — on beat, corrupt random rectangular regions
  const glitchIntensity = beat * 0.6 + bass * 0.4;
  const nBlocks = Math.floor(glitchIntensity * 12);
  for (let b = 0; b < nBlocks; b++) {
    const bx = Math.floor(fhash(t * 100 + b * 7.1) * w);
    const by = Math.floor(fhash(t * 100 + b * 13.3) * h);
    const bw2 = 4 + Math.floor(fhash(t * 100 + b * 3.7) * 30);
    const bh2 = 1 + Math.floor(fhash(t * 100 + b * 19.9) * 6);
    const shift = Math.floor((fhash(t * 100 + b * 23.1) - 0.5) * 20);
    // Copy shifted pixels (horizontal shift = classic glitch)
    for (let dy = 0; dy < bh2 && by + dy < h; dy++)
      for (let dx = 0; dx < bw2 && bx + dx < w; dx++) {
        const sx = bx + dx + shift;
        if (sx < 0 || sx >= w) continue;
        const si = ((by + dy) * w + sx) * 3, di = ((by + dy) * w + bx + dx) * 3;
        if (si + 2 < fb.length && di + 2 < fb.length) {
          fb[di] = fb[si]; fb[di + 1] = fb[si + 1]; fb[di + 2] = fb[si + 2];
        }
      }
  }
  // Scan lines
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    if (i + 2 < fb.length) { fb[i] = (fb[i] * 0.7) | 0; fb[i + 1] = (fb[i + 1] * 0.7) | 0; fb[i + 2] = (fb[i + 2] * 0.7) | 0; }
  }
  // RGB channel split on beat
  if (beat > 0.3) {
    const shift2 = Math.floor(beat * 4);
    for (let y = 0; y < h; y++) for (let x = w - 1; x >= shift2; x--) {
      const i = (y * w + x) * 3, si = (y * w + x - shift2) * 3;
      if (si >= 0 && i + 2 < fb.length) fb[i] = fb[si]; // shift red channel right
    }
  }
  // Static noise band (VHS tracking error)
  const trackY = Math.floor((t * 20 + treble * h) % h);
  for (let dy = 0; dy < 3 && trackY + dy < h; dy++)
    for (let x = 0; x < w; x++) {
      const noise = Math.floor(fhash(x * 0.1 + trackY + t * 1000) * 255 * mid);
      setPixel(fb, w, x, trackY + dy, noise, noise, noise);
    }
};

// 31: Metaballs — organic merging blobs, the demoscene classic
const META_BLOBS = Array.from({ length: 7 }, (_, i) => ({
  ax: 0.3 + i * 0.17, ay: 0.2 + i * 0.11, bx: 0.5 + i * 0.13, by: 0.7 + i * 0.09,
}));
const shaderMetaballs: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const nBlobs = 7;
  // Move blob centers with audio
  const cx: number[] = [], cy: number[] = [], rr: number[] = [];
  for (let i = 0; i < nBlobs; i++) {
    const b = META_BLOBS[i];
    const bi = Math.floor((i / nBlobs) * bands.length);
    const level = (bands[Math.min(bi, bands.length - 1)] || 0) * 2;
    cx[i] = w * (0.5 + 0.35 * Math.sin(t * b.ax + i * 2.1 + bass * 3));
    cy[i] = h * (0.5 + 0.35 * Math.cos(t * b.ay + i * 1.7 + mid * 2));
    rr[i] = (8 + level * 12 + beat * 6) * (1 + bass * 0.5);
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let field = 0;
    for (let i = 0; i < nBlobs; i++) {
      const dx = (x - cx[i]) * 0.5, dy = y - cy[i]; // 0.5x for aspect
      field += rr[i] * rr[i] / (dx * dx + dy * dy + 1);
    }
    // Threshold + coloring
    if (field > 1) {
      const v = Math.min(field, 4) / 4;
      const hue = (v * 0.3 + t * 0.05 + x / w * 0.1) % 1;
      const [r, g, b2] = hsl(hue, 0.9, 0.3 + v * 0.4 * (0.8 + beat * 0.4));
      setPixel(fb, w, x, y, r, g, b2);
    } else {
      // Dark background with subtle grid
      setPixel(fb, w, x, y, 5, 5, 10 + field * 15);
    }
  }
};

// 32: Water Ripples — concentric interference from beat-triggered sources
const RIPPLE_SOURCES: { x: number; y: number; birth: number }[] = [];
let rippleFrame = 0;
const shaderRipples: ShaderFn = (fb, w, h, _t, bands, bass, mid, treble, beat) => {
  rippleFrame++;
  // Spawn new source on beat
  if (beat > 0.5 && (RIPPLE_SOURCES.length === 0 || rippleFrame - RIPPLE_SOURCES[RIPPLE_SOURCES.length - 1].birth > 8)) {
    RIPPLE_SOURCES.push({ x: Math.random() * w, y: Math.random() * h, birth: rippleFrame });
    if (RIPPLE_SOURCES.length > 6) RIPPLE_SOURCES.shift();
  }
  // Persistent sources at edges for bass
  const permaX = [w * 0.2, w * 0.8, w * 0.5];
  const permaY = [h * 0.5, h * 0.5, h * 0.2];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let wave = 0;
    // Beat-triggered ripples
    for (const src of RIPPLE_SOURCES) {
      const age = (rippleFrame - src.birth) * 0.5;
      const dx = (x - src.x) * 0.5, dy = y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const decay = Math.exp(-age * 0.03) * Math.exp(-dist * 0.02);
      wave += Math.sin(dist * 0.8 - age * 0.6) * decay;
    }
    // Permanent wave sources driven by bass/mid/treble
    const levels = [bass, mid, treble];
    for (let p = 0; p < 3; p++) {
      const dx = (x - permaX[p]) * 0.5, dy = y - permaY[p];
      const dist = Math.sqrt(dx * dx + dy * dy);
      wave += Math.sin(dist * (0.3 + levels[p] * 0.8) - rippleFrame * 0.15) * levels[p] * 0.6 / (1 + dist * 0.05);
    }
    // Color: deep blue water with wave highlights
    const v = wave * 0.5 + 0.5;
    const r = Math.max(0, v - 0.7) * 3 * 255 * (0.5 + beat * 0.5);
    const g = v * 80 + Math.max(0, v - 0.5) * 200;
    const b2 = 40 + v * 180;
    setPixel(fb, w, x, y, r, g, b2);
  }
};

// 33: Flow Field — particles following Perlin noise, colored by frequency
const FLOW_PARTS: { x: number; y: number; age: number; hue: number }[] = [];
const shaderFlowField: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  // Slow fade for trails
  for (let i = 0; i < fb.length; i++) fb[i] = (fb[i] * 0.92) | 0;
  // Spawn particles
  const spawn = 5 + Math.floor(bass * 15 + beat * 20);
  for (let i = 0; i < spawn && FLOW_PARTS.length < 600; i++) {
    FLOW_PARTS.push({
      x: Math.random() * w, y: Math.random() * h,
      age: 0, hue: Math.random(),
    });
  }
  // Update + render
  const speed = 1.5 + mid * 3 + beat * 2;
  for (let i = FLOW_PARTS.length - 1; i >= 0; i--) {
    const p = FLOW_PARTS[i];
    // Flow angle from noise field
    const nx = p.x / w * 3, ny = p.y / h * 3;
    const angle = fnoise(nx + t * 0.3, ny + t * 0.2) * Math.PI * 4 + bass * 2;
    p.x += Math.cos(angle) * speed * 2; // 2x for aspect
    p.y += Math.sin(angle) * speed;
    p.age++;
    // Die if out of bounds or too old
    if (p.x < 0 || p.x >= w || p.y < 0 || p.y >= h || p.age > 120) {
      FLOW_PARTS.splice(i, 1); continue;
    }
    const alpha = Math.min(1, p.age / 5) * Math.max(0, 1 - p.age / 120);
    const bi = Math.floor((p.x / w) * bands.length);
    const level = (bands[Math.min(bi, bands.length - 1)] || 0) * 3;
    const [cr, cg, cb] = hsl((p.hue + t * 0.02) % 1, 0.8, 0.4 + level * 0.3);
    setPixel(fb, w, p.x | 0, p.y | 0, cr * alpha, cg * alpha, cb * alpha);
  }
};

// 34: Lightning — recursive fractal arcs triggered by beats
const BOLTS: { segments: { x1: number; y1: number; x2: number; y2: number; bright: number }[]; age: number }[] = [];
function genBolt(x1: number, y1: number, x2: number, y2: number, depth: number, jitter: number): { x1: number; y1: number; x2: number; y2: number; bright: number }[] {
  if (depth <= 0) return [{ x1, y1, x2, y2, bright: 1 }];
  const mx = (x1 + x2) / 2 + (Math.random() - 0.5) * jitter;
  const my = (y1 + y2) / 2 + (Math.random() - 0.5) * jitter * 0.5;
  const segs = [...genBolt(x1, y1, mx, my, depth - 1, jitter * 0.6), ...genBolt(mx, my, x2, y2, depth - 1, jitter * 0.6)];
  // Branch
  if (depth > 2 && Math.random() < 0.3) {
    const bx = mx + (Math.random() - 0.5) * jitter * 1.5;
    const by = my + (Math.random() + 0.5) * jitter * 0.8;
    segs.push(...genBolt(mx, my, bx, by, depth - 2, jitter * 0.5).map(s => ({ ...s, bright: s.bright * 0.5 })));
  }
  return segs;
}
const shaderLightning: ShaderFn = (fb, w, h, _t, bands, bass, _m, treble, beat) => {
  // Fade
  for (let i = 0; i < fb.length; i++) fb[i] = (fb[i] * 0.75) | 0;
  // Spawn bolt on beat
  if (beat > 0.4 && (BOLTS.length === 0 || BOLTS[BOLTS.length - 1].age > 5)) {
    const x1 = w * (0.3 + Math.random() * 0.4), x2 = x1 + (Math.random() - 0.5) * w * 0.3;
    BOLTS.push({ segments: genBolt(x1, 0, x2, h, 6, w * 0.15), age: 0 });
    if (BOLTS.length > 4) BOLTS.shift();
  }
  // Render bolts
  for (let bi = BOLTS.length - 1; bi >= 0; bi--) {
    const bolt = BOLTS[bi]; bolt.age++;
    if (bolt.age > 20) { BOLTS.splice(bi, 1); continue; }
    const decay = Math.max(0, 1 - bolt.age / 20);
    for (const seg of bolt.segments) {
      const steps = Math.max(4, Math.floor(Math.sqrt((seg.x2 - seg.x1) ** 2 + (seg.y2 - seg.y1) ** 2)));
      for (let s = 0; s <= steps; s++) {
        const t2 = s / steps;
        const px = seg.x1 + (seg.x2 - seg.x1) * t2;
        const py = seg.y1 + (seg.y2 - seg.y1) * t2;
        const b = decay * seg.bright;
        // Core (white-blue)
        setPixel(fb, w, px | 0, py | 0, 200 * b, 200 * b, 255 * b);
        // Glow
        setPixel(fb, w, (px - 1) | 0, py | 0, 80 * b, 80 * b, 180 * b);
        setPixel(fb, w, (px + 1) | 0, py | 0, 80 * b, 80 * b, 180 * b);
      }
    }
  }
  // Ambient energy flicker from treble
  if (treble > 0.3) {
    for (let i = 0; i < Math.floor(treble * 20); i++) {
      const fx = Math.floor(Math.random() * w), fy = Math.floor(Math.random() * h);
      setPixel(fb, w, fx, fy, 40, 40, 80 * treble);
    }
  }
};

// 35: Spectrogram — scrolling waterfall frequency display (cava-style)
const SPECTRO_HIST: Float32Array[] = [];
const shaderSpectrogram: ShaderFn = (fb, w, h, _t, bands, bass, _m, _tr, beat) => {
  // Push current frame's bands to history
  const snap = new Float32Array(bands.length);
  for (let i = 0; i < bands.length; i++) snap[i] = bands[i];
  SPECTRO_HIST.push(snap);
  if (SPECTRO_HIST.length > w) SPECTRO_HIST.shift();
  // Render: x = time (right = now), y = frequency (bottom = low)
  fb.fill(0);
  for (let x = 0; x < SPECTRO_HIST.length; x++) {
    const col = SPECTRO_HIST[x];
    const screenX = w - SPECTRO_HIST.length + x;
    if (screenX < 0) continue;
    for (let y = 0; y < h; y++) {
      const bi = Math.floor(((h - 1 - y) / h) * col.length);
      const level = Math.min(1, (col[Math.min(bi, col.length - 1)] || 0) * 5);
      if (level < 0.02) continue;
      // Heatmap: black → blue → cyan → green → yellow → red → white
      let r = 0, g = 0, b2 = 0;
      if (level < 0.2) { b2 = level * 5 * 255; }
      else if (level < 0.4) { const t2 = (level - 0.2) * 5; b2 = 255; g = t2 * 255; }
      else if (level < 0.6) { const t2 = (level - 0.4) * 5; g = 255; b2 = (1 - t2) * 255; }
      else if (level < 0.8) { const t2 = (level - 0.6) * 5; g = 255; r = t2 * 255; }
      else { const t2 = (level - 0.8) * 5; r = 255; g = (1 - t2 * 0.5) * 255; b2 = t2 * 255; }
      setPixel(fb, w, screenX, y, r, g, b2);
    }
  }
};

// 36: Saturn Ring — circular spectrum (inspired by cava's orion shader)
const shaderSaturn: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const cx = w / 2, cy = h / 2, aspect = w / (h * 2);
  const baseR = Math.min(cx, cy) * 0.45;
  const maxLen = baseR * 0.5;
  fb.fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x - cx) / aspect, dy = (y - cy) * 2; // correct for terminal aspect
    const dist = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);
    // Map angle to bar index
    const a = ((angle + Math.PI) / (Math.PI * 2));
    const bi = Math.floor(a * bands.length) % bands.length;
    const level = Math.min(1, (bands[bi] || 0) * 5) * (1 + beat * 0.3);
    const barLen = 3 + level * maxLen;
    // Ring: draw if dist is between baseR and baseR + barLen
    if (dist > baseR - 2 && dist < baseR + barLen) {
      const frac = (dist - baseR) / barLen;
      // Gradient: bottom is bright, top fades
      const bright = Math.max(0, 1 - frac * 0.7) * (0.6 + level * 0.4);
      const [cr, cg, cb] = hsl((a + t * 0.03) % 1, 0.9, 0.4);
      setPixel(fb, w, x, y, cr * bright, cg * bright, cb * bright);
    }
    // Inner glow (core energy)
    if (dist < baseR - 2) {
      const coreEnergy = bass * 0.4 + mid * 0.3;
      const coreDist = dist / baseR;
      const glow = Math.pow(1 - coreDist, 2) * coreEnergy;
      setPixel(fb, w, x, y, glow * 100, glow * 60, glow * 200);
    }
  }
  // Highlight ring edge
  for (let s = 0; s < 360; s++) {
    const angle = (s / 360) * Math.PI * 2;
    const px = cx + Math.cos(angle) * baseR * aspect | 0;
    const py = cy + Math.sin(angle) * baseR * 0.5 | 0;
    setPixel(fb, w, px, py, 60 + beat * 100, 60 + beat * 80, 80 + beat * 120);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ✦ ART PIECES — beauty first, data second
// ═══════════════════════════════════════════════════════════════════════════

// 37: Jellyfish — bioluminescent creatures pulsing in the deep
const shaderJellyfish: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  // Deep ocean background
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const depth = y / h;
    setPixel(fb, w, x, y, 2, 3 + depth * 8, 15 + depth * 25);
  }
  // 4 jellyfish, each driven by different frequency band
  const jellies = [
    { cx: 0.25, cy: 0.4, freq: bass, hue: 0.55, size: 1.2 },
    { cx: 0.65, cy: 0.35, freq: mid, hue: 0.8, size: 0.9 },
    { cx: 0.45, cy: 0.55, freq: treble, hue: 0.15, size: 1.0 },
    { cx: 0.8, cy: 0.5, freq: (bass + mid) / 2, hue: 0.35, size: 0.7 },
  ];
  for (const j of jellies) {
    const jx = w * (j.cx + Math.sin(t * 0.3 + j.hue * 10) * 0.08);
    const jy = h * (j.cy + Math.cos(t * 0.2 + j.hue * 7) * 0.06);
    const pulse = 1 + j.freq * 0.5 + beat * 0.3;
    const bellW = 12 * j.size * pulse, bellH = 8 * j.size * pulse;
    // Bell (dome)
    for (let dy = -bellH; dy <= 0; dy++) for (let dx = -bellW; dx <= bellW; dx++) {
      const nx = dx / bellW, ny = dy / bellH;
      const d = nx * nx + ny * ny;
      if (d > 1) continue;
      const bright = (1 - d) * (0.4 + j.freq * 0.8 + beat * 0.3);
      const edge = d > 0.7 ? (d - 0.7) / 0.3 * 0.6 : 0;
      const [cr, cg, cb] = hsl(j.hue, 0.7, 0.3 + bright * 0.4);
      const px = jx + dx | 0, py = jy + dy | 0;
      setPixel(fb, w, px, py, cr * bright + edge * 80, cg * bright + edge * 40, cb * bright + edge * 120);
    }
    // Tentacles — sinusoidal curves trailing down
    for (let tent = 0; tent < 5; tent++) {
      const ox = (tent - 2) * bellW * 0.35;
      for (let ty = 0; ty < h * 0.35; ty++) {
        const sway = Math.sin(ty * 0.15 + t * 2 + tent * 1.7 + j.freq * 4) * (3 + ty * 0.1);
        const fade = Math.max(0, 1 - ty / (h * 0.35));
        const bi2 = Math.floor((ty / (h * 0.35)) * bands.length);
        const bVal = (bands[Math.min(bi2, bands.length - 1)] || 0) * 2;
        const [cr, cg, cb] = hsl((j.hue + ty * 0.002) % 1, 0.6, 0.2 + bVal * 0.3);
        const px = jx + ox + sway | 0, py = jy + ty | 0;
        setPixel(fb, w, px, py, cr * fade, cg * fade, cb * fade);
      }
    }
  }
  // Floating bioluminescent particles
  for (let p = 0; p < 40; p++) {
    const px = (fhash(p * 13.7) * w + Math.sin(t * 0.5 + p) * 10) % w | 0;
    const py = (fhash(p * 29.3) * h + Math.cos(t * 0.3 + p * 1.7) * 8) % h | 0;
    const flicker = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 3 + p * 2.3));
    setPixel(fb, w, px, py, 40 * flicker, 80 * flicker, 120 * flicker);
  }
};

// 38: Stained Glass — Voronoi cells with jewel-toned fills and lead borders
const shaderStainedGlass: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const nPoints = 12;
  // Cell centers — slowly drifting, audio-perturbed
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < nPoints; i++) {
    const bi = Math.floor((i / nPoints) * bands.length);
    const level = (bands[Math.min(bi, bands.length - 1)] || 0) * 2;
    pts.push({
      x: (fhash2(i, 0) + Math.sin(t * 0.15 + i * 2.3) * 0.15 + level * 0.05) * w,
      y: (fhash2(0, i) + Math.cos(t * 0.12 + i * 1.9) * 0.15 + level * 0.05) * h,
    });
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let minD = 1e9, minD2 = 1e9, minI = 0;
    for (let i = 0; i < nPoints; i++) {
      const dx = (x - pts[i].x) * 0.5, dy = y - pts[i].y; // aspect correction
      const d = dx * dx + dy * dy;
      if (d < minD) { minD2 = minD; minD = d; minI = i; } else if (d < minD2) { minD2 = d; }
    }
    const edge = Math.sqrt(minD2) - Math.sqrt(minD);
    const isLead = edge < 1.5;
    if (isLead) {
      // Lead lines — dark grey with highlight on beat
      setPixel(fb, w, x, y, 25 + beat * 40, 25 + beat * 30, 30 + beat * 50);
    } else {
      // Jewel tones — each cell gets a rich saturated color
      const hue = (fhash(minI * 7.3 + 0.1) + t * 0.01) % 1;
      const sat = 0.85;
      // Brightness: center of cell is bright, edges darker (cathedral light)
      const cellFrac = Math.sqrt(minD) / (Math.sqrt(minD) + Math.sqrt(minD2));
      const light = 0.25 + (1 - cellFrac) * 0.35;
      // Audio: cell brightens based on its frequency band
      const bi = Math.floor((minI / nPoints) * bands.length);
      const level = (bands[Math.min(bi, bands.length - 1)] || 0) * 3;
      const glow = light + level * 0.3 + beat * 0.15;
      const [cr, cg, cb] = hsl(hue, sat, glow);
      setPixel(fb, w, x, y, cr, cg, cb);
    }
  }
};

// 39: Northern Lights — flowing curtains over a dark horizon (cava-inspired but cinematic)
const shaderNorthernLights: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ux = x / w, uy = y / h;
    // Sky: dark gradient, darker at top
    let r = 0.01, g = 0.01, b2 = 0.03 + (1 - uy) * 0.04;
    // 6 aurora curtains with different heights and colors
    for (let i = 0; i < 6; i++) {
      const fi = i;
      // Curtain center Y — undulates with fbm
      const centerY = 0.3 + fi * 0.04 + fnoise(ux * (1.5 + fi * 0.3) + t * (0.1 + fi * 0.02), fi * 5 + t * 0.05) * (0.15 + bass * 0.08);
      const dist = Math.abs(uy - centerY);
      // Gaussian-ish curtain shape
      const curtain = Math.exp(-dist * dist * (80 + fi * 20));
      if (curtain < 0.01) continue;
      // Brightness varies along X with audio
      const bi = Math.floor(ux * bands.length);
      const spec = (bands[Math.min(bi, bands.length - 1)] || 0) * 3;
      const shimmer = 0.5 + 0.5 * Math.sin(ux * 30 + t * 2 + fi * 7);
      const intensity = curtain * (0.3 + spec * 0.6 + shimmer * 0.2) * (0.8 + beat * 0.3);
      // Color: green → teal → purple → pink across curtains
      const hues = [0.35, 0.4, 0.5, 0.6, 0.75, 0.85];
      const [cr, cg, cb] = hsl(hues[i], 0.8, 0.5);
      r += cr / 255 * intensity;
      g += cg / 255 * intensity;
      b2 += cb / 255 * intensity;
    }
    // Stars (only in dark areas)
    if (r + g + b2 < 0.15 && uy < 0.6) {
      const sx = Math.floor(x * 0.7), sy = Math.floor(y * 0.7);
      if (fhash2(sx, sy) > 0.994) {
        const twinkle = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 4 + sx * 3.7));
        r += twinkle * 0.7; g += twinkle * 0.7; b2 += twinkle * 0.8;
      }
    }
    // Treeline silhouette at bottom
    if (uy > 0.85) {
      const treeH = 0.85 + fnoise(x * 0.05, 0) * 0.1;
      if (uy > treeH) { r = 0.01; g = 0.01; b2 = 0.02; }
    }
    setPixel(fb, w, x, y, Math.min(255, r * 255), Math.min(255, g * 255), Math.min(255, b2 * 255));
  }
};

// 40: Ocean Deep — underwater caustics + swimming light rays
const shaderOceanDeep: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ux = x / w * 5, uy = y / h * 5;
    const t2 = t * 0.4;
    // Fake caustics: layered sine interference (the chroma trick)
    const c1 = Math.sin(ux * 3 + t2 + Math.sin(uy * 2 + t2 * 0.7) * 2);
    const c2 = Math.sin(uy * 2.5 - t2 * 0.8 + Math.sin(ux * 1.5 + t2 * 1.1) * 1.5);
    const c3 = Math.sin((ux + uy) * 1.8 + t2 * 0.6 + bass * 4);
    const caustic = (c1 + c2 + c3) / 3 * 0.5 + 0.5;
    const bright = Math.pow(caustic, 3) * (0.5 + mid * 0.8 + beat * 0.3); // sharpen highlights
    // Audio band modulation
    const bi = Math.floor((x / w) * bands.length);
    const bv = (bands[Math.min(bi, bands.length - 1)] || 0) * 2;
    // Depth gradient — lighter at top
    const depthFade = 0.3 + (1 - y / h) * 0.7;
    // Color: deep blue-green ocean
    const r = (bright * 0.3 + bv * 0.1) * depthFade;
    const g = (0.1 + bright * 0.6 + bv * 0.2) * depthFade;
    const b3 = (0.3 + bright * 0.4 + bv * 0.15) * depthFade;
    // Light rays from top (volumetric god rays)
    const rayAngle = (x / w - 0.5) * 2;
    const rayStrength = Math.exp(-Math.abs(rayAngle) * 3) * (1 - y / h) * (0.15 + treble * 0.3);
    const [tr, tg, tb] = acesTonemap(r + rayStrength * 0.5, g + rayStrength * 0.8, b3 + rayStrength * 0.6);
    setPixel(fb, w, x, y, tr, tg, tb);
  }
  // Bubbles
  for (let b = 0; b < 15; b++) {
    const bx = (fhash(b * 17.3) * w + Math.sin(t * 0.8 + b * 2.1) * 8) % w | 0;
    const by = (h - ((t * 15 + b * h * 0.3) % (h * 1.2))) | 0;
    if (by > 0 && by < h) {
      setPixel(fb, w, bx, by, 100, 180, 220);
      setPixel(fb, w, bx + 1, by, 80, 140, 180);
    }
  }
};

// 41: Ink — fluid ink drops spreading in water
const INK_DROPS: { x: number; y: number; age: number; hue: number }[] = [];
const shaderInk: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  // Warm parchment background
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const grain = fnoise(x * 0.3, y * 0.5) * 0.05;
    setPixel(fb, w, x, y, 230 + grain * 255, 215 + grain * 255, 195 + grain * 255);
  }
  // Spawn ink drops on beat
  if (beat > 0.3 && INK_DROPS.length < 12) {
    INK_DROPS.push({ x: Math.random() * w, y: Math.random() * h, age: 0, hue: Math.random() });
  }
  // Update + render drops
  for (let di = INK_DROPS.length - 1; di >= 0; di--) {
    const d = INK_DROPS[di];
    d.age++;
    if (d.age > 200) { INK_DROPS.splice(di, 1); continue; }
    const maxR = 6 + d.age * 0.4 + bass * 8;
    // Ink spreads with fbm distortion
    for (let y = Math.max(0, d.y - maxR | 0); y < Math.min(h, d.y + maxR | 0); y++) {
      for (let x = Math.max(0, d.x - maxR * 2 | 0); x < Math.min(w, d.x + maxR * 2 | 0); x++) {
        const dx = (x - d.x) * 0.5, dy = y - d.y;
        const baseDist = Math.sqrt(dx * dx + dy * dy);
        // Distort distance with fbm for organic edges
        const distort = ffbm2(x * 0.1 + d.hue * 10, y * 0.15 + t * 0.1) * maxR * 0.4;
        const dist = baseDist + distort;
        if (dist < maxR) {
          const fade = dist / maxR;
          const inkAlpha = (1 - fade * fade) * Math.min(1, d.age / 10);
          // Ink color: choose rich dark colors
          const inkHues = [0.6, 0.0, 0.08, 0.55, 0.75]; // blue, red, vermillion, teal, purple
          const ih = inkHues[Math.floor(d.hue * inkHues.length) % inkHues.length];
          const [cr, cg, cb] = hsl(ih, 0.8, 0.15 + (1 - inkAlpha) * 0.1);
          // Blend onto parchment
          const i = ((y | 0) * w + (x | 0)) * 3;
          if (i + 2 < fb.length && inkAlpha > 0.05) {
            fb[i] = fb[i] * (1 - inkAlpha) + cr * inkAlpha;
            fb[i + 1] = fb[i + 1] * (1 - inkAlpha) + cg * inkAlpha;
            fb[i + 2] = fb[i + 2] * (1 - inkAlpha) + cb * inkAlpha;
          }
        }
      }
    }
  }
};

// 42: Galaxy — spiral arms with stars, dust, and a bright core
const shaderGalaxy: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x - cx) / cx, dy = (y - cy) / cy * 2; // aspect
    const dist = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);
    // Spiral arms — logarithmic spiral
    const arms = 2;
    const twist = 3 + bass * 2;
    const spiralAngle = angle - Math.log(dist + 0.01) * twist + t * 0.15;
    const armDist = Math.abs(Math.sin(spiralAngle * arms));
    const armStrength = Math.exp(-armDist * (4 + treble * 3)) * Math.exp(-dist * 1.5);
    // Dust — fbm noise in the arms
    const dust = ffbm2(dx * 3 + t * 0.1, dy * 3 + t * 0.05) * armStrength;
    // Core glow — exponential falloff
    const core = Math.exp(-dist * dist * 8) * (1 + bass * 0.5 + beat * 0.4);
    // Band modulation along spiral
    const bi = Math.floor(((spiralAngle / Math.PI + 1) * 0.5) * bands.length) % bands.length;
    const bv = (bands[Math.max(0, bi)] || 0) * 2;
    // Color: warm core → blue-white arms → deep space
    let r = core * 1.5 + armStrength * (0.3 + bv * 0.4) + dust * 0.2;
    let g = core * 1.0 + armStrength * (0.4 + bv * 0.3) + dust * 0.15;
    let b2 = core * 0.5 + armStrength * (0.7 + bv * 0.5) + dust * 0.3;
    // Stars
    const sx = Math.floor(x * 0.5 + t * 0.3), sy = Math.floor(y * 0.5);
    if (fhash2(sx, sy) > 0.992 && dist > 0.1) {
      const sBright = (0.3 + treble * 0.5) * (1 - dist * 0.3);
      r += sBright * 0.9; g += sBright * 0.9; b2 += sBright;
    }
    r *= 0.8 + beat * 0.2;
    const [tr, tg, tb] = acesTonemap(r, g, b2);
    setPixel(fb, w, x, y, tr, tg, tb);
  }
};

// 43: Fireflies — warm summer night with glowing particles in tall grass
const FLIES: { x: number; y: number; phase: number; speed: number }[] = [];
const shaderFireflies: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  // Night sky gradient
  for (let y = 0; y < h; y++) {
    const skyT = Math.max(0, 1 - y / (h * 0.7));
    for (let x = 0; x < w; x++) {
      setPixel(fb, w, x, y, 5 + skyT * 10, 5 + skyT * 15, 15 + skyT * 30);
    }
  }
  // Tall grass silhouette (bottom 30%)
  const grassTop = h * 0.65;
  for (let x = 0; x < w; x++) {
    const bladeH = fnoise(x * 0.15, 0) * h * 0.2 + Math.sin(x * 0.3 + t * 0.5 + bass) * h * 0.03;
    const grassY = grassTop + bladeH;
    for (let y = grassY | 0; y < h; y++) {
      const depth = (y - grassY) / (h - grassY);
      setPixel(fb, w, x, y, 8 + depth * 5, 15 + depth * 8, 5 + depth * 3);
    }
  }
  // Moon
  const moonX = w * 0.75, moonY = h * 0.15, moonR = 4;
  for (let dy = -moonR; dy <= moonR; dy++) for (let dx = -moonR * 2; dx <= moonR * 2; dx++) {
    if ((dx / 2) ** 2 + dy ** 2 < moonR * moonR)
      setPixel(fb, w, moonX + dx | 0, moonY + dy | 0, 220, 215, 180);
  }
  // Manage fireflies
  while (FLIES.length < 40 + Math.floor(bass * 20)) {
    FLIES.push({ x: Math.random() * w, y: grassTop + Math.random() * (h * 0.3 - 10), phase: Math.random() * Math.PI * 2, speed: 0.5 + Math.random() });
  }
  while (FLIES.length > 60) FLIES.shift();
  for (const f of FLIES) {
    f.x += Math.sin(t * f.speed + f.phase) * 0.8;
    f.y += Math.cos(t * f.speed * 0.7 + f.phase * 1.3) * 0.4;
    // Glow: pulsing with a warm amber-green light
    const glow = 0.3 + 0.7 * Math.max(0, Math.sin(t * 2 * f.speed + f.phase));
    if (glow < 0.15) continue; // off phase
    const bright = glow * (0.6 + mid * 0.5 + beat * 0.3);
    // Soft glow radius
    for (let dy = -2; dy <= 2; dy++) for (let dx = -3; dx <= 3; dx++) {
      const d = Math.sqrt((dx / 2) ** 2 + dy ** 2);
      if (d > 2.5) continue;
      const fade = (1 - d / 2.5) * bright;
      const px = f.x + dx | 0, py = f.y + dy | 0;
      if (px >= 0 && px < w && py >= 0 && py < h) {
        const i = (py * w + px) * 3;
        fb[i] = Math.min(255, fb[i] + 180 * fade);
        fb[i + 1] = Math.min(255, fb[i + 1] + 220 * fade);
        fb[i + 2] = Math.min(255, fb[i + 2] + 30 * fade);
      }
    }
  }
};

// 44: Coral — reaction-diffusion inspired living reef
const shaderCoral: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ux = x / w * 6, uy = y / h * 6;
    const t2 = t * 0.15;
    // Layered noise with different octaves — simulates RD patterns
    const n1 = fnoise(ux * 2 + t2, uy * 2 + t2 * 0.5);
    const n2 = fnoise(ux * 4 + n1 * 2 + bass * 3, uy * 4 - n1 + mid * 2);
    const n3 = fnoise(ux * 8 + n2 + treble, uy * 8 + n2 * 1.5 + t2 * 0.3);
    // Threshold to create the coral-like branching patterns
    const pattern = Math.sin(n1 * 8 + n2 * 4) * Math.cos(n2 * 6 + n3 * 3);
    const v = pattern * 0.5 + 0.5;
    // Audio band color selection
    const bi = Math.floor((ux / 6) * bands.length);
    const bv = (bands[Math.min(bi, bands.length - 1)] || 0) * 3;
    // Coral palette: deep reds, oranges, pinks, purples
    let r, g, b2;
    if (v > 0.65) { // coral structure
      const t3 = (v - 0.65) / 0.35;
      r = 0.8 + t3 * 0.2 + bv * 0.15;
      g = 0.2 + t3 * 0.3 * mid;
      b2 = 0.3 + t3 * 0.2 + bv * 0.1;
    } else if (v > 0.4) { // transition zone
      const t3 = (v - 0.4) / 0.25;
      r = 0.5 * t3 + bv * 0.1;
      g = 0.15 + t3 * 0.1;
      b2 = 0.4 * t3 + 0.1;
    } else { // deep water between coral
      r = 0.02 + v * 0.1;
      g = 0.05 + v * 0.15;
      b2 = 0.15 + v * 0.2;
    }
    // Bioluminescent sparkle
    if (fhash2(Math.floor(x * 0.3), Math.floor(y * 0.3)) > 0.995 && v > 0.5) {
      const spark = 0.5 + treble * 0.5;
      r += spark * 0.3; g += spark * 0.5; b2 += spark * 0.3;
    }
    r *= 0.7 + beat * 0.3; g *= 0.7 + beat * 0.2; b2 *= 0.7 + beat * 0.15;
    const [tr, tg, tb] = acesTonemap(r, g, b2);
    setPixel(fb, w, x, y, tr, tg, tb);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ✦ ART PIECES II — cinematic, atmospheric, surreal
// ═══════════════════════════════════════════════════════════════════════════

// 45: Lava Lamp — warm metaballs with slow viscous motion and thermal glow
const shaderLavaLamp: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const nBlobs = 5;
  const cx: number[] = [], cy: number[] = [], rr: number[] = [];
  for (let i = 0; i < nBlobs; i++) {
    // Very slow sinusoidal motion — lava lamp is lazy
    cx[i] = w * (0.35 + 0.3 * Math.sin(t * 0.12 + i * 2.5));
    cy[i] = h * (0.15 + 0.7 * (0.5 + 0.5 * Math.sin(t * 0.08 + i * 1.9 + bass)));
    rr[i] = 10 + Math.sin(t * 0.15 + i * 3.1) * 4 + mid * 6 + beat * 3;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let field = 0;
    for (let i = 0; i < nBlobs; i++) {
      const dx = (x - cx[i]) * 0.5, dy = y - cy[i];
      field += rr[i] * rr[i] / (dx * dx + dy * dy + 1);
    }
    // Lava lamp palette: warm amber → deep orange → magenta → dark
    const uy = y / h;
    const bg_r = 0.08 + uy * 0.04, bg_g = 0.02, bg_b = 0.05 + (1 - uy) * 0.06;
    let r, g, b2;
    if (field > 1.2) {
      // Inside blob — hot
      const v = Math.min((field - 1.2) / 3, 1);
      r = 1.0; g = 0.4 + v * 0.5; b2 = 0.1 + v * 0.3;
      const glow = v * (0.6 + beat * 0.4);
      r += glow * 0.2; g += glow * 0.3;
    } else if (field > 0.8) {
      // Edge glow
      const v = (field - 0.8) / 0.4;
      r = bg_r + v * 0.8; g = bg_g + v * 0.2; b2 = bg_b + v * 0.15;
    } else {
      r = bg_r; g = bg_g; b2 = bg_b;
    }
    // Glass container highlight (subtle vertical light)
    const containerX = Math.abs(x / w - 0.5) * 2;
    if (containerX > 0.85) { const edge = (containerX - 0.85) / 0.15; r += edge * 0.05; g += edge * 0.05; b2 += edge * 0.07; }
    const [tr, tg, tb] = acesTonemap(r, g, b2);
    setPixel(fb, w, x, y, tr, tg, tb);
  }
};

// 46: Silk — flowing fabric with iridescent sheen
const shaderSilk: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ux = x / w, uy = y / h;
    // Layered sine folds — each layer is a fold in the fabric
    let fold = 0;
    for (let i = 0; i < 5; i++) {
      const freq = 2 + i * 1.5;
      const phase = t * (0.2 + i * 0.08) + i * 1.7;
      const bi = Math.floor((i / 5) * bands.length);
      const bv = (bands[Math.min(bi, bands.length - 1)] || 0) * 2;
      fold += Math.sin(ux * freq + Math.sin(uy * (freq * 0.7) + phase) * (1.5 + bv)) * (1 / (i + 1));
    }
    fold = fold * 0.5 + 0.5; // normalize to 0-1
    // Iridescent color shift — hue changes with fold angle (like real silk)
    const hue = (fold * 0.4 + ux * 0.1 + t * 0.02) % 1;
    // Highlights on fold peaks
    const foldDeriv = Math.abs(Math.cos(fold * Math.PI * 4));
    const highlight = Math.pow(foldDeriv, 8) * (0.3 + treble * 0.5);
    const lightness = 0.2 + fold * 0.25 + highlight + bass * 0.1 + beat * 0.08;
    const saturation = 0.7 + (1 - highlight) * 0.2;
    const [cr, cg, cb] = hsl(hue, saturation, Math.min(0.85, lightness));
    setPixel(fb, w, x, y, cr, cg, cb);
  }
};

// 47: Rainstorm — rain streaks, distant lightning, rolling clouds
const STORM_STREAKS: { x: number; y: number; speed: number; len: number }[] = [];
const STORM_FLASH = { age: 999, x: 0.5 };
const shaderRainstorm: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  // Storm sky — dark rolling clouds via fbm
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ux = x / w, uy = y / h;
    if (uy < 0.55) {
      // Cloud layer
      const cloud = ffbm2(ux * 3 + t * 0.15, uy * 2 + t * 0.05);
      const cloud2 = fnoise(ux * 5 + t * 0.2, uy * 3 - t * 0.1);
      const v = cloud * 0.6 + cloud2 * 0.4;
      const darkness = 0.15 + v * 0.2 + bass * 0.05;
      setPixel(fb, w, x, y, darkness * 80, darkness * 80, darkness * 110);
    } else {
      // Ground — dark with rain reflection
      const ground = 0.03 + (1 - uy) * 0.02;
      setPixel(fb, w, x, y, ground * 60, ground * 60, ground * 80);
    }
  }
  // Lightning flash on heavy beat
  if (beat > 0.6 && STORM_FLASH.age > 15) { STORM_FLASH.age = 0; STORM_FLASH.x = 0.3 + Math.random() * 0.4; }
  STORM_FLASH.age++;
  if (STORM_FLASH.age < 6) {
    const flash = (1 - STORM_FLASH.age / 6) * 0.4;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dist = Math.abs(x / w - STORM_FLASH.x);
      const f = flash * Math.exp(-dist * 4) * (1 - y / h * 0.5);
      const i = (y * w + x) * 3;
      fb[i] = Math.min(255, fb[i] + f * 255); fb[i + 1] = Math.min(255, fb[i + 1] + f * 240); fb[i + 2] = Math.min(255, fb[i + 2] + f * 255);
    }
    // Bolt — jagged line from flash point
    let bx = STORM_FLASH.x * w;
    for (let by = 0; by < h * 0.5; by++) {
      bx += (Math.random() - 0.5) * 6;
      const bright = (1 - STORM_FLASH.age / 6) * 255;
      setPixel(fb, w, bx | 0, by, bright, bright, bright);
      setPixel(fb, w, (bx - 1) | 0, by, bright * 0.5, bright * 0.5, bright * 0.8);
      setPixel(fb, w, (bx + 1) | 0, by, bright * 0.5, bright * 0.5, bright * 0.8);
    }
  }
  // Rain streaks
  const spawnRate = 8 + Math.floor(mid * 15);
  for (let i = 0; i < spawnRate && STORM_STREAKS.length < 500; i++) {
    STORM_STREAKS.push({ x: Math.random() * w, y: -Math.random() * 5, speed: 2 + Math.random() * 2, len: 3 + Math.floor(Math.random() * 4) });
  }
  for (let i = STORM_STREAKS.length - 1; i >= 0; i--) {
    const s = STORM_STREAKS[i];
    s.y += s.speed; s.x -= s.speed * 0.3; // wind
    if (s.y > h + s.len) { STORM_STREAKS.splice(i, 1); continue; }
    for (let d = 0; d < s.len; d++) {
      const fade = (1 - d / s.len) * 0.5;
      setPixel(fb, w, (s.x + d * 0.3) | 0, (s.y - d) | 0, 140 * fade, 150 * fade, 180 * fade);
    }
  }
};

// 48: Ember — dying fire with floating embers rising into night
const EMBERS: { x: number; y: number; vx: number; vy: number; life: number; bright: number }[] = [];
const shaderEmber: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  // Night sky at top, warm glow at bottom
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const uy = y / h;
    // Bottom glow from fire
    const fireGlow = Math.exp(-(1 - uy) * 3) * (0.3 + bass * 0.4);
    const r = fireGlow * 0.8 + 0.01;
    const g = fireGlow * 0.3;
    const b2 = 0.02 + (1 - uy) * 0.04;
    setPixel(fb, w, x, y, r * 255, g * 255, b2 * 255);
  }
  // Fire at bottom — layered noise
  for (let x = 0; x < w; x++) {
    const ux = x / w;
    const bi = Math.floor(ux * bands.length);
    const bv = (bands[Math.min(bi, bands.length - 1)] || 0) * 3;
    const fireH = (0.08 + bv * 0.12 + bass * 0.06) * h;
    for (let fy = 0; fy < fireH; fy++) {
      const py = h - 1 - fy;
      const frac = fy / fireH;
      const flicker = fnoise(x * 0.1 + t * 3, fy * 0.2 + t * 5);
      const r = (1 - frac * 0.4) * (0.8 + flicker * 0.2);
      const g = (0.6 - frac * 0.5) * (0.7 + flicker * 0.3);
      const b2 = frac < 0.2 ? 0.2 * (1 - frac * 5) : 0;
      setPixel(fb, w, x, py, r * 255, g * 255, b2 * 255);
    }
  }
  // Spawn embers
  const rate = 3 + Math.floor(beat * 15 + bass * 8);
  for (let i = 0; i < rate && EMBERS.length < 200; i++) {
    EMBERS.push({ x: w * (0.2 + Math.random() * 0.6), y: h - 3, vx: (Math.random() - 0.5) * 2, vy: -(1 + Math.random() * 2), life: 1, bright: 0.5 + Math.random() * 0.5 });
  }
  for (let i = EMBERS.length - 1; i >= 0; i--) {
    const e = EMBERS[i];
    e.x += e.vx + Math.sin(t * 2 + i * 0.7) * 0.5; // thermal drift
    e.y += e.vy;
    e.vy -= 0.01; // accelerate upward
    e.life -= 0.008;
    if (e.life <= 0 || e.y < 0) { EMBERS.splice(i, 1); continue; }
    const bright = e.life * e.bright * (0.7 + beat * 0.3);
    // Ember color: white → orange → red → dark
    const cr = bright > 0.5 ? 255 : bright * 2 * 255;
    const cg = bright > 0.6 ? 200 * bright : bright * 0.6 * 255;
    const cb = bright > 0.7 ? 100 * bright : 0;
    setPixel(fb, w, e.x | 0, e.y | 0, cr, cg, cb);
    // Tiny glow
    setPixel(fb, w, (e.x - 1) | 0, e.y | 0, cr * 0.3, cg * 0.3, cb * 0.3);
    setPixel(fb, w, (e.x + 1) | 0, e.y | 0, cr * 0.3, cg * 0.3, cb * 0.3);
  }
};

// 49: Prism — light beam splitting into rainbow, Pink Floyd style
const shaderPrism: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  fb.fill(0); // black void
  const cx = w * 0.38, cy = h * 0.5;
  const prismW = 16, prismH = 20;
  // Incoming white beam (from left)
  const beamY = cy;
  const beamWidth = 1.5 + bass * 0.8;
  for (let x = 0; x < cx - prismW; x++) {
    const bright = 0.5 + treble * 0.3 + beat * 0.2;
    for (let dy = -beamWidth; dy <= beamWidth; dy++) {
      const fade = (1 - Math.abs(dy) / beamWidth) * bright;
      setPixel(fb, w, x, (beamY + dy) | 0, 255 * fade, 255 * fade, 255 * fade);
    }
  }
  // Prism triangle
  for (let py = -prismH; py <= prismH; py++) {
    const rowW = prismW * (1 - Math.abs(py) / prismH);
    for (let px = -rowW; px <= rowW; px++) {
      setPixel(fb, w, (cx + px) | 0, (cy + py) | 0, 20, 25, 40);
    }
    // Prism edges
    setPixel(fb, w, (cx - rowW) | 0, (cy + py) | 0, 60, 70, 90);
    setPixel(fb, w, (cx + rowW) | 0, (cy + py) | 0, 60, 70, 90);
  }
  // Rainbow fan (from right side of prism)
  const nRays = 7;
  const rainbowHues = [0.0, 0.07, 0.12, 0.33, 0.55, 0.7, 0.8]; // ROYGBIV
  const spread = 0.35 + bass * 0.15 + beat * 0.1;
  for (let ri = 0; ri < nRays; ri++) {
    const angle = (ri / (nRays - 1) - 0.5) * spread;
    const [cr, cg, cb] = hsl(rainbowHues[ri], 1, 0.5);
    const bi = Math.floor((ri / nRays) * bands.length);
    const bv = (bands[Math.min(bi, bands.length - 1)] || 0) * 3;
    const rayBright = 0.5 + bv * 0.3 + beat * 0.2;
    for (let d = 0; d < w * 0.55; d++) {
      const px = cx + prismW + d;
      const py = cy + Math.sin(angle) * d * 0.7;
      if (px >= w) break;
      const fade = Math.min(1, d / 15) * rayBright; // fade in from prism
      const thickness = 0.8 + d * 0.005 + bv * 0.5;
      for (let dy = -thickness; dy <= thickness; dy++) {
        const tf = (1 - Math.abs(dy) / thickness) * fade;
        setPixel(fb, w, px | 0, (py + dy) | 0, cr * tf, cg * tf, cb * tf);
      }
    }
  }
};

// 50: Dreamscape — surreal floating islands in a pastel sky
const shaderDreamscape: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  // Pastel gradient sky
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const uy = y / h;
    const skyH = (0.55 + uy * 0.15 + t * 0.005) % 1;
    const [cr, cg, cb] = hsl(skyH, 0.4, 0.7 + (1 - uy) * 0.15);
    setPixel(fb, w, x, y, cr, cg, cb);
  }
  // Soft clouds
  for (let y = 0; y < h * 0.6; y++) for (let x = 0; x < w; x++) {
    const cloud = ffbm2(x / w * 4 + t * 0.08, y / h * 3 + t * 0.03);
    if (cloud > 0.55) {
      const v = (cloud - 0.55) / 0.45;
      const i = (y * w + x) * 3;
      fb[i] = Math.min(255, fb[i] + v * 80); fb[i + 1] = Math.min(255, fb[i + 1] + v * 75); fb[i + 2] = Math.min(255, fb[i + 2] + v * 90);
    }
  }
  // 3 floating islands at different depths
  const islands = [
    { x: 0.25, y: 0.55, w2: 0.2, bob: 0.7 },
    { x: 0.6, y: 0.45, w2: 0.15, bob: 1.1 },
    { x: 0.85, y: 0.6, w2: 0.1, bob: 0.9 },
  ];
  for (const isl of islands) {
    const bi2 = Math.floor(isl.x * bands.length);
    const bv = (bands[Math.min(bi2, bands.length - 1)] || 0) * 2;
    const iy = h * (isl.y + Math.sin(t * 0.3 * isl.bob + isl.x * 5) * 0.03 + bv * 0.02);
    const iw = w * isl.w2;
    // Island top (green)
    for (let dx = -iw; dx <= iw; dx++) {
      const frac = Math.abs(dx) / iw;
      const topY = iy - (1 - frac * frac) * 4;
      const px = w * isl.x + dx | 0;
      for (let dy = 0; dy < 3; dy++) setPixel(fb, w, px, (topY + dy) | 0, 60 + bv * 30, 140 + bv * 40, 50);
      // Underside (brown rock, hanging)
      const hangLen = (1 - frac * frac) * 8 + bv * 2;
      for (let dy = 3; dy < 3 + hangLen; dy++) {
        const rf = dy / (3 + hangLen);
        setPixel(fb, w, px, (topY + dy) | 0, 100 * (1 - rf), 70 * (1 - rf), 40 * (1 - rf));
      }
    }
    // Tiny waterfall from island
    if (bv > 0.3) {
      const fallX = w * isl.x | 0;
      for (let fy = iy + 5 | 0; fy < iy + 5 + bv * 15 | 0; fy++) {
        const shimmer = 0.6 + 0.4 * Math.sin(fy * 0.5 + t * 8);
        setPixel(fb, w, fallX, fy, 150 * shimmer, 200 * shimmer, 255 * shimmer);
      }
    }
  }
};

// 51: Neon City — cyberpunk cityscape with reflections
const shaderNeonCity: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const horizonY = Math.floor(h * 0.55);
  // Dark purple sky
  for (let y = 0; y < horizonY; y++) for (let x = 0; x < w; x++) {
    const uy = y / horizonY;
    setPixel(fb, w, x, y, 10 + uy * 15, 5 + uy * 5, 20 + uy * 25);
  }
  // Buildings — procedural skyline
  for (let bx = 0; bx < w; bx += 4) {
    const bIdx = Math.floor(bx / 4);
    const buildingH = Math.floor(fhash(bIdx * 7.7) * h * 0.35 + h * 0.1);
    const buildingW = 3 + Math.floor(fhash(bIdx * 13.3) * 3);
    const topY = horizonY - buildingH;
    const bi = Math.floor((bx / w) * bands.length);
    const bv = (bands[Math.min(bi, bands.length - 1)] || 0) * 3;
    // Building body
    for (let y = topY; y < horizonY; y++) for (let dx = 0; dx < buildingW && bx + dx < w; dx++) {
      setPixel(fb, w, bx + dx, y, 15, 12, 25);
    }
    // Neon accents on buildings — audio reactive
    const neonHue = fhash(bIdx * 31.1);
    const [nr, ng, nb] = hsl(neonHue, 1, 0.5);
    const glow = 0.3 + bv * 0.5 + beat * 0.3;
    // Window row
    for (let wy = topY + 2; wy < horizonY - 1; wy += 3) {
      if (fhash(bIdx * 17 + wy * 3.3) > 0.5) {
        for (let dx = 1; dx < buildingW - 1 && bx + dx < w; dx++)
          setPixel(fb, w, bx + dx, wy, nr * glow * 0.3, ng * glow * 0.3, nb * glow * 0.3);
      }
    }
    // Roof neon strip
    for (let dx = 0; dx < buildingW && bx + dx < w; dx++)
      setPixel(fb, w, bx + dx, topY, nr * glow, ng * glow, nb * glow);
  }
  // Wet street with reflections
  for (let y = horizonY; y < h; y++) {
    const reflY = horizonY - (y - horizonY); // mirror Y
    const distort = Math.sin(y * 0.5 + t * 3) * 1.5;
    const reflFade = 0.4 * Math.exp(-(y - horizonY) * 0.08);
    for (let x = 0; x < w; x++) {
      const rx = Math.min(w - 1, Math.max(0, x + distort | 0));
      if (reflY >= 0 && reflY < horizonY) {
        const si = (reflY * w + rx) * 3, di = (y * w + x) * 3;
        if (si + 2 < fb.length && di + 2 < fb.length) {
          fb[di] = fb[si] * reflFade + 5; fb[di + 1] = fb[si + 1] * reflFade + 3; fb[di + 2] = fb[si + 2] * reflFade + 10;
        }
      } else {
        setPixel(fb, w, x, y, 5, 3, 10);
      }
    }
  }
  // Horizontal neon reflection lines on street
  for (let stripe = 0; stripe < 5; stripe++) {
    const sy = horizonY + 3 + stripe * 4;
    const bi = Math.floor((stripe / 5) * bands.length);
    const bv = (bands[Math.min(bi, bands.length - 1)] || 0) * 4;
    const [sr, sg, sb] = hsl((stripe * 0.2 + t * 0.05) % 1, 1, 0.3 + bv * 0.2);
    if (sy < h) for (let x = 0; x < w; x++) setPixel(fb, w, x, sy, sr, sg, sb);
  }
};

// 52: Wormhole — spiraling tunnel with depth and light at the end
const shaderWormhole: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x - cx) / cx, dy = (y - cy) / cy * 2;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);
    if (dist < 0.01) { setPixel(fb, w, x, y, 255, 240, 200); continue; } // center light
    // Tunnel depth — 1/r mapping
    const depth = 1 / (dist + 0.1);
    // Spiral twist — increases with depth
    const twist = angle + depth * (2 + bass * 3) + t * (0.8 + mid * 0.5);
    // Ring segments — create the tube wall pattern
    const ringPattern = Math.sin(depth * 3 - t * 2) * 0.5 + 0.5;
    const spiralPattern = Math.sin(twist * 6) * 0.5 + 0.5;
    const combined = ringPattern * 0.6 + spiralPattern * 0.4;
    // Audio modulation along the tube
    const bi = Math.floor(((angle / Math.PI + 1) * 0.5) * bands.length) % bands.length;
    const bv = (bands[Math.max(0, bi)] || 0) * 3;
    // Color: deep purple walls → bright light at center
    const depthFade = Math.exp(-dist * 1.5);
    const wallBright = combined * (0.3 + bv * 0.4) * (1 - depthFade * 0.5);
    const centerLight = depthFade * depthFade * (0.8 + beat * 0.5);
    let r = wallBright * 0.4 + centerLight * 1.0;
    let g = wallBright * 0.2 + centerLight * 0.9;
    let b2 = wallBright * 0.8 + centerLight * 0.7;
    // Edge energy (event horizon ring)
    const ringDist = Math.abs(dist - 0.3);
    if (ringDist < 0.05) {
      const ringGlow = (1 - ringDist / 0.05) * (0.5 + treble * 0.5);
      r += ringGlow * 0.3; g += ringGlow * 0.5; b2 += ringGlow * 0.8;
    }
    r *= 0.7 + beat * 0.3;
    const [tr, tg, tb] = acesTonemap(r, g, b2);
    setPixel(fb, w, x, y, tr, tg, tb);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ✦ ART PIECES III — Shaders 53-60
// ═══════════════════════════════════════════════════════════════════════════

// 53. Mandelbrot zoom — fractal zoom with audio-reactive palette
const shaderMandelbrot: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const zoom = 0.5 + t * 0.3 + bass * 2;
  const cx = -0.745 + Math.sin(t * 0.1) * 0.01;
  const cy = 0.186 + Math.cos(t * 0.13) * 0.01;
  const maxIter = 40 + Math.floor(mid * 30);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let zr = (x / w - 0.5) / zoom + cx;
    let zi = (y / h - 0.5) / zoom + cy;
    let cr = zr, ci = zi, iter = 0;
    while (zr * zr + zi * zi < 4 && iter < maxIter) {
      const tmp = zr * zr - zi * zi + cr;
      zi = 2 * zr * zi + ci; zr = tmp; iter++;
    }
    if (iter >= maxIter) { setPixel(fb, w, x, y, 0, 0, 0); continue; }
    const f = iter / maxIter + treble * 0.2;
    const hue = f * 360 + t * 30 + bass * 60;
    const sat = 0.7 + beat * 0.3;
    const val = 0.5 + f * 0.5;
    const [r, g, b2] = hsl(hue / 360, sat, val);
    setPixel(fb, w, x, y, r, g, b2);
  }
};

// 54. Snowfall — drifting snowflakes with wind and accumulation
const SNOW_FLAKES: { x: number; y: number; vx: number; vy: number; size: number }[] = [];
const shaderSnowfall: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  // Init flakes
  while (SNOW_FLAKES.length < 120) {
    SNOW_FLAKES.push({ x: Math.random() * w, y: Math.random() * -h, vx: 0, vy: 0.5 + Math.random() * 1.5, size: 0.5 + Math.random() * 1.5 });
  }
  // Dark blue sky gradient
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gy = y / h;
    setPixel(fb, w, x, y, gy * 0.02, gy * 0.03 + 0.02, 0.08 + gy * 0.06);
  }
  // Ground with snow accumulation
  const groundY = Math.floor(h * 0.85);
  for (let y = groundY; y < h; y++) for (let x = 0; x < w; x++) {
    const snowDepth = (1 + Math.sin(x * 0.3 + t * 0.2)) * 0.15 + 0.7;
    setPixel(fb, w, x, y, snowDepth, snowDepth, snowDepth + 0.05);
  }
  // Wind from bass
  const wind = Math.sin(t * 0.5) * 2 + bass * 3;
  // Update + draw flakes
  for (const f of SNOW_FLAKES) {
    f.x += wind * 0.3 + Math.sin(t + f.y * 0.1) * 0.5 + f.vx;
    f.y += f.vy * (0.8 + treble * 0.4);
    if (f.y > groundY) { f.y = -2; f.x = Math.random() * w; }
    if (f.x < 0) f.x += w; if (f.x >= w) f.x -= w;
    const bri = 0.7 + f.size * 0.2 + beat * 0.2;
    const ix = Math.floor(f.x), iy = Math.floor(f.y);
    if (iy >= 0 && iy < h && ix >= 0 && ix < w) {
      setPixel(fb, w, ix, iy, bri, bri, bri + 0.05);
      if (f.size > 1 && ix + 1 < w) setPixel(fb, w, ix + 1, iy, bri * 0.6, bri * 0.6, bri * 0.65);
    }
  }
  // Moon
  const mx = Math.floor(w * 0.8), my = Math.floor(h * 0.15);
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    if (dx * dx + dy * dy <= 9) {
      const px = mx + dx, py = my + dy;
      if (px >= 0 && px < w && py >= 0 && py < h) {
        const glow = 1 - Math.sqrt(dx * dx + dy * dy) / 3;
        setPixel(fb, w, px, py, 0.9 + glow * 0.1, 0.9 + glow * 0.1, 0.8 + glow * 0.2);
      }
    }
  }
};

// 55. Kaleidoscope II — mirrored rotational symmetry with audio colors + fbm
const shaderKaleidoscope2: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const segments = 6 + Math.floor(beat * 2);
  const angleStep = (Math.PI * 2) / segments;
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x - cx) / cx, dy = (y - cy) / cy * (w / h);
    let angle = Math.atan2(dy, dx) + t * 0.3;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Fold into one segment
    angle = ((angle % angleStep) + angleStep) % angleStep;
    if (angle > angleStep / 2) angle = angleStep - angle;
    // Pattern in folded space
    const px = dist * Math.cos(angle), py = dist * Math.sin(angle);
    const n1 = ffbm(px * 3 + t * 0.2, py * 3, 3);
    const n2 = ffbm(px * 2 - t * 0.3, py * 2 + t * 0.1, 2);
    const hue = n1 * 0.5 + t * 0.05 + bass * 0.2;
    const sat = 0.6 + n2 * 0.3 + mid * 0.2;
    const val = 0.3 + n1 * 0.4 + treble * 0.3 + beat * 0.2;
    const bandIdx = Math.floor(dist * bands.length) % bands.length;
    const bandAmp = bands[Math.abs(bandIdx)] || 0;
    const [r, g, b2] = hsl(hue, sat, val + bandAmp * 0.3);
    const [tr, tg, tb] = acesTonemap(r, g, b2);
    setPixel(fb, w, x, y, tr, tg, tb);
  }
};

// 56. Cyberpunk Rain — vertical rain with neon reflections (Blade Runner vibes)
const CYBER_DROPS: { x: number; y: number; speed: number; len: number; hue: number }[] = [];
const shaderCyberRain: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  // Init drops
  while (CYBER_DROPS.length < 80) {
    CYBER_DROPS.push({ x: Math.floor(Math.random() * w), y: Math.random() * -h, speed: 1 + Math.random() * 2, len: 3 + Math.floor(Math.random() * 8), hue: Math.random() });
  }
  // Dark backdrop with slight purple
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    setPixel(fb, w, x, y, 0.01, 0.005, 0.02);
  }
  // Horizontal neon lines (buildings far away)
  for (let i = 0; i < 5; i++) {
    const ny = Math.floor(h * 0.3 + i * h * 0.12);
    const hue2 = (i * 0.2 + t * 0.02) % 1;
    const [lr, lg, lb] = hsl(hue2, 0.8, 0.15 + bass * 0.1);
    for (let x = 0; x < w; x++) {
      if (ny >= 0 && ny < h) setPixel(fb, w, x, ny, lr, lg, lb);
    }
  }
  // Update + draw drops
  for (const d of CYBER_DROPS) {
    d.y += d.speed * (1 + treble * 0.5);
    if (d.y > h + d.len) { d.y = -d.len; d.x = Math.floor(Math.random() * w); d.hue = Math.random(); }
    const [cr, cg, cb] = hsl(d.hue, 0.9, 0.7);
    for (let i = 0; i < d.len; i++) {
      const py = Math.floor(d.y - i);
      if (py >= 0 && py < h && d.x >= 0 && d.x < w) {
        const fade = 1 - i / d.len;
        setPixel(fb, w, d.x, py, cr * fade, cg * fade, cb * fade);
      }
    }
  }
  // Beat flash
  if (beat > 0.5) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      fb[idx] = Math.min(1, fb[idx] + 0.05);
      fb[idx + 1] = Math.min(1, fb[idx + 1] + 0.02);
      fb[idx + 2] = Math.min(1, fb[idx + 2] + 0.08);
    }
  }
};

// 57. DNA Helix — double helix rotating in 3D
const shaderDNAHelix: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  // Dark background
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    setPixel(fb, w, x, y, 0.01, 0.01, 0.03);
  }
  const cx = w / 2;
  const helixR = w * 0.25 + bass * w * 0.08;
  const twist = t * 1.5 + mid * 0.5;
  // Draw two helical strands
  for (let y = 0; y < h; y++) {
    const phase = y / h * Math.PI * 6 + twist;
    const x1 = cx + Math.cos(phase) * helixR;
    const x2 = cx + Math.cos(phase + Math.PI) * helixR;
    const z1 = Math.sin(phase), z2 = Math.sin(phase + Math.PI);
    const bri1 = 0.4 + z1 * 0.3 + treble * 0.2;
    const bri2 = 0.4 + z2 * 0.3 + treble * 0.2;
    // Strand 1 (blue)
    const ix1 = Math.round(x1);
    if (ix1 >= 0 && ix1 < w) setPixel(fb, w, ix1, y, bri1 * 0.2, bri1 * 0.5, bri1);
    if (ix1 + 1 >= 0 && ix1 + 1 < w) setPixel(fb, w, ix1 + 1, y, bri1 * 0.1, bri1 * 0.3, bri1 * 0.7);
    // Strand 2 (red)
    const ix2 = Math.round(x2);
    if (ix2 >= 0 && ix2 < w) setPixel(fb, w, ix2, y, bri2, bri2 * 0.3, bri2 * 0.2);
    if (ix2 + 1 >= 0 && ix2 + 1 < w) setPixel(fb, w, ix2 + 1, y, bri2 * 0.7, bri2 * 0.15, bri2 * 0.1);
    // Rungs (every few rows, connecting the two strands)
    if (y % 4 === 0) {
      const lx = Math.min(ix1, ix2), rx = Math.max(ix1, ix2);
      const bandIdx = Math.floor((y / h) * bands.length);
      const amp = bands[bandIdx] || 0;
      for (let x = lx + 1; x < rx; x++) {
        if (x >= 0 && x < w) {
          const frac = (x - lx) / (rx - lx);
          const [rr, rg, rb] = hsl(frac * 0.3 + t * 0.05, 0.6, 0.2 + amp * 0.4 + beat * 0.15);
          setPixel(fb, w, x, y, rr, rg, rb);
        }
      }
    }
  }
};

// 58. Lissajous Web — 3D lissajous curves forming a web
const shaderLissajousWeb: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(fb, w, x, y, 0, 0, 0);
  const cx = w / 2, cy = h / 2;
  const curves = 5 + Math.floor(bass * 3);
  for (let c = 0; c < curves; c++) {
    const a = 2 + c, b = 3 + c;
    const delta = t * 0.5 + c * 0.7;
    const hue = (c / curves + t * 0.03) % 1;
    const [cr, cg, cb] = hsl(hue, 0.8, 0.5 + treble * 0.3);
    const steps = 300 + Math.floor(mid * 200);
    for (let i = 0; i < steps; i++) {
      const p = (i / steps) * Math.PI * 2;
      const lx = Math.cos(a * p + delta) * cx * 0.8 * (0.7 + bands[c % bands.length] * 0.5);
      const ly = Math.sin(b * p + delta * 0.7) * cy * 0.8;
      const ix = Math.floor(cx + lx), iy = Math.floor(cy + ly);
      if (ix >= 0 && ix < w && iy >= 0 && iy < h) {
        const idx = (iy * w + ix) * 4;
        fb[idx] = Math.min(1, fb[idx] + cr * 0.15);
        fb[idx+1] = Math.min(1, fb[idx+1] + cg * 0.15);
        fb[idx+2] = Math.min(1, fb[idx+2] + cb * 0.15);
      }
    }
  }
  // Bloom pass — beat brightens
  if (beat > 0.3) {
    for (let i = 0; i < fb.length; i++) fb[i] = Math.min(1, fb[i] * (1 + beat * 0.3));
  }
};

// 59. Terrain — scrolling 3D terrain (fake raycasting, top-down perspective)
const shaderTerrainFly: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  for (let y = 0; y < h; y++) {
    const depth = (y + 1) / h; // 0 at top (far), 1 at bottom (near)
    const scale = 1 / (depth + 0.01);
    const scrollZ = t * 2 + bass * 3;
    for (let x = 0; x < w; x++) {
      const worldX = (x / w - 0.5) * scale * 4;
      const worldZ = scrollZ + scale * 2;
      const n = ffbm2(worldX * 0.5, worldZ * 0.5, 4);
      const height = n * 0.8 + mid * 0.2;
      // Color by height: water → sand → grass → rock → snow
      let r, g, b2;
      if (height < 0.3) { r = 0.05; g = 0.15 + height; b2 = 0.4 + height * 0.5; } // water
      else if (height < 0.4) { r = 0.6; g = 0.5; b2 = 0.3; } // sand
      else if (height < 0.65) { r = 0.1; g = 0.35 + (height - 0.4) * 1.5; b2 = 0.08; } // grass
      else if (height < 0.8) { r = 0.3; g = 0.25; b2 = 0.2; } // rock
      else { r = 0.8; g = 0.85; b2 = 0.9; } // snow
      // Distance fog
      const fog = 1 - depth * 0.7;
      r *= fog; g *= fog; b2 *= fog;
      // Treble shimmer on water
      if (height < 0.3) { r += treble * 0.1 * (1 - depth); b2 += treble * 0.15 * (1 - depth); }
      // Beat flash
      r += beat * 0.05; g += beat * 0.05; b2 += beat * 0.05;
      setPixel(fb, w, x, y, Math.min(1, r), Math.min(1, g), Math.min(1, b2));
    }
  }
  // Sky (top rows)
  const skyH = Math.floor(h * 0.15);
  for (let y = 0; y < skyH; y++) for (let x = 0; x < w; x++) {
    const gy = y / skyH;
    setPixel(fb, w, x, y, 0.1 + gy * 0.1, 0.15 + gy * 0.15, 0.4 + gy * 0.2);
  }
};

// 60. Supernova — expanding shockwave with particle debris
const NOVA_PARTICLES: { x: number; y: number; vx: number; vy: number; life: number; hue: number }[] = [];
let novaTimer = 0;
const shaderSupernovaBurst: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const cx = w / 2, cy = h / 2;
  // Background — deep space
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const star = fhash(x * 347 + y * 991) > 0.97 ? 0.3 + fhash(x * 113 + y * 773) * 0.5 : 0;
    setPixel(fb, w, x, y, star * 0.8, star * 0.85, star);
  }
  // Beat triggers nova burst
  novaTimer += 1;
  if (beat > 0.6 || novaTimer > 60) {
    novaTimer = 0;
    for (let i = 0; i < 30; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.5 + Math.random() * 3;
      NOVA_PARTICLES.push({ x: cx, y: cy, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 40 + Math.random() * 40, hue: Math.random() });
    }
  }
  // Shockwave ring
  const ringR = (novaTimer / 60) * Math.max(w, h) * 0.6;
  const ringW2 = 2 + bass * 3;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - cx, dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (Math.abs(dist - ringR) < ringW2) {
      const bri = (1 - Math.abs(dist - ringR) / ringW2) * 0.6;
      const idx = (y * w + x) * 4;
      fb[idx] = Math.min(1, fb[idx] + bri); fb[idx+1] = Math.min(1, fb[idx+1] + bri * 0.7); fb[idx+2] = Math.min(1, fb[idx+2] + bri * 0.3);
    }
  }
  // Update + draw particles
  for (let i = NOVA_PARTICLES.length - 1; i >= 0; i--) {
    const p = NOVA_PARTICLES[i];
    p.x += p.vx; p.y += p.vy; p.life--;
    p.vx *= 0.98; p.vy *= 0.98;
    if (p.life <= 0) { NOVA_PARTICLES.splice(i, 1); continue; }
    const ix = Math.floor(p.x), iy = Math.floor(p.y);
    if (ix >= 0 && ix < w && iy >= 0 && iy < h) {
      const bri = p.life / 80;
      const [pr, pg, pb] = hsl(p.hue, 0.9, bri * 0.8);
      const idx = (iy * w + ix) * 4;
      fb[idx] = Math.min(1, fb[idx] + pr); fb[idx+1] = Math.min(1, fb[idx+1] + pg); fb[idx+2] = Math.min(1, fb[idx+2] + pb);
    }
  }
  // Central glow
  const glowR = 4 + bass * 3;
  for (let dy = -Math.ceil(glowR); dy <= Math.ceil(glowR); dy++) for (let dx = -Math.ceil(glowR); dx <= Math.ceil(glowR); dx++) {
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < glowR) {
      const px = Math.floor(cx) + dx, py = Math.floor(cy) + dy;
      if (px >= 0 && px < w && py >= 0 && py < h) {
        const bri = (1 - dist / glowR) * (0.5 + treble * 0.5);
        const idx = (py * w + px) * 4;
        fb[idx] = Math.min(1, fb[idx] + bri); fb[idx+1] = Math.min(1, fb[idx+1] + bri * 0.8); fb[idx+2] = Math.min(1, fb[idx+2] + bri * 0.4);
      }
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ✦ ART PIECES IV — Shaders 61-72 (push to 72 halfblock → need 100 total)
// ═══════════════════════════════════════════════════════════════════════════

// 61. Campfire — warm flames with log silhouette and rising sparks
const shaderCampfire: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gy = y / h;
    // Dark sky gradient
    setPixel(fb, w, x, y, 0.02 + gy * 0.01, 0.01, 0.03 - gy * 0.02);
  }
  // Ground
  const gnd = Math.floor(h * 0.75);
  for (let y = gnd; y < h; y++) for (let x = 0; x < w; x++) setPixel(fb, w, x, y, 0.06, 0.04, 0.02);
  // Fire
  const cx = w / 2;
  for (let y = gnd - 1; y > gnd - Math.floor(h * 0.4); y--) for (let x = Math.floor(cx - 8); x < Math.floor(cx + 8); x++) {
    if (x < 0 || x >= w || y < 0) continue;
    const dx = (x - cx) / 8, dy = (gnd - y) / (h * 0.4);
    const n = ffbm(dx * 3 + t * 0.5, dy * 4 - t * 3 + bass, 3);
    const intensity = Math.max(0, (1 - dy) * (1 - Math.abs(dx)) * (0.5 + n * 0.5 + bass * 0.3));
    if (intensity > 0.1) {
      const r2 = intensity * (1 + beat * 0.3), g = intensity * 0.6 * (1 - dy * 0.5), b2 = intensity * 0.1 * (1 - dy);
      setPixel(fb, w, x, y, Math.min(1, r2), Math.min(1, g), Math.min(1, b2));
    }
  }
  // Sparks
  for (let i = 0; i < 15; i++) {
    const sx = cx + Math.sin(t * 2 + i * 7) * (3 + bass * 4);
    const sy = gnd - 5 - ((t * 30 + i * 17) % (h * 0.5));
    const ix = Math.floor(sx), iy = Math.floor(sy);
    if (ix >= 0 && ix < w && iy >= 0 && iy < h) setPixel(fb, w, ix, iy, 1, 0.8 + treble * 0.2, 0.3);
  }
};

// 62. Disco Ball — rotating mirrored sphere with light rays
const shaderDiscoBall: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(fb, w, x, y, 0.02, 0.02, 0.04);
  const cx = w / 2, cy = h * 0.35, R = Math.min(w, h) * 0.2;
  // Ball facets
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - cx, dy = (y - cy) * 1.5;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < R) {
      const u = Math.atan2(dy, dx) + t * 0.8, v = d / R * Math.PI;
      const facet = (Math.floor(u * 5) + Math.floor(v * 4)) % 2;
      const z = Math.sqrt(1 - (d / R) * (d / R));
      const bri = z * (facet ? 0.8 : 0.3) + beat * 0.2;
      setPixel(fb, w, x, y, bri, bri, bri * 1.1);
    }
  }
  // Light rays
  const numRays = 8 + Math.floor(bass * 4);
  for (let i = 0; i < numRays; i++) {
    const angle = t * 0.5 + (i / numRays) * Math.PI * 2;
    const [cr, cg, cb] = hsl(i / numRays + t * 0.1, 0.9, 0.5);
    for (let d2 = R; d2 < Math.max(w, h); d2 += 1) {
      const rx = Math.floor(cx + Math.cos(angle) * d2), ry = Math.floor(cy / 1.5 + Math.sin(angle) * d2 / 1.5);
      if (rx >= 0 && rx < w && ry >= 0 && ry < h) {
        const fade = 0.15 / (1 + (d2 - R) * 0.02);
        const idx = (ry * w + rx) * 4;
        fb[idx] = Math.min(1, fb[idx] + cr * fade); fb[idx+1] = Math.min(1, fb[idx+1] + cg * fade); fb[idx+2] = Math.min(1, fb[idx+2] + cb * fade);
      }
    }
  }
};

// 63. Circuit — PCB traces with pulsing signals
const shaderCircuit: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // PCB green background
    const n = fhash(x * 31 + y * 17);
    setPixel(fb, w, x, y, 0.0, 0.04 + n * 0.01, 0.02);
  }
  // Grid traces
  const spacing = 4;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gx = x % spacing === 0, gy = y % spacing === 0;
    if (gx || gy) {
      const hash = fhash(Math.floor(x / spacing) * 97 + Math.floor(y / spacing) * 31);
      if (hash > 0.5) {
        const signal = Math.sin(t * 4 + x * 0.3 + y * 0.3) * 0.5 + 0.5;
        const bi = Math.floor((gx ? y : x) / (gx ? h : w) * bands.length);
        const amp = bands[Math.min(bi, bands.length - 1)] || 0;
        const bri = 0.15 + signal * amp * 0.6 + beat * 0.1;
        setPixel(fb, w, x, y, bri * 0.3, bri, bri * 0.4);
      }
    }
  }
  // Nodes at intersections
  for (let ny = spacing; ny < h; ny += spacing) for (let nx = spacing; nx < w; nx += spacing) {
    if (fhash(nx * 13 + ny * 7) > 0.6) {
      const bi2 = Math.floor(nx / w * bands.length);
      const amp2 = bands[Math.min(bi2, bands.length - 1)] || 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const px = nx + dx, py = ny + dy;
        if (px >= 0 && px < w && py >= 0 && py < h) setPixel(fb, w, px, py, 0.2 + amp2 * 0.5, 0.8 + amp2 * 0.2, 0.3);
      }
    }
  }
};

// 64. Pendulum Wave — row of pendulums at slightly different frequencies
const shaderPendulumWave: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(fb, w, x, y, 0.02, 0.02, 0.03);
  const n = 15;
  for (let i = 0; i < n; i++) {
    const freq = 0.5 + i * 0.04;
    const bi = Math.floor(i / n * bands.length);
    const amp = 0.3 + (bands[Math.min(bi, bands.length - 1)] || 0) * 0.5;
    const angle = Math.sin(t * freq + bass * 0.5) * amp;
    const anchorX = Math.floor(w * 0.1 + (i / (n - 1)) * w * 0.8);
    const len = h * 0.7;
    const bx = anchorX + Math.sin(angle) * len * 0.3;
    const by = Math.cos(angle) * len * 0.8;
    const [cr, cg, cb] = hsl(i / n + t * 0.02, 0.8, 0.6 + beat * 0.2);
    // String
    for (let j = 0; j <= 20; j++) {
      const f = j / 20;
      const px = Math.floor(anchorX + (bx - anchorX) * f), py = Math.floor(f * by);
      if (px >= 0 && px < w && py >= 0 && py < h) setPixel(fb, w, px, py, cr * 0.3, cg * 0.3, cb * 0.3);
    }
    // Bob
    const ix = Math.floor(bx), iy = Math.floor(by);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -1; dx <= 1; dx++) {
      const px2 = ix + dx, py2 = iy + dy;
      if (px2 >= 0 && px2 < w && py2 >= 0 && py2 < h) setPixel(fb, w, px2, py2, cr, cg, cb);
    }
  }
};

// 65. Sunset Beach — gradient sky, sun, water reflections
const shaderSunsetBeach: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const horizon = Math.floor(h * 0.55);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (y < horizon) {
      // Sky
      const gy = y / horizon;
      const r2 = 0.9 - gy * 0.5, g = 0.3 + gy * 0.2, b2 = 0.2 + gy * 0.5;
      setPixel(fb, w, x, y, r2 + beat * 0.05, g, b2);
    } else {
      // Water
      const gy2 = (y - horizon) / (h - horizon);
      const wave = Math.sin(x * 0.2 + t * 2 + gy2 * 10) * 0.03 * (1 + bass * 0.5);
      const r2 = 0.1 + wave, g = 0.15 + gy2 * 0.1 + wave, b2 = 0.3 + gy2 * 0.15 + treble * 0.05;
      setPixel(fb, w, x, y, r2, g, b2);
    }
  }
  // Sun
  const sx = w / 2, sy = horizon - h * 0.15;
  const sunR = Math.min(w, h) * 0.08 + bass * 3;
  for (let dy = -Math.ceil(sunR) - 2; dy <= Math.ceil(sunR) + 2; dy++) for (let dx = -Math.ceil(sunR) - 2; dx <= Math.ceil(sunR) + 2; dx++) {
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < sunR + 2) {
      const px = Math.floor(sx) + dx, py = Math.floor(sy) + dy;
      if (px >= 0 && px < w && py >= 0 && py < h) {
        const bri = d < sunR ? 1 : Math.max(0, 1 - (d - sunR) / 2);
        setPixel(fb, w, px, py, bri, bri * 0.7, bri * 0.2);
      }
    }
  }
  // Sun reflection on water
  for (let y = horizon + 1; y < h; y++) {
    const refW = 2 + (y - horizon) * 0.3 + Math.sin(t * 3 + y * 0.5) * 2;
    for (let dx = -Math.ceil(refW); dx <= Math.ceil(refW); dx++) {
      const px = Math.floor(sx) + dx;
      if (px >= 0 && px < w) {
        const bri = 0.4 * (1 - Math.abs(dx) / refW) / (1 + (y - horizon) * 0.05);
        const idx = (y * w + px) * 4;
        fb[idx] = Math.min(1, fb[idx] + bri); fb[idx+1] = Math.min(1, fb[idx+1] + bri * 0.6); fb[idx+2] = Math.min(1, fb[idx+2] + bri * 0.15);
      }
    }
  }
};

// 66. Moth — moth circling a light with wing flutter
const shaderMoth: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - cx, dy = y - cy, d = Math.sqrt(dx * dx + dy * dy);
    const glow = 0.4 / (1 + d * 0.05);
    setPixel(fb, w, x, y, glow * 0.9, glow * 0.8, glow * 0.5);
  }
  // Moth orbit
  const orbitR = 8 + bass * 5;
  const angle = t * 2 + mid;
  const mx = cx + Math.cos(angle) * orbitR, my = cy + Math.sin(angle) * orbitR * 0.6;
  // Wings
  const wingFlap = Math.sin(t * 15) * 0.5 + 0.5;
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    const wingAngle = angle + Math.PI / 2 + side * (0.5 + wingFlap * 0.8);
    for (let d2 = 0; d2 < 5; d2++) {
      const wx = Math.floor(mx + Math.cos(wingAngle) * d2), wy = Math.floor(my + Math.sin(wingAngle) * d2 * 0.6);
      if (wx >= 0 && wx < w && wy >= 0 && wy < h) {
        const bri = 0.5 - d2 * 0.08 + treble * 0.2;
        setPixel(fb, w, wx, wy, bri * 0.6, bri * 0.4, bri * 0.2);
      }
    }
  }
  // Body
  const bx = Math.floor(mx), by = Math.floor(my);
  if (bx >= 0 && bx < w && by >= 0 && by < h) setPixel(fb, w, bx, by, 0.5, 0.35, 0.15);
};

// 67. Binary Rain — 0s and 1s falling like Matrix but pure binary, hacker aesthetic
const BINARY_COLS: { y: number; speed: number; len: number }[] = [];
const shaderBinaryRain: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  while (BINARY_COLS.length < 40) BINARY_COLS.push({ y: Math.random() * -h, speed: 0.5 + Math.random() * 2, len: 5 + Math.floor(Math.random() * 15) });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(fb, w, x, y, 0, 0.005, 0);
  for (const col of BINARY_COLS) {
    col.y += col.speed * (1 + bass * 0.5);
    if (col.y > h + col.len) { col.y = -col.len; }
    const cx2 = Math.floor(fhash(BINARY_COLS.indexOf(col) * 97) * w);
    for (let i = 0; i < col.len; i++) {
      const py = Math.floor(col.y - i);
      if (py >= 0 && py < h && cx2 >= 0 && cx2 < w) {
        const fade = 1 - i / col.len;
        const bri = fade * (0.4 + treble * 0.4);
        setPixel(fb, w, cx2, py, bri * 0.1, bri, bri * 0.15);
      }
    }
  }
};

// 68. Eclipse — moon crossing sun with corona
const shaderEclipse: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const cx = w / 2, cy = h / 2;
  const sunR = Math.min(w, h) * 0.18;
  const moonR = sunR * 1.02;
  const moonX = cx + Math.sin(t * 0.3) * sunR * 0.8 * (1 + bass * 0.2);
  const moonY = cy + Math.cos(t * 0.2) * sunR * 0.3;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dSun = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
    const dMoon = Math.sqrt((x - moonX) * (x - moonX) + (y - moonY) * (y - moonY));
    let r = 0, g = 0, b2 = 0;
    // Corona glow
    if (dSun < sunR * 3) {
      const corona = Math.max(0, 1 - dSun / (sunR * 3)) * 0.3;
      r += corona * 1.2; g += corona * 0.8; b2 += corona * 0.3;
    }
    // Sun surface
    if (dSun < sunR) { const s2 = 1 - dSun / sunR; r += s2; g += s2 * 0.8; b2 += s2 * 0.2; }
    // Moon blocks sun
    if (dMoon < moonR) { r *= 0.05; g *= 0.05; b2 *= 0.05; }
    // Corona visible around moon edge during eclipse
    if (dMoon >= moonR - 1 && dMoon < moonR + 3 && dSun < sunR + 5) {
      const edge = (1 - (dMoon - moonR + 1) / 4) * (0.5 + treble * 0.5);
      r += edge * 1.2; g += edge * 0.9; b2 += edge * 0.5;
    }
    r += beat * 0.02;
    setPixel(fb, w, x, y, Math.min(1, r), Math.min(1, g), Math.min(1, b2));
  }
};

// 69. Aquarium — fish, bubbles, seaweed
const FISH: { x: number; y: number; speed: number; size: number; hue: number }[] = [];
const BUBBLES: { x: number; y: number; speed: number }[] = [];
const shaderAquarium: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  while (FISH.length < 8) FISH.push({ x: Math.random() * w, y: h * 0.2 + Math.random() * h * 0.5, speed: 0.3 + Math.random() * 0.8, size: 2 + Math.random() * 3, hue: Math.random() });
  while (BUBBLES.length < 12) BUBBLES.push({ x: Math.random() * w, y: h + Math.random() * h, speed: 0.3 + Math.random() * 0.5 });
  // Water gradient
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gy = y / h;
    setPixel(fb, w, x, y, 0.02, 0.05 + gy * 0.08, 0.15 + gy * 0.1);
  }
  // Seaweed
  for (let s = 0; s < 6; s++) {
    const sx = Math.floor(w * 0.1 + s * w * 0.15);
    for (let y = h - 1; y > h * 0.5; y--) {
      const sway = Math.sin(t * 1.5 + s + y * 0.1) * 2 * (1 + bass * 0.3);
      const px = Math.floor(sx + sway);
      if (px >= 0 && px < w) setPixel(fb, w, px, y, 0.05, 0.25 + (h - y) / h * 0.2, 0.08);
    }
  }
  // Fish
  for (const f of FISH) {
    f.x += f.speed; if (f.x > w + 5) f.x = -5;
    const wobble = Math.sin(t * 3 + f.y) * 0.5;
    const fy = f.y + wobble;
    const [cr, cg, cb] = hsl(f.hue, 0.8, 0.5 + mid * 0.2);
    for (let dx = -Math.ceil(f.size); dx <= Math.ceil(f.size); dx++) {
      const px = Math.floor(f.x + dx), py = Math.floor(fy);
      if (px >= 0 && px < w && py >= 0 && py < h) setPixel(fb, w, px, py, cr, cg, cb);
    }
    // Tail
    const tx = Math.floor(f.x - f.size - 1), ty = Math.floor(fy);
    if (tx >= 0 && tx < w && ty >= 0 && ty < h) setPixel(fb, w, tx, ty, cr * 0.5, cg * 0.5, cb * 0.5);
  }
  // Bubbles
  for (const b of BUBBLES) {
    b.y -= b.speed * (1 + treble * 0.3); b.x += Math.sin(t + b.y * 0.1) * 0.3;
    if (b.y < -2) { b.y = h + 2; b.x = Math.random() * w; }
    const bx = Math.floor(b.x), by = Math.floor(b.y);
    if (bx >= 0 && bx < w && by >= 0 && by < h) setPixel(fb, w, bx, by, 0.5, 0.7, 0.9);
  }
};

// 70. Volcano — erupting volcano with lava and smoke
const shaderVolcano: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const cx = w / 2;
  // Sky
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gy = y / h;
    setPixel(fb, w, x, y, 0.05 + gy * 0.03, 0.02, 0.02);
  }
  // Mountain silhouette
  const peakY = Math.floor(h * 0.3);
  for (let x = 0; x < w; x++) {
    const dx = Math.abs(x - cx) / (w * 0.4);
    const mtnY = peakY + Math.floor(dx * dx * h * 0.5);
    for (let y = Math.max(0, mtnY); y < h; y++) {
      if (y < h) setPixel(fb, w, x, y, 0.08, 0.05, 0.03);
    }
  }
  // Crater glow
  for (let dx = -4; dx <= 4; dx++) {
    const px = Math.floor(cx) + dx;
    if (px >= 0 && px < w) {
      for (let dy = 0; dy < 3 + Math.floor(bass * 5); dy++) {
        const py = peakY - dy;
        if (py >= 0) {
          const bri = (1 - dy / 8) * (0.6 + beat * 0.4);
          setPixel(fb, w, px, py, bri, bri * 0.3, 0);
        }
      }
    }
  }
  // Lava streams
  for (let s = 0; s < 3; s++) {
    const sx2 = cx + (s - 1) * 5;
    for (let d = 0; d < 20; d++) {
      const lx = sx2 + Math.sin(t + s * 2 + d * 0.3) * (d * 0.3), ly = peakY + d * 1.2;
      const ix = Math.floor(lx), iy = Math.floor(ly);
      if (ix >= 0 && ix < w && iy >= 0 && iy < h) {
        const bri = 0.7 - d * 0.03 + bass * 0.2;
        setPixel(fb, w, ix, iy, bri, bri * 0.3, 0);
      }
    }
  }
};

// 71. Spider Web — radial web with dewdrops catching light
const shaderSpiderWeb: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(fb, w, x, y, 0.01, 0.01, 0.02);
  // Radial threads
  const threads = 12;
  for (let i = 0; i < threads; i++) {
    const angle = (i / threads) * Math.PI * 2;
    const len = Math.min(w, h) * 0.45;
    for (let d = 0; d < len; d += 0.5) {
      const px = Math.floor(cx + Math.cos(angle) * d), py = Math.floor(cy + Math.sin(angle) * d * 0.7);
      if (px >= 0 && px < w && py >= 0 && py < h) setPixel(fb, w, px, py, 0.15, 0.15, 0.2);
    }
  }
  // Spiral threads
  const spirals = 8 + Math.floor(bass * 4);
  for (let ring = 1; ring <= spirals; ring++) {
    const rr = ring / spirals * Math.min(w, h) * 0.4;
    const sway = Math.sin(t * 0.5 + ring * 0.3) * 1.5 * (1 + mid * 0.3);
    for (let a = 0; a < Math.PI * 2; a += 0.05) {
      const px = Math.floor(cx + Math.cos(a) * (rr + sway)), py = Math.floor(cy + Math.sin(a) * (rr + sway) * 0.7);
      if (px >= 0 && px < w && py >= 0 && py < h) setPixel(fb, w, px, py, 0.12, 0.12, 0.18);
    }
  }
  // Dewdrops at intersections (bright spots)
  for (let i = 0; i < threads; i++) {
    const angle2 = (i / threads) * Math.PI * 2;
    for (let ring2 = 2; ring2 <= spirals; ring2 += 2) {
      const rr2 = ring2 / spirals * Math.min(w, h) * 0.4;
      const px = Math.floor(cx + Math.cos(angle2) * rr2), py = Math.floor(cy + Math.sin(angle2) * rr2 * 0.7);
      if (px >= 0 && px < w && py >= 0 && py < h) {
        const bi2 = Math.floor(i / threads * bands.length);
        const amp2 = bands[Math.min(bi2, bands.length - 1)] || 0;
        const bri = 0.4 + amp2 * 0.5 + beat * 0.2 + treble * 0.1;
        setPixel(fb, w, px, py, bri * 0.8, bri, bri * 1.1);
      }
    }
  }
};

// 72. Northern Star — pulsing 8-pointed star with light beams
const shaderNorthernStar: ShaderFn = (fb, w, h, t, bands, bass, mid, treble, beat) => {
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - cx, dy = y - cy, d = Math.sqrt(dx * dx + dy * dy);
    // Dark sky with subtle stars
    const star = fhash(x * 419 + y * 863) > 0.985 ? 0.2 + fhash(x * 71 + y * 317) * 0.3 : 0;
    setPixel(fb, w, x, y, star * 0.8, star * 0.85, star);
  }
  // 8-pointed star
  const points = 8;
  const pulse = 0.8 + bass * 0.4 + Math.sin(t * 2) * 0.1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - cx, dy = (y - cy) * 1.3;
    const d = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) + t * 0.2;
    // Star shape: use cos of angle*points to create pointed shape
    const starShape = Math.pow(Math.abs(Math.cos(angle * points / 2)), 5);
    const outerR = (15 + mid * 8) * pulse;
    const innerR = 5 * pulse;
    const shapeR = innerR + (outerR - innerR) * starShape;
    if (d < shapeR) {
      const bri = (1 - d / shapeR) * (0.7 + beat * 0.3);
      const idx = (y * w + x) * 4;
      fb[idx] = Math.min(1, fb[idx] + bri); fb[idx+1] = Math.min(1, fb[idx+1] + bri * 0.9); fb[idx+2] = Math.min(1, fb[idx+2] + bri * 0.5);
    }
    // Long light beams (thinner, 4 cardinal + 4 diagonal)
    if (d > shapeR * 0.5 && d < outerR * 3) {
      const beamAngle = ((angle % (Math.PI / 4)) + Math.PI / 4) % (Math.PI / 4);
      const beamWidth = 0.06 + treble * 0.03;
      if (beamAngle < beamWidth || beamAngle > Math.PI / 4 - beamWidth) {
        const bri2 = 0.15 / (1 + (d - shapeR) * 0.03);
        const idx2 = (y * w + x) * 4;
        fb[idx2] = Math.min(1, fb[idx2] + bri2); fb[idx2+1] = Math.min(1, fb[idx2+1] + bri2 * 0.9); fb[idx2+2] = Math.min(1, fb[idx2+2] + bri2 * 0.5);
      }
    }
  }
};

const SHADERS: { name: string; fn: ShaderFn }[] = [
  { name: "Spectrum",     fn: shaderSpectrum     },
  { name: "Radial",       fn: shaderRadial        },
  { name: "Scope",        fn: shaderScope         },
  { name: "Fire",         fn: shaderFire          },
  { name: "Matrix",       fn: shaderMatrix        },
  { name: "EQ",           fn: shaderEQ            },
  { name: "Rings",        fn: shaderRings         },
  { name: "Plasma",       fn: shaderPlasma        },
  { name: "Wave",         fn: shaderWaveform      },
  { name: "DJ Deck",      fn: shaderDJDeck        },
  { name: "Tunnel",       fn: shaderTunnel        },
  { name: "Starfield",    fn: shaderStarfield     },
  { name: "Lissajous",    fn: shaderLissajous     },
  { name: "Kaleidoscope", fn: shaderKaleidoscope  },
  { name: "Vortex",       fn: shaderVortex        },
  { name: "Particles",    fn: shaderParticles     },
  // ── fragcoord.xyz-grade shaders ──
  { name: "Black Hole",   fn: shaderBlackHole     },
  { name: "Nebula",       fn: shaderNebula        },
  { name: "Cymatics",     fn: shaderCymatics      },
  { name: "Aurora",       fn: shaderAurora        },
  { name: "Voronoi",      fn: shaderVoronoi       },
  { name: "Fractal",      fn: shaderFractal       },
  { name: "3D Sphere",    fn: shaderSphere        },
  { name: "Liquid Metal", fn: shaderLiquidMetal   },
  // ── new shaders ──
  { name: "DNA Helix",   fn: shaderDNA            },
  { name: "Rain",        fn: shaderRain           },
  { name: "Oscilloscope",fn: shaderOscXY          },
  { name: "Terrain",     fn: shaderTerrain        },
  { name: "Supernova",   fn: shaderSupernova      },
  { name: "Glitch",      fn: shaderGlitch         },
  // ── research batch (demoscene + cava-inspired) ──
  { name: "Metaballs",   fn: shaderMetaballs      },
  { name: "Ripples",     fn: shaderRipples        },
  { name: "Flow Field",  fn: shaderFlowField      },
  { name: "Lightning",   fn: shaderLightning      },
  { name: "Spectrogram", fn: shaderSpectrogram    },
  { name: "Saturn Ring", fn: shaderSaturn         },
  // ── ✦ art pieces ──
  { name: "✦ Jellyfish",   fn: shaderJellyfish    },
  { name: "✦ Stained Glass",fn: shaderStainedGlass },
  { name: "✦ Northern Lights",fn: shaderNorthernLights },
  { name: "✦ Ocean Deep",  fn: shaderOceanDeep     },
  { name: "✦ Ink",         fn: shaderInk           },
  { name: "✦ Galaxy",      fn: shaderGalaxy        },
  { name: "✦ Fireflies",   fn: shaderFireflies     },
  { name: "✦ Coral",       fn: shaderCoral         },
  // ── ✦ art pieces II ──
  { name: "✦ Lava Lamp",   fn: shaderLavaLamp      },
  { name: "✦ Silk",        fn: shaderSilk          },
  { name: "✦ Rainstorm",   fn: shaderRainstorm     },
  { name: "✦ Ember",       fn: shaderEmber         },
  { name: "✦ Prism",       fn: shaderPrism         },
  { name: "✦ Dreamscape",  fn: shaderDreamscape    },
  { name: "✦ Neon City",   fn: shaderNeonCity      },
  { name: "✦ Wormhole",    fn: shaderWormhole      },
  // ✦ Art Pieces III (53-60)
  { name: "✦ Mandelbrot",  fn: shaderMandelbrot    },
  { name: "✦ Snowfall",    fn: shaderSnowfall      },
  { name: "✦ Kaleidoscope II",fn: shaderKaleidoscope2 },
  { name: "✦ Cyber Rain",  fn: shaderCyberRain     },
  { name: "✦ DNA Helix",   fn: shaderDNAHelix           },
  { name: "✦ Lissajous Web",fn: shaderLissajousWeb },
  { name: "✦ Terrain",     fn: shaderTerrainFly       },
  { name: "✦ Supernova",   fn: shaderSupernovaBurst     },
  // ✦ Art Pieces IV (61-72)
  { name: "✦ Campfire",    fn: shaderCampfire      },
  { name: "✦ Disco Ball",  fn: shaderDiscoBall     },
  { name: "✦ Circuit",     fn: shaderCircuit       },
  { name: "✦ Pendulum Wave",fn: shaderPendulumWave },
  { name: "✦ Sunset Beach",fn: shaderSunsetBeach   },
  { name: "✦ Moth",        fn: shaderMoth          },
  { name: "✦ Binary Rain", fn: shaderBinaryRain    },
  { name: "✦ Eclipse",     fn: shaderEclipse       },
  { name: "✦ Aquarium",    fn: shaderAquarium      },
  { name: "✦ Volcano",     fn: shaderVolcano       },
  { name: "✦ Spider Web",  fn: shaderSpiderWeb     },
  { name: "✦ Northern Star",fn: shaderNorthernStar  },
];

// ─────────────────────────────────────────────────────────────────────────────
// BRAILLE RENDERERS (bjarneo technique — 8× resolution from text)
// ─────────────────────────────────────────────────────────────────────────────

const BRAILLE_BIT: number[][] = [
  [0x01,0x08],[0x02,0x10],[0x04,0x20],[0x40,0x80],
];
function dotHash(a:number,row:number,col:number,frame:number):number{
  const f=Math.floor((frame+row*3+col)/3);let h=(a*7919+row*6271+col*3037+f*104729)>>>0;
  h^=h>>>16;h=Math.imul(h,0x45d9f3b7)>>>0;h^=h>>>16;return(h%10000)/10000;}
function brailleChar(bits:number):string{return String.fromCodePoint(0x2800|bits);}

type BrailleShaderFn = (bands:Float32Array,cols:number,rows:number,frame:number,time:number,samples:Float32Array)=>string;

function renderBrailleBars(bands:Float32Array,cols:number,rows:number):string{
  const dotRows=rows*4,charsPerBand=Math.max(1,Math.floor(cols/bands.length)),lines:string[]=[];
  for(let row=0;row<rows;row++){let line="";for(let b=0;b<bands.length;b++){const level=bands[b];for(let c=0;c<charsPerBand;c++){let braille=0;for(let dr=0;dr<4;dr++){const dotY=row*4+dr,rowBottom=(dotRows-1-dotY)/(dotRows-1);if(level>=rowBottom)for(let dc=0;dc<2;dc++)braille|=BRAILLE_BIT[dr][dc];}const[r,g,bl]=hsl(b/bands.length,1,0.3+level*0.4);line+=`\x1b[38;2;${r|0};${g|0};${bl|0}m${brailleChar(braille)}`;}}lines.push(line+"\x1b[0m");}return lines.join("\n");}

function renderBrailleColumns(bands:Float32Array,cols:number,rows:number):string{
  const dotRows=rows*4,colLevels=new Float32Array(cols);
  for(let c=0;c<cols;c++){const pos=c/cols*(bands.length-1),lo=Math.floor(pos),hi=Math.min(bands.length-1,lo+1);colLevels[c]=bands[lo]*(1-(pos-lo))+bands[hi]*(pos-lo);}
  const lines:string[]=[];for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0;const level=colLevels[ch];for(let dr=0;dr<4;dr++){const dotY=row*4+dr,rowBottom=(dotRows-1-dotY)/(dotRows-1);if(level>=rowBottom)for(let dc=0;dc<2;dc++)braille|=BRAILLE_BIT[dr][dc];}const[r,g,b]=hsl(ch/cols,1,0.25+colLevels[ch]*0.4);line+=`\x1b[38;2;${r|0};${g|0};${b|0}m${brailleChar(braille)}`;}lines.push(line+"\x1b[0m");}return lines.join("\n");}

function renderBrailleWave(samples:Float32Array,cols:number,rows:number,bands:Float32Array):string{
  const dotRows=rows*4,dotCols=cols*2,n=samples.length;const ypos=new Int32Array(dotCols);
  for(let x=0;x<dotCols;x++){const s=n>0?samples[Math.floor(x*n/dotCols)]:0;ypos[x]=Math.max(0,Math.min(dotRows-1,Math.floor((1-s)*(dotRows-1)/2)));}
  let bass=0;for(let i=0;i<4&&i<bands.length;i++)bass+=bands[i];bass/=4;
  const lines:string[]=[];for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0;for(let dc=0;dc<2;dc++){const x=ch*2+dc,y=ypos[x],prevY=x>0?ypos[x-1]:y,yMin=Math.min(y,prevY),yMax=Math.max(y,prevY);for(let dr=0;dr<4;dr++){const dotY=row*4+dr;if(dotY>=yMin&&dotY<=yMax)braille|=BRAILLE_BIT[dr][dc];}}const bl=Math.floor(80+bass*175),g=Math.floor(180+bass*75);line+=`\x1b[38;2;40;${g};${bl}m${brailleChar(braille)}`;}lines.push(line+"\x1b[0m");}return lines.join("\n");}

function renderBrailleScatter(bands:Float32Array,cols:number,rows:number,frame:number):string{
  const dotRows=rows*4,lines:string[]=[];for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0;const b=Math.floor(ch*bands.length/cols),level=bands[Math.min(b,bands.length-1)];for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const dotRow=row*4+dr,h=dotHash(b,dotRow,ch*2+dc,frame),heightFactor=0.5+0.5*dotRow/(dotRows-1);if(h<level*level*heightFactor)braille|=BRAILLE_BIT[dr][dc];}const[r,g,bl]=hsl(b/bands.length,1,0.5);line+=`\x1b[38;2;${r|0};${g|0};${bl|0}m${brailleChar(braille)}`;}lines.push(line+"\x1b[0m");}return lines.join("\n");}

function renderBrailleFlame(bands:Float32Array,cols:number,rows:number,frame:number,time:number):string{
  const dotRows=rows*4,lines:string[]=[];for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0;const b=Math.floor(ch*bands.length/cols),level=Math.max(0.01,bands[Math.min(b,bands.length-1)]);for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const dotRow=row*4+dr,flameY=(dotRows-1-dotRow)/(dotRows-1);if(flameY>level)continue;const wobble=Math.sin(time*3+flameY*6+b*2.1)*1.5,tipNarrow=1-flameY/level,flameWidth=(0.3+0.7*tipNarrow)*1.0,dist=Math.abs(dc-1.0+0.5-wobble);if(dist<flameWidth){const edge=dist/flameWidth;if(edge<0.7||dotHash(b,dotRow,ch*2+dc,frame)<0.6)braille|=BRAILLE_BIT[dr][dc];}}line+=`\x1b[38;2;255;${Math.floor(row/rows*200)|0};20m${brailleChar(braille)}`;}lines.push(line+"\x1b[0m");}return lines.join("\n");}

function renderBrailleRings(bands:Float32Array,cols:number,rows:number,time:number):string{
  const cx=cols/2,cy=rows*2,dotRows=rows*4,dotCols=cols*2,dots=new Uint8Array(dotRows*dotCols*3);
  for(let ring=0;ring<Math.min(8,bands.length);ring++){const level=bands[Math.floor(ring*bands.length/8)],maxR=Math.min(cx,cy)*0.9,r2=(ring+1)/9*maxR+level*3*Math.sin(time*2+ring);const[cr,cg,cb]=hsl((ring/8+time*0.05)%1,1,0.3+level*0.4);const steps=Math.max(60,Math.floor(r2*6));for(let s=0;s<steps;s++){const angle=(s/steps)*Math.PI*2,dx=Math.floor(cx+Math.cos(angle)*r2),dy=Math.floor(cy+Math.sin(angle)*r2*0.5);if(dx>=0&&dx<dotCols&&dy>=0&&dy<dotRows){const i=(dy*dotCols+dx)*3;dots[i]=Math.min(255,(dots[i]||0)+cr|0);dots[i+1]=Math.min(255,(dots[i+1]||0)+cg|0);dots[i+2]=Math.min(255,(dots[i+2]||0)+cb|0);}}}
  const lines:string[]=[];for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,tr=0,tg=0,tb=0,count=0;for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const dotY=row*4+dr,dotX=ch*2+dc,i=(dotY*dotCols+dotX)*3;if(dots[i]||dots[i+1]||dots[i+2]){braille|=BRAILLE_BIT[dr][dc];tr+=dots[i];tg+=dots[i+1];tb+=dots[i+2];count++;}}if(count){tr/=count;tg/=count;tb/=count;}else{tr=20;tg=20;tb=30;}line+=`\x1b[38;2;${tr|0};${tg|0};${tb|0}m${brailleChar(braille)}`;}lines.push(line+"\x1b[0m");}return lines.join("\n");}

function renderBrailleMatrix(bands:Float32Array,cols:number,rows:number,frame:number,time:number):string{
  const dotRows=rows*4,dotCols=cols*2,lines:string[]=[];
  for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){
      const dotX=ch*2+dc,dotY=row*4+dr;
      const colSpeed=1+dotHash(0,0,dotX,0)*2;
      const drop=((time*colSpeed*8+dotX*7.3)%dotRows)|0;
      const dist=((dotY-drop+dotRows)%dotRows);
      if(dist<4+bands[Math.floor(dotX/dotCols*bands.length)%bands.length]*8) braille|=BRAILLE_BIT[dr][dc];
    }
    const bi=Math.floor(ch/cols*bands.length),lv=bands[Math.min(bi,bands.length-1)]||0;
    const g=Math.floor(80+lv*175);line+=`\x1b[38;2;0;${g};${Math.floor(lv*40)}m${brailleChar(braille)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

function renderBrailleStarfield(bands:Float32Array,cols:number,rows:number,frame:number,time:number):string{
  const dotRows=rows*4,dotCols=cols*2,cx=dotCols/2,cy=dotRows/2;
  let bass=0;for(let i=0;i<4&&i<bands.length;i++)bass+=bands[i];bass/=4;
  const dots=new Uint8Array(dotRows*dotCols);
  for(let s=0;s<80;s++){const speed=0.005+bass*0.02+dotHash(s,0,0,0)*0.01;
    const sx=dotHash(s,1,0,0)*2-1,sy=dotHash(s,0,1,0)*2-1;
    let z=((1-((time*speed*20+s*0.1)%1))+1)%1;if(z<0.01)z=0.01;
    const px=Math.floor(cx+sx/z*cx),py=Math.floor(cy+sy/z*cy*0.5);
    if(px>=0&&px<dotCols&&py>=0&&py<dotRows) dots[py*dotCols+px]=Math.floor((1-z)*255);
  }
  const lines:string[]=[];for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,maxB=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const v=dots[(row*4+dr)*dotCols+ch*2+dc];if(v>30){braille|=BRAILLE_BIT[dr][dc];maxB=Math.max(maxB,v);}}
    line+=`\x1b[38;2;${maxB|0};${maxB|0};${Math.min(255,maxB+50)|0}m${brailleChar(braille)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

function renderBrailleVortex(bands:Float32Array,cols:number,rows:number,_frame:number,time:number):string{
  const dotRows=rows*4,dotCols=cols*2,cx=dotCols/2,cy=dotRows/2;
  const dots=new Uint8Array(dotRows*dotCols*3);
  const arms=4;
  for(let arm=0;arm<arms;arm++){const armAngle=(arm/arms)*Math.PI*2;
    for(let i=0;i<200;i++){const frac=i/200,bi=Math.floor(frac*bands.length),lv=(bands[Math.min(bi,bands.length-1)]||0)*3;
      const r2=frac*Math.min(cx,cy)*0.9*(0.5+lv*0.5);
      const angle=armAngle+frac*Math.PI*3+time*(1.2+lv*0.5);
      const px=Math.floor(cx+Math.cos(angle)*r2),py=Math.floor(cy+Math.sin(angle)*r2*0.5);
      if(px>=0&&px<dotCols&&py>=0&&py<dotRows){const idx=(py*dotCols+px)*3;const[cr,cg,cb]=hsl((arm/arms+frac*0.3+time*0.05)%1,1,0.5);
        dots[idx]=Math.min(255,dots[idx]+(cr*0.8|0));dots[idx+1]=Math.min(255,dots[idx+1]+(cg*0.8|0));dots[idx+2]=Math.min(255,dots[idx+2]+(cb*0.8|0));}}}
  const lines:string[]=[];for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,tr=0,tg=0,tb=0,cnt=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const idx=((row*4+dr)*dotCols+ch*2+dc)*3;
      if(dots[idx]||dots[idx+1]||dots[idx+2]){braille|=BRAILLE_BIT[dr][dc];tr+=dots[idx];tg+=dots[idx+1];tb+=dots[idx+2];cnt++;}}
    if(cnt){tr/=cnt;tg/=cnt;tb/=cnt;}else{tr=8;tg=8;tb=15;}
    line+=`\x1b[38;2;${tr|0};${tg|0};${tb|0}m${brailleChar(braille)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

function renderBraillePlasma(bands:Float32Array,cols:number,rows:number,_frame:number,time:number):string{
  const dotRows=rows*4,dotCols=cols*2;let bass=0;for(let i=0;i<4&&i<bands.length;i++)bass+=bands[i];bass/=4;
  const lines:string[]=[];for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0;
    let tr=0,tg=0,tb=0,cnt=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const dx=(ch*2+dc)/dotCols,dy=(row*4+dr)/dotRows;
      const v=(Math.sin(dx*10+time*2)+Math.sin(dy*8+time*1.5)+Math.sin((dx+dy)*6+time+bass*5))/3*0.5+0.5;
      if(v>0.35){braille|=BRAILLE_BIT[dr][dc];const[cr,cg,cb]=hsl((v+time*0.05)%1,0.9,0.3+v*0.4);tr+=cr;tg+=cg;tb+=cb;cnt++;}}
    if(cnt){tr/=cnt;tg/=cnt;tb/=cnt;}else{tr=5;tg=5;tb=10;}
    line+=`\x1b[38;2;${tr|0};${tg|0};${tb|0}m${brailleChar(braille)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

function renderBrailleLissajous(bands:Float32Array,cols:number,rows:number,_frame:number,time:number,samples:Float32Array):string{
  const dotRows=rows*4,dotCols=cols*2,cx=dotCols/2,cy=dotRows/2;
  let bass=0,treble=0;for(let i=0;i<4&&i<bands.length;i++)bass+=bands[i];bass/=4;
  for(let i=16;i<bands.length;i++)treble+=bands[i];treble/=(bands.length-16||1);
  const dots=new Uint8Array(dotRows*dotCols);
  if(samples&&samples.length>1){const step=Math.max(1,Math.floor(samples.length/800));
    for(let i=0;i<samples.length-step;i+=step){const xS=samples[i]||0,yS=samples[Math.min(i+Math.floor(samples.length*0.25),samples.length-1)]||0;
      const px=Math.floor(cx+xS*cx*0.85),py=Math.floor(cy+yS*cy*0.42);
      if(px>=0&&px<dotCols&&py>=0&&py<dotRows)dots[py*dotCols+px]=255;}}
  else{const fx=3+Math.floor(bass*5),fy=2+Math.floor(treble*4);
    for(let i=0;i<2000;i++){const theta=(i/2000)*Math.PI*2;
      const px=Math.floor(cx+Math.sin(fx*theta+time*0.8)*cx*0.8),py=Math.floor(cy+Math.sin(fy*theta)*cy*0.4);
      if(px>=0&&px<dotCols&&py>=0&&py<dotRows)dots[py*dotCols+px]=255;}}
  const lines:string[]=[];for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,has=false;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){if(dots[(row*4+dr)*dotCols+ch*2+dc]){braille|=BRAILLE_BIT[dr][dc];has=true;}}
    line+=has?`\x1b[38;2;40;255;40m${brailleChar(braille)}`:`\x1b[38;2;5;20;5m${brailleChar(0)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

function renderBrailleSpectro(bands:Float32Array,cols:number,rows:number,frame:number):string{
  // Scrolling spectrogram — push bands history
  if(!((renderBrailleSpectro as any)._hist)) (renderBrailleSpectro as any)._hist = [] as Float32Array[];
  const hist:(Float32Array[])=(renderBrailleSpectro as any)._hist;
  const snap=new Float32Array(bands.length);for(let i=0;i<bands.length;i++)snap[i]=bands[i];
  hist.push(snap);if(hist.length>cols*2)hist.shift();
  const dotRows=rows*4,dotCols=cols*2,lines:string[]=[];
  for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,tr=0,tg=0,tb=0,cnt=0;
    for(let dc=0;dc<2;dc++){const timeIdx=hist.length-dotCols+ch*2+dc;if(timeIdx<0)continue;
      const col2=hist[timeIdx];if(!col2)continue;
      for(let dr=0;dr<4;dr++){const freqIdx=Math.floor(((dotRows-1-(row*4+dr))/dotRows)*col2.length);
        const lv=Math.min(1,(col2[Math.min(freqIdx,col2.length-1)]||0)*5);
        if(lv>0.1){braille|=BRAILLE_BIT[dr][dc];
          // Heatmap
          let cr=0,cg=0,cb=0;
          if(lv<0.4){cb=lv*2.5*255;}else if(lv<0.7){cg=(lv-0.4)*3.3*255;cb=255*(1-(lv-0.4)*3.3);}else{cr=(lv-0.7)*3.3*255;cg=255*(1-(lv-0.7)*3.3);}
          tr+=cr;tg+=cg;tb+=cb;cnt++;}}}
    if(cnt){tr/=cnt;tg/=cnt;tb/=cnt;}
    line+=`\x1b[38;2;${tr|0};${tg|0};${tb|0}m${brailleChar(braille)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

function renderBrailleCircle(bands:Float32Array,cols:number,rows:number,_frame:number,time:number):string{
  const dotRows=rows*4,dotCols=cols*2,cx=dotCols/2,cy=dotRows/2,baseR=Math.min(cx,cy)*0.5;
  const dots=new Uint8Array(dotRows*dotCols*3);
  for(let s=0;s<360;s++){const angle=(s/360)*Math.PI*2;
    const bi=Math.floor((s/360)*bands.length),lv=(bands[Math.min(bi,bands.length-1)]||0)*4;
    const r2=baseR+lv*baseR*0.5;
    const px=Math.floor(cx+Math.cos(angle+time*0.3)*r2),py=Math.floor(cy+Math.sin(angle+time*0.3)*r2*0.5);
    const[cr,cg,cb]=hsl((s/360+time*0.03)%1,0.9,0.4+lv*0.1);
    if(px>=0&&px<dotCols&&py>=0&&py<dotRows){const idx=(py*dotCols+px)*3;dots[idx]=Math.min(255,dots[idx]+(cr|0));dots[idx+1]=Math.min(255,dots[idx+1]+(cg|0));dots[idx+2]=Math.min(255,dots[idx+2]+(cb|0));}}
  const lines:string[]=[];for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,tr=0,tg=0,tb=0,cnt=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const idx=((row*4+dr)*dotCols+ch*2+dc)*3;
      if(dots[idx]||dots[idx+1]||dots[idx+2]){braille|=BRAILLE_BIT[dr][dc];tr+=dots[idx];tg+=dots[idx+1];tb+=dots[idx+2];cnt++;}}
    if(cnt){tr/=cnt;tg/=cnt;tb/=cnt;}else{tr=5;tg=5;tb=12;}
    line+=`\x1b[38;2;${tr|0};${tg|0};${tb|0}m${brailleChar(braille)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

function renderBrailleRain2(bands:Float32Array,cols:number,rows:number,frame:number,time:number):string{
  if(!((renderBrailleRain2 as any)._drops))(renderBrailleRain2 as any)._drops=[] as {x:number;y:number;s:number}[];
  const drops:({x:number;y:number;s:number}[])=(renderBrailleRain2 as any)._drops;
  const dotRows=rows*4,dotCols=cols*2;let bass=0;for(let i=0;i<4&&i<bands.length;i++)bass+=bands[i];bass/=4;
  const rate=3+Math.floor(bass*12);
  for(let i=0;i<rate&&drops.length<400;i++)drops.push({x:Math.floor(Math.random()*dotCols),y:0,s:2+Math.random()*3});
  const dots=new Uint8Array(dotRows*dotCols);
  for(let i=drops.length-1;i>=0;i--){const d=drops[i];d.y+=d.s;if(d.y>=dotRows){drops.splice(i,1);continue;}
    for(let t2=0;t2<3;t2++){const py=Math.floor(d.y)-t2;if(py>=0&&py<dotRows&&d.x<dotCols)dots[py*dotCols+d.x]=Math.floor(255*(1-t2/3));}}
  const lines:string[]=[];for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,maxV=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const v=dots[(row*4+dr)*dotCols+ch*2+dc];if(v>20){braille|=BRAILLE_BIT[dr][dc];maxV=Math.max(maxV,v);}}
    const bi=Math.floor(ch/cols*bands.length),lv=bands[Math.min(bi,bands.length-1)]||0;
    const b=Math.floor(120+lv*135);line+=`\x1b[38;2;${Math.floor(maxV*0.3)};${Math.floor(maxV*0.5)};${Math.min(255,b)}m${brailleChar(braille)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

// ── braille shaders III (15-20) ──

// 15. Heartbeat — ECG-style line with beat pulses
function renderBrailleHeartbeat(bands:Float32Array,cols:number,rows:number,frame:number,time:number):string{
  const dotRows=rows*4,dotCols=cols*2;const dots=new Uint8Array(dotRows*dotCols);
  const cy=dotRows/2;
  for(let x=0;x<dotCols;x++){
    const phase=(x/dotCols)*Math.PI*8+time*3;
    const bass=bands[0]||0,mid=bands[Math.floor(bands.length/2)]||0;
    // Flat line with periodic spikes
    const spike=Math.sin(phase)>0.9?Math.sin(phase*3)*dotRows*0.3*(0.5+bass):0;
    const y2=cy+spike+Math.sin(phase*0.5)*mid*3;
    const iy=Math.round(y2);
    if(iy>=0&&iy<dotRows)dots[iy*dotCols+x]=255;
    // Fading trail
    if(iy-1>=0&&iy-1<dotRows)dots[(iy-1)*dotCols+x]=120;
    if(iy+1>=0&&iy+1<dotRows)dots[(iy+1)*dotCols+x]=120;
  }
  const lines:string[]=[];
  for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,maxV=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const v=dots[(row*4+dr)*dotCols+ch*2+dc];if(v>20){braille|=BRAILLE_BIT[dr][dc];maxV=Math.max(maxV,v);}}
    line+=maxV>0?`\x1b[38;2;${Math.min(255,maxV+50)};${Math.floor(maxV*0.2)};${Math.floor(maxV*0.2)}m${brailleChar(braille)}`:`\x1b[38;2;20;5;5m${brailleChar(0)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

// 16. Ripple — concentric expanding circles from center
function renderBrailleRipple(bands:Float32Array,cols:number,rows:number,frame:number,time:number):string{
  const dotRows=rows*4,dotCols=cols*2;const dots=new Uint8Array(dotRows*dotCols);
  const cx=dotCols/2,cy=dotRows/2;
  const bass=bands[0]||0;
  for(let y=0;y<dotRows;y++)for(let x=0;x<dotCols;x++){
    const dx=x-cx,dy=(y-cy)*1.5;const dist=Math.sqrt(dx*dx+dy*dy);
    const wave=Math.sin(dist*0.5-time*4)*0.5+0.5;
    const ring=(Math.sin(dist*0.3-time*2+bass*3)>0.6)?200:0;
    const v=Math.floor(wave*100+ring);
    dots[y*dotCols+x]=Math.min(255,v);
  }
  const lines:string[]=[];
  for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,maxV=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const v=dots[(row*4+dr)*dotCols+ch*2+dc];if(v>50){braille|=BRAILLE_BIT[dr][dc];maxV=Math.max(maxV,v);}}
    const bi=Math.floor(ch/cols*bands.length),lv=bands[Math.min(bi,bands.length-1)]||0;
    line+=maxV>0?`\x1b[38;2;${Math.floor(50+lv*100)};${Math.floor(100+maxV*0.4)};${Math.min(255,Math.floor(180+lv*75))}m${brailleChar(braille)}`:`\x1b[38;2;8;8;15m${brailleChar(0)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

// 17. Waveform3D — stacked waveform layers with depth
function renderBrailleWaveform3D(bands:Float32Array,cols:number,rows:number,frame:number,time:number):string{
  const dotRows=rows*4,dotCols=cols*2;const dots=new Uint8Array(dotRows*dotCols);
  const layers=5;
  for(let l=0;l<layers;l++){
    const yBase=Math.floor(dotRows*0.2+l*dotRows*0.15);
    const phase=time*2+l*0.8;
    for(let x=0;x<dotCols;x++){
      const bi=Math.floor(x/dotCols*bands.length);
      const amp=(bands[Math.min(bi,bands.length-1)]||0)*dotRows*0.12;
      const wave=Math.sin(x*0.15+phase)*amp;
      const y2=yBase+Math.floor(wave);
      if(y2>=0&&y2<dotRows){dots[y2*dotCols+x]=Math.max(dots[y2*dotCols+x],200-l*30);}
    }
  }
  const lines:string[]=[];
  for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,maxV=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const v=dots[(row*4+dr)*dotCols+ch*2+dc];if(v>20){braille|=BRAILLE_BIT[dr][dc];maxV=Math.max(maxV,v);}}
    line+=maxV>0?`\x1b[38;2;${Math.floor(maxV*0.8)};${Math.floor(maxV*0.5)};${Math.min(255,Math.floor(maxV+55))}m${brailleChar(braille)}`:`\x1b[38;2;5;5;10m${brailleChar(0)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

// 18. Fractal Tree — branching tree that sways with bass
function renderBrailleFractalTree(bands:Float32Array,cols:number,rows:number,frame:number,time:number):string{
  const dotRows=rows*4,dotCols=cols*2;const dots=new Uint8Array(dotRows*dotCols);
  const bass=bands[0]||0,treble=bands[bands.length-1]||0;
  function branch(x:number,y:number,angle:number,len:number,depth:number){
    if(depth<=0||len<2)return;
    const ex=x+Math.cos(angle)*len,ey=y-Math.sin(angle)*len;
    // Draw line
    const steps=Math.ceil(len);
    for(let i=0;i<=steps;i++){
      const px=Math.floor(x+(ex-x)*i/steps),py=Math.floor(y+(ey-y)*i/steps);
      if(px>=0&&px<dotCols&&py>=0&&py<dotRows)dots[py*dotCols+px]=Math.min(255,150+depth*20);
    }
    const sway=Math.sin(time*1.5+depth*0.5)*0.2*bass;
    branch(ex,ey,angle+0.4+sway,len*0.7,depth-1);
    branch(ex,ey,angle-0.4+sway,len*0.7,depth-1);
    if(depth>3&&treble>0.3)branch(ex,ey,angle+sway,len*0.5,depth-2);
  }
  branch(dotCols/2,dotRows-2,Math.PI/2,dotRows*0.25,7);
  const lines:string[]=[];
  for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,maxV=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const v=dots[(row*4+dr)*dotCols+ch*2+dc];if(v>20){braille|=BRAILLE_BIT[dr][dc];maxV=Math.max(maxV,v);}}
    const green2=Math.floor(80+maxV*0.6),brown=Math.floor(40+maxV*0.3);
    line+=maxV>0?`\x1b[38;2;${brown};${green2};${Math.floor(maxV*0.15)}m${brailleChar(braille)}`:`\x1b[38;2;5;8;3m${brailleChar(0)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

// 19. Pendulum — swinging pendulums at different frequencies
function renderBraillePendulum(bands:Float32Array,cols:number,rows:number,frame:number,time:number):string{
  const dotRows=rows*4,dotCols=cols*2;const dots=new Uint8Array(dotRows*dotCols);
  const numPendulums=Math.min(12,Math.floor(dotCols/4));
  for(let p=0;p<numPendulums;p++){
    const anchorX=Math.floor((p+0.5)/numPendulums*dotCols);
    const freq=0.8+p*0.15;const len=dotRows*0.6;
    const bi=Math.floor(p/numPendulums*bands.length);
    const amp=0.5+((bands[Math.min(bi,bands.length-1)]||0))*0.8;
    const angle=Math.sin(time*freq)*amp;
    const bx=anchorX+Math.sin(angle)*len,by=Math.cos(angle)*len;
    // Draw string
    const steps=Math.ceil(len);
    for(let i=0;i<=steps;i++){
      const px=Math.floor(anchorX+(bx-anchorX)*i/steps),py=Math.floor(i/steps*by);
      if(px>=0&&px<dotCols&&py>=0&&py<dotRows)dots[py*dotCols+px]=Math.min(255,100+i);
    }
    // Bob
    const bobx=Math.floor(bx),boby=Math.floor(by);
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const px=bobx+dx,py=boby+dy;
      if(px>=0&&px<dotCols&&py>=0&&py<dotRows)dots[py*dotCols+px]=255;
    }
  }
  const lines:string[]=[];
  for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,maxV=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const v=dots[(row*4+dr)*dotCols+ch*2+dc];if(v>20){braille|=BRAILLE_BIT[dr][dc];maxV=Math.max(maxV,v);}}
    line+=maxV>0?`\x1b[38;2;${Math.min(255,Math.floor(maxV+30))};${Math.floor(maxV*0.7)};${Math.floor(maxV*0.3)}m${brailleChar(braille)}`:`\x1b[38;2;10;8;5m${brailleChar(0)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

// 20. Terrain braille — scrolling height map
function renderBrailleTerrain(bands:Float32Array,cols:number,rows:number,frame:number,time:number):string{
  const dotRows=rows*4,dotCols=cols*2;const dots=new Uint8Array(dotRows*dotCols);
  const bass=bands[0]||0;
  for(let y=0;y<dotRows;y++){
    const depth=(y+1)/dotRows;
    const scale=1/(depth+0.05);
    for(let x=0;x<dotCols;x++){
      const wx=(x/dotCols-0.5)*scale*3,wz=time*1.5+scale*2+bass;
      // Simple noise
      const n=Math.sin(wx*1.7+wz*0.8)*Math.cos(wx*0.6+wz*1.3)*0.5+0.5;
      const threshold=0.35+depth*0.1;
      if(n>threshold)dots[y*dotCols+x]=Math.floor(100+n*155);
    }
  }
  const lines:string[]=[];
  for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,maxV=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const v=dots[(row*4+dr)*dotCols+ch*2+dc];if(v>20){braille|=BRAILLE_BIT[dr][dc];maxV=Math.max(maxV,v);}}
    const depth2=(row*4)/(dotRows);
    const g2=Math.floor(50+maxV*0.5*(1-depth2));
    line+=maxV>0?`\x1b[38;2;${Math.floor(30+maxV*0.2)};${g2};${Math.floor(20+maxV*0.15)}m${brailleChar(braille)}`:`\x1b[38;2;5;10;5m${brailleChar(0)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

// ── braille IV functions (21-25) ──

// 21. Spiral — Archimedean spiral that pulses with bass
function renderBrailleSpiral(bands:Float32Array,cols:number,rows:number,frame:number,time:number):string{
  const dotRows=rows*4,dotCols=cols*2;const dots=new Uint8Array(dotRows*dotCols);
  const cx=dotCols/2,cy=dotRows/2;const bass=bands[0]||0;
  for(let a=0;a<Math.PI*12;a+=0.03){
    const r2=a*1.5*(1+bass*0.3);
    const px=Math.floor(cx+Math.cos(a+time*2)*r2),py=Math.floor(cy+Math.sin(a+time*2)*r2*0.6);
    if(px>=0&&px<dotCols&&py>=0&&py<dotRows)dots[py*dotCols+px]=Math.min(255,180+Math.floor(a*5)%75);
  }
  const lines:string[]=[];
  for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,maxV=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const v=dots[(row*4+dr)*dotCols+ch*2+dc];if(v>20){braille|=BRAILLE_BIT[dr][dc];maxV=Math.max(maxV,v);}}
    line+=maxV>0?`\x1b[38;2;${Math.floor(maxV*0.9)};${Math.floor(maxV*0.5)};${Math.min(255,Math.floor(maxV+30))}m${brailleChar(braille)}`:`\x1b[38;2;5;3;8m${brailleChar(0)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

// 22. Waveform Dual — left+right channel waveforms mirrored
function renderBrailleWaveformDual(bands:Float32Array,cols:number,rows:number,frame:number,time:number,samples:Float32Array):string{
  const dotRows=rows*4,dotCols=cols*2;const dots=new Uint8Array(dotRows*dotCols);
  const cy=dotRows/2;
  if(samples&&samples.length>0){
    for(let x=0;x<dotCols;x++){
      const si=Math.floor(x/dotCols*samples.length);
      const v=samples[Math.min(si,samples.length-1)]||0;
      const y1=Math.floor(cy-v*cy*0.8),y2=Math.floor(cy+v*cy*0.8);
      if(y1>=0&&y1<dotRows)dots[y1*dotCols+x]=220;
      if(y2>=0&&y2<dotRows)dots[y2*dotCols+x]=180;
    }
  }else{
    for(let x=0;x<dotCols;x++){
      const bi=Math.floor(x/dotCols*bands.length);
      const v=bands[Math.min(bi,bands.length-1)]||0;
      const y1=Math.floor(cy-v*cy*0.6),y2=Math.floor(cy+v*cy*0.6);
      if(y1>=0&&y1<dotRows)dots[y1*dotCols+x]=200;
      if(y2>=0&&y2<dotRows)dots[y2*dotCols+x]=160;
    }
  }
  // Center line
  for(let x=0;x<dotCols;x++)if(dots[cy*dotCols+x]<50)dots[cy*dotCols+x]=50;
  const lines:string[]=[];
  for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,maxV=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const v=dots[(row*4+dr)*dotCols+ch*2+dc];if(v>20){braille|=BRAILLE_BIT[dr][dc];maxV=Math.max(maxV,v);}}
    line+=maxV>0?`\x1b[38;2;${Math.floor(maxV*0.3)};${Math.min(255,Math.floor(maxV+20))};${Math.floor(maxV*0.5)}m${brailleChar(braille)}`:`\x1b[38;2;5;10;5m${brailleChar(0)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

// 23. Diamonds — expanding diamond shapes from center
function renderBrailleDiamonds(bands:Float32Array,cols:number,rows:number,frame:number,time:number):string{
  const dotRows=rows*4,dotCols=cols*2;const dots=new Uint8Array(dotRows*dotCols);
  const cx=dotCols/2,cy=dotRows/2;const bass=bands[0]||0;
  for(let y=0;y<dotRows;y++)for(let x=0;x<dotCols;x++){
    const d=Math.abs(x-cx)+Math.abs((y-cy)*1.5);
    const ring=Math.sin(d*0.3-time*3+bass*2)*0.5+0.5;
    if(ring>0.6)dots[y*dotCols+x]=Math.floor(ring*255);
  }
  const lines:string[]=[];
  for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,maxV=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const v=dots[(row*4+dr)*dotCols+ch*2+dc];if(v>20){braille|=BRAILLE_BIT[dr][dc];maxV=Math.max(maxV,v);}}
    const bi=Math.floor(ch/cols*bands.length),lv=bands[Math.min(bi,bands.length-1)]||0;
    line+=maxV>0?`\x1b[38;2;${Math.min(255,Math.floor(180+lv*75))};${Math.floor(maxV*0.6)};${Math.floor(maxV*0.8)}m${brailleChar(braille)}`:`\x1b[38;2;8;5;8m${brailleChar(0)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

// 24. Bounce — balls bouncing with gravity
const BOUNCE_BALLS:{x:number;y:number;vx:number;vy:number}[]=[];
function renderBrailleBounce(bands:Float32Array,cols:number,rows:number,frame:number,time:number):string{
  const dotRows=rows*4,dotCols=cols*2;const dots=new Uint8Array(dotRows*dotCols);
  while(BOUNCE_BALLS.length<8)BOUNCE_BALLS.push({x:Math.random()*dotCols,y:Math.random()*dotRows*0.3,vx:(Math.random()-0.5)*2,vy:0});
  const bass=bands[0]||0;
  for(const b of BOUNCE_BALLS){
    b.vy+=0.3;b.x+=b.vx;b.y+=b.vy;
    if(b.y>=dotRows-2){b.y=dotRows-2;b.vy=-Math.abs(b.vy)*(0.7+bass*0.3);}
    if(b.x<0){b.x=0;b.vx=Math.abs(b.vx);}if(b.x>=dotCols){b.x=dotCols-1;b.vx=-Math.abs(b.vx);}
    const ix=Math.floor(b.x),iy=Math.floor(b.y);
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const px=ix+dx,py=iy+dy;
      if(px>=0&&px<dotCols&&py>=0&&py<dotRows)dots[py*dotCols+px]=255;
    }
  }
  const lines:string[]=[];
  for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,maxV=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const v=dots[(row*4+dr)*dotCols+ch*2+dc];if(v>20){braille|=BRAILLE_BIT[dr][dc];maxV=Math.max(maxV,v);}}
    line+=maxV>0?`\x1b[38;2;${Math.min(255,Math.floor(maxV+20))};${Math.floor(maxV*0.7)};${Math.floor(maxV*0.3)}m${brailleChar(braille)}`:`\x1b[38;2;8;5;3m${brailleChar(0)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

// 25. Tunnel — braille version of infinite tunnel
function renderBrailleTunnel(bands:Float32Array,cols:number,rows:number,frame:number,time:number):string{
  const dotRows=rows*4,dotCols=cols*2;const dots=new Uint8Array(dotRows*dotCols);
  const cx=dotCols/2,cy=dotRows/2;const bass=bands[0]||0,treble=bands[bands.length-1]||0;
  for(let y=0;y<dotRows;y++)for(let x=0;x<dotCols;x++){
    const dx=x-cx,dy=(y-cy)*1.5;const d=Math.sqrt(dx*dx+dy*dy)+0.01;
    const angle=Math.atan2(dy,dx);
    const tunnel=1/d*20;
    const u=angle/Math.PI,v2=tunnel-time*2;
    const checker=(Math.floor(u*6)+Math.floor(v2*3))%2;
    const bri=checker?Math.min(255,Math.floor(150/d*5+bass*100)):Math.floor(50/d*5);
    if(bri>30&&d>2)dots[y*dotCols+x]=Math.min(255,bri);
  }
  const lines:string[]=[];
  for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,maxV=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const v=dots[(row*4+dr)*dotCols+ch*2+dc];if(v>20){braille|=BRAILLE_BIT[dr][dc];maxV=Math.max(maxV,v);}}
    line+=maxV>0?`\x1b[38;2;${Math.floor(maxV*0.5)};${Math.floor(maxV*0.3)};${Math.min(255,Math.floor(maxV+30))}m${brailleChar(braille)}`:`\x1b[38;2;3;3;8m${brailleChar(0)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

// 27. Pulse — pulsating filled ellipse with shockwave ring (inspired by cliamp vis_pulse.go)
function renderBraillePulse(bands:Float32Array,cols:number,rows:number,frame:number,time:number):string{
  const dotRows=rows*4,dotCols=cols*2;const dots=new Uint8Array(dotRows*dotCols);
  const cx=dotCols/2,cy=dotRows/2;
  const xScale=cy/cx; // squash x so ellipse fills wide terminal
  const maxR=cy-1;
  let totalE=0;for(let i=0;i<bands.length;i++)totalE+=bands[i]||0;
  const avgE=totalE/bands.length;const bass=bands[0]||0;
  // Shockwave: expanding ring on bass transients
  const shockPhase=(frame*0.10)%1.0;
  const shockR=maxR*(0.3+0.7*shockPhase);
  const shockStrength=avgE*avgE*(1-shockPhase*shockPhase);
  // Breathing keeps shape alive in silence
  const breath=Math.sin(frame*0.05)*0.02;
  for(let y=0;y<dotRows;y++)for(let x=0;x<dotCols;x++){
    const dx=(x-cx)*xScale,dy=y-cy;
    const dist=Math.sqrt(dx*dx+dy*dy);
    // Per-band radius deformation
    const angle=Math.atan2(dy,dx);
    const bandIdx=Math.floor(((angle+Math.PI)/(2*Math.PI))*bands.length)%bands.length;
    const bandE=bands[bandIdx]||0;
    const radius=maxR*(0.3+avgE*0.4+bandE*0.3+breath);
    // Solid fill with anti-aliased edge
    const edgeDist=radius-dist;
    let intensity=edgeDist>1?1:edgeDist>0?edgeDist:0;
    // Shockwave ring overlay
    const ringDist=Math.abs(dist-shockR);
    if(ringDist<2&&shockStrength>0.05)intensity=Math.min(1,intensity+shockStrength*(1-ringDist/2));
    if(intensity>0.05){
      dots[y*dotCols+x]=Math.floor(intensity*255);
    }
  }
  const lines:string[]=[];
  for(let row=0;row<rows;row++){let line="";for(let ch=0;ch<cols;ch++){let braille=0,maxV=0;
    for(let dr=0;dr<4;dr++)for(let dc=0;dc<2;dc++){const v=dots[(row*4+dr)*dotCols+ch*2+dc];if(v>20){braille|=BRAILLE_BIT[dr][dc];maxV=Math.max(maxV,v);}}
    const hue=(maxV/255*120+frame*2)%360;const s=0.8,l=maxV/255*0.5;
    const c2=(1-Math.abs(2*l-1))*s,x2=c2*(1-Math.abs(hue/60%2-1)),m2=l-c2/2;
    let r=0,g=0,b=0;
    if(hue<60){r=c2;g=x2;}else if(hue<120){r=x2;g=c2;}else if(hue<180){g=c2;b=x2;}else if(hue<240){g=x2;b=c2;}else if(hue<300){r=x2;b=c2;}else{r=c2;b=x2;}
    line+=maxV>0?`\x1b[38;2;${Math.floor((r+m2)*255)};${Math.floor((g+m2)*255)};${Math.floor((b+m2)*255)}m${brailleChar(braille)}`:`\x1b[38;2;3;3;6m${brailleChar(0)}`;
  }lines.push(line+"\x1b[0m");}return lines.join("\n");}

const BRAILLE_SHADERS: { name: string; fn: BrailleShaderFn }[] = [
  { name: "◦ Bars",      fn: (bands,cols,rows)           => renderBrailleBars(bands,cols,rows) },
  { name: "◦ Columns",   fn: (bands,cols,rows)           => renderBrailleColumns(bands,cols,rows) },
  { name: "◦ Wave",      fn: (bands,cols,rows,_f,_t,s)   => renderBrailleWave(s,cols,rows,bands) },
  { name: "◦ Scatter",   fn: (bands,cols,rows,frame)     => renderBrailleScatter(bands,cols,rows,frame) },
  { name: "◦ Flame",     fn: (bands,cols,rows,frame,t)   => renderBrailleFlame(bands,cols,rows,frame,t) },
  { name: "◦ Rings",     fn: (bands,cols,rows,_f,t)      => renderBrailleRings(bands,cols,rows,t) },
  // ── new braille shaders ──
  { name: "◦ Matrix",    fn: (bands,cols,rows,frame,t)   => renderBrailleMatrix(bands,cols,rows,frame,t) },
  { name: "◦ Starfield", fn: (bands,cols,rows,frame,t)   => renderBrailleStarfield(bands,cols,rows,frame,t) },
  { name: "◦ Vortex",    fn: (bands,cols,rows,frame,t)   => renderBrailleVortex(bands,cols,rows,frame,t) },
  { name: "◦ Plasma",    fn: (bands,cols,rows,frame,t)   => renderBraillePlasma(bands,cols,rows,frame,t) },
  { name: "◦ Lissajous", fn: (bands,cols,rows,frame,t,s) => renderBrailleLissajous(bands,cols,rows,frame,t,s) },
  { name: "◦ Spectro",   fn: (bands,cols,rows,frame)     => renderBrailleSpectro(bands,cols,rows,frame) },
  { name: "◦ Circle",    fn: (bands,cols,rows,frame,t)   => renderBrailleCircle(bands,cols,rows,frame,t) },
  { name: "◦ Rain",      fn: (bands,cols,rows,frame,t)   => renderBrailleRain2(bands,cols,rows,frame,t) },
  // ── braille III (15-20) ──
  { name: "◦ Heartbeat", fn: (bands,cols,rows,frame,t)   => renderBrailleHeartbeat(bands,cols,rows,frame,t) },
  { name: "◦ Ripple",    fn: (bands,cols,rows,frame,t)   => renderBrailleRipple(bands,cols,rows,frame,t) },
  { name: "◦ Wave3D",    fn: (bands,cols,rows,frame,t)   => renderBrailleWaveform3D(bands,cols,rows,frame,t) },
  { name: "◦ FracTree",  fn: (bands,cols,rows,frame,t)   => renderBrailleFractalTree(bands,cols,rows,frame,t) },
  { name: "◦ Pendulum",  fn: (bands,cols,rows,frame,t)   => renderBraillePendulum(bands,cols,rows,frame,t) },
  { name: "◦ Terrain",   fn: (bands,cols,rows,frame,t)   => renderBrailleTerrain(bands,cols,rows,frame,t) },
  // ── braille IV (21-25) — push to 100 total ──
  { name: "◦ Spiral",    fn: (bands,cols,rows,frame,t)   => renderBrailleSpiral(bands,cols,rows,frame,t) },
  { name: "◦ Waveform",  fn: (bands,cols,rows,frame,t,s) => renderBrailleWaveformDual(bands,cols,rows,frame,t,s) },
  { name: "◦ Diamonds",  fn: (bands,cols,rows,frame,t)   => renderBrailleDiamonds(bands,cols,rows,frame,t) },
  { name: "◦ Bounce",    fn: (bands,cols,rows,frame,t)   => renderBrailleBounce(bands,cols,rows,frame,t) },
  { name: "◦ Tunnel",    fn: (bands,cols,rows,frame,t)   => renderBrailleTunnel(bands,cols,rows,frame,t) },
  // ── braille V (27) — cliamp-inspired ──
  { name: "◦ Pulse",     fn: (bands,cols,rows,frame,t)   => renderBraillePulse(bands,cols,rows,frame,t) },
];

// ─────────────────────────────────────────────────────────────────────────────
// ASCII MODE — IBM CP437 luminance ramp, full 24-bit color
// ─────────────────────────────────────────────────────────────────────────────

const ASCII_RAMP = ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';
function renderASCII(fb:Uint8Array,fbW:number,fbH:number,cols:number,rows:number):string[]{
  const sx=fbW/cols,sy=fbH/rows,lines:string[]=[];
  for(let row=0;row<rows;row++){let line="";const y=Math.floor(row*sy);for(let col=0;col<cols;col++){const x=Math.floor(col*sx),i=(y*fbW+x)*3,lum=(fb[i]*0.299+fb[i+1]*0.587+fb[i+2]*0.114)/255;line+=`\x1b[38;2;${fb[i]||20};${fb[i+1]||20};${fb[i+2]||20}m${ASCII_RAMP[Math.floor(lum*(ASCII_RAMP.length-1))]}`;}lines.push(line+"\x1b[0m");}return lines;}

// ─────────────────────────────────────────────────────────────────────────────
// HALF-BLOCK RENDERER
// ─────────────────────────────────────────────────────────────────────────────

function renderHalfBlock(fb:Uint8Array,fbW:number,fbH:number,cols:number,rows:number):string[]{
  const lines:string[]=[];const sx=fbW/cols,sy=fbH/(rows*2);
  for(let row=0;row<rows;row++){let line="";const y1=Math.floor(row*2*sy),y2=Math.min(fbH-1,Math.floor((row*2+1)*sy));
    for(let col=0;col<cols;col++){const x=Math.floor(col*sx),i1=(y1*fbW+x)*3,i2=(y2*fbW+x)*3;line+=`\x1b[38;2;${fb[i1]||0};${fb[i1+1]||0};${fb[i1+2]||0}m\x1b[48;2;${fb[i2]||0};${fb[i2+1]||0};${fb[i2+2]||0}m\u2580`;}lines.push(line+"\x1b[0m");}return lines;}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED VIZ HELPERS — used by both FullscreenViz and VizComponent
// ─────────────────────────────────────────────────────────────────────────────

type RenderMode = "halfblock" | "braille" | "ascii";

interface VizState {
  audio: AudioCapture;
  t0: number;
  paused: boolean;
  shaderIdx: number;
  brailleIdx: number;
  mode: RenderMode;
  frame: number;
  sens: number;
  fb: Uint8Array;
  fbW: number;
  fbH: number;
  sBass: number; sMid: number; sTreble: number; sBeat: number;
}

/** Poll mpv IPC for now-playing title every 3s. Returns the interval handle. */
function startTitlePolling(maxLen: number, onTitle: (t: string) => void): ReturnType<typeof setInterval> {
  mpvGetTitle().then(t => { if (t) onTitle(t.slice(0, maxLen)); });
  return setInterval(async () => {
    const t = await mpvGetTitle();
    if (t) onTitle(t.slice(0, maxLen));
  }, 3000);
}

/**
 * Handle a keypress against shared viz state.
 * Returns "quit" | "fullscreen" | null.
 * The caller handles quit/fullscreen transitions — this only mutates state.
 */
function handleKeyCore(key: string, s: VizState): "quit" | "fullscreen" | null {
  if (key === "q" || key === "Q" || key === "\x1b" || key === "\x03") return "quit";
  if (key === " ")           { s.paused = !s.paused; return null; }
  if (key === "f" || key === "F") return "fullscreen";
  if (key === "v" || key === "V") {
    if      (s.mode === "halfblock") s.mode = "braille";
    else if (s.mode === "braille")   s.mode = "ascii";
    else                             s.mode = "halfblock";
    return null;
  }
  if (key === "a" || key === "A") { s.mode = s.mode === "ascii" ? "halfblock" : "ascii"; return null; }
  if (key === "b")  { s.mode = "braille"; s.brailleIdx = (s.brailleIdx + 1) % BRAILLE_SHADERS.length; return null; }
  if (key === "n" || key === "N") {
    if (s.mode === "braille") s.brailleIdx = (s.brailleIdx + 1) % BRAILLE_SHADERS.length;
    else s.shaderIdx = (s.shaderIdx + 1) % SHADERS.length;
    return null;
  }
  if (key === "p" || key === "P") {
    if (s.mode === "braille") s.brailleIdx = (s.brailleIdx - 1 + BRAILLE_SHADERS.length) % BRAILLE_SHADERS.length;
    else s.shaderIdx = (s.shaderIdx - 1 + SHADERS.length) % SHADERS.length;
    return null;
  }
  if (key >= "1" && key <= "9") {
    const idx = parseInt(key) - 1;
    if (idx < SHADERS.length) { s.mode = "halfblock"; s.shaderIdx = idx; }
    return null;
  }
  if (key === "0" && SHADERS.length >= 10) { s.mode = "halfblock"; s.shaderIdx = 9; return null; }
  if (key === "+" || key === "=") { s.sens = Math.min(5, s.sens + 0.2); return null; }
  if (key === "-")                { s.sens = Math.max(0.2, s.sens - 0.2); return null; }
  return null;
}

/**
 * Render one frame into string lines (without footer).
 * Mutates s.fb, s.fbW, s.fbH, s.frame, s.sBass, s.sMid, s.sTreble, s.sBeat.
 */
function renderVizLines(s: VizState, cols: number, rows: number): string[] {
  const fbW = cols, fbH = rows * 2;
  if (s.fbW !== fbW || s.fbH !== fbH) {
    s.fb = new Uint8Array(fbW * fbH * 3);
    s.fbW = fbW; s.fbH = fbH;
  }

  const numBands = 32;
  const time = (Date.now() - s.t0) / 1000;
  let bands: Float32Array;
  let bass = 0, mid = 0, treble = 0;

  if (s.audio.alive) {
    bands = computeBands(tapRead(FFT_SIZE), numBands);
    for (let i = 0; i < bands.length; i++) bands[i] *= s.sens;
    for (let i = 0; i < 4; i++) bass += bands[i]; bass /= 4;
    for (let i = 4; i < 16; i++) mid += bands[i]; mid /= 12;
    for (let i = 16; i < numBands; i++) treble += bands[i]; treble /= (numBands - 16);
    const a = 0.3;
    s.sBass   += (bass   - s.sBass)   * a;
    s.sMid    += (mid    - s.sMid)    * a;
    s.sTreble += (treble - s.sTreble) * a;
    s.sBeat = Math.max(detectBeat(tapRead(FFT_SIZE)), s.sBeat * 0.85);
  } else {
    bands = new Float32Array(numBands);
    for (let i = 0; i < numBands; i++) {
      bands[i] = (Math.sin(time * 2.5 + i * 0.4) * 0.5 + 0.5) * 0.25 * s.sens;
      bands[i] += (Math.sin(time * 1.1 + i * 1.7) * 0.3 + 0.3) * 0.15 * s.sens;
    }
    s.sBass = bands[1]; s.sMid = bands[10]; s.sTreble = bands[25];
    s.sBeat = Math.sin(time * 3.2) > 0.7 ? 0.4 : s.sBeat * 0.85;
  }

  s.frame++;
  const rawSamples = s.audio.alive ? tapRead(FFT_SIZE) : new Float32Array(0);
  const lines: string[] = [];

  if (s.mode === "braille") {
    const str = BRAILLE_SHADERS[s.brailleIdx].fn(bands, cols, rows, s.frame, time, rawSamples);
    lines.push(...str.split("\n"));
  } else {
    SHADERS[s.shaderIdx].fn(s.fb, fbW, fbH, time, bands, s.sBass, s.sMid, s.sTreble, s.sBeat,
      rawSamples.length ? rawSamples : undefined);
    const rawLines = s.mode === "ascii"
      ? renderASCII(s.fb, fbW, fbH, cols, rows)
      : renderHalfBlock(s.fb, fbW, fbH, cols, rows);
    lines.push(...rawLines);
  }
  return lines;
}

/** Build the shared part of the footer (source + pause + mode + name + beat). */
function vizFooterBase(s: VizState, nowPlaying: string): string {
  const src      = s.audio.alive ? (s.audio.source === "mpv" ? "\x1b[32m♫ mpv\x1b[0m" : "\x1b[32m● mic\x1b[0m") : "\x1b[33m◌ demo\x1b[0m";
  const paused   = s.paused ? " \x1b[31m❚❚\x1b[0m" : "";
  const modeTag  = s.mode === "ascii" ? "\x1b[33m[ASCII]\x1b[0m" : s.mode === "braille" ? "\x1b[36m[Braille]\x1b[0m" : "";
  const name     = s.mode === "braille" ? BRAILLE_SHADERS[s.brailleIdx].name : SHADERS[s.shaderIdx].name;
  const beatBar  = s.sBeat > 0.1 ? "\x1b[31m" + "█".repeat(Math.floor(s.sBeat * 6)) + "\x1b[0m" : "";
  const np       = nowPlaying ? ` \x1b[2m♪ ${nowPlaying}\x1b[0m` : "";
  return ` ${src}${paused} ${modeTag} ${name} ${beatBar}${np}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// FULLSCREEN MODE — raw terminal, no TUI chrome
// Writes directly to process.stdout using alt-screen + cursor hide
// ─────────────────────────────────────────────────────────────────────────────

class FullscreenViz {
  private s: VizState = {
    audio: startAudioCapture(), t0: Date.now(), paused: false,
    shaderIdx: 0, brailleIdx: 0, mode: "halfblock", frame: 0, sens: 1.0,
    fb: new Uint8Array(0), fbW: 0, fbH: 0, sBass: 0, sMid: 0, sTreble: 0, sBeat: 0,
  };
  private nowPlaying = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private titleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private onExit: () => void) {
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (key: string) => this.handleKey(key));
    }
    this.titleTimer = startTitlePolling(60, t => { this.nowPlaying = t; });
    this.timer = setInterval(() => { if (!this.s.paused) this.renderFrame(); }, 33);
  }

  private handleKey(key: string): void {
    const action = handleKeyCore(key, this.s);
    if (action === "quit" || action === "fullscreen") this.cleanup(); // F exits fullscreen too
  }

  private renderFrame(): void {
    const cols = process.stdout.columns || 80;
    const rows = (process.stdout.rows || 24) - 1;
    const lines = renderVizLines(this.s, cols, rows);
    const footer = vizFooterBase(this.s, this.nowPlaying) + "\x1b[2m | N/P  v  a  b  +-  F=exit\x1b[0m";
    process.stdout.write("\x1b[H" + lines.join("\n") + "\n" + footer.slice(0, cols * 6) + "\x1b[K");
  }

  private cleanup(): void {
    if (this.timer)       { clearInterval(this.timer);      this.timer = null; }
    if (this.titleTimer)  { clearInterval(this.titleTimer); this.titleTimer = null; }
    if (this.s.audio.proc) { try { this.s.audio.proc.kill(); } catch {} }
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} process.stdin.pause(); }
    process.stdout.write("\x1b[?1049l\x1b[?25h");
    this.onExit();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TUI COMPONENT (embedded in pi — no fullscreen)
// ─────────────────────────────────────────────────────────────────────────────

class VizComponent implements Component {
  private s: VizState = {
    audio: startAudioCapture(), t0: Date.now(), paused: false,
    shaderIdx: 0, brailleIdx: 0, mode: "halfblock", frame: 0, sens: 1.0,
    fb: new Uint8Array(0), fbW: 0, fbH: 0, sBass: 0, sMid: 0, sTreble: 0, sBeat: 0,
  };
  private nowPlaying = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private titleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private tui: TUI, private done: (v: undefined) => void) {
    this.timer = setInterval(() => { if (!this.s.paused) this.tui.requestRender(); }, 33);
    this.titleTimer = startTitlePolling(50, t => { this.nowPlaying = t; });
  }

  handleInput(data: string): void {
    const action = handleKeyCore(data, this.s);
    if (action === "quit") { this.cleanup(); this.done(undefined); return; }
    if (action === "fullscreen") {
      this.cleanup();
      this.done(undefined);
      setTimeout(() => new FullscreenViz(() => {}), 100);
    }
  }

  render(width: number): string[] {
    const cols = Math.max(1, width - 1);
    const rows = Math.max(6, this.tui.terminal.rows - 3);
    const lines = renderVizLines(this.s, cols, rows).map(l => truncateToWidth(l, width));
    const footer = vizFooterBase(this.s, this.nowPlaying) + "\x1b[2m | N/P v a b +- F=full Q=quit\x1b[0m";
    lines.push(truncateToWidth(footer, width));
    return lines;
  }

  invalidate(): void {}

  private cleanup(): void {
    if (this.timer)      { clearInterval(this.timer);      this.timer = null; }
    if (this.titleTimer) { clearInterval(this.titleTimer); this.titleTimer = null; }
    if (this.s.audio.proc) { try { this.s.audio.proc.kill(); } catch {} }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTENSION
// ─────────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("viz", {
    description: [
      "Terminal audio-reactive visualizer. Reacts to mpv (pi-dj) or mic.",
      "52 half-block shaders (16 ✦ art pieces) + 14 braille shaders + ASCII mode = 67 visualizer modes.",
      "Keys: N/P=shader  v=mode  a=ascii  b=braille  1-9 0=jump  +-=sens  F=fullscreen  Q=quit",
      "Usage: /viz        — embedded in pi TUI",
      "       /viz full   — fullscreen alt-screen mode",
    ].join("\n"),
    handler: async (args, ctx) => {
      const fullscreen = args?.trim().toLowerCase() === "full";
      if (fullscreen) {
        // Launch fullscreen directly — exits pi TUI, takes over terminal
        await new Promise<void>(resolve => {
          new FullscreenViz(() => resolve());
        });
      } else {
        await ctx.ui.custom<undefined>((tui, _theme, _keybindings, done) => {
          return new VizComponent(tui, done);
        });
      }
    },
  });

  pi.registerCommand("djvj", {
    description: "Launch cliamp + terminal visualizer. /djvj [path]",
    handler: async (args, ctx) => {
      const target = args?.trim() || (process.env.USERPROFILE || HOME) + "/Music";
      ctx.ui.notify("🎵 Launching cliamp...", "info");
      pi.sendUserMessage(
        `Play music with cliamp for: ${target}. After launching, tell the user to type /viz to open the visualizer (or /viz full for fullscreen).`,
      );
    },
  });
}
