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
// HALF-BLOCK SHADERS (16 total)
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

const BRAILLE_SHADERS: { name: string; fn: BrailleShaderFn }[] = [
  { name: "◦ Bars",    fn: (bands,cols,rows)           => renderBrailleBars(bands,cols,rows) },
  { name: "◦ Columns", fn: (bands,cols,rows)           => renderBrailleColumns(bands,cols,rows) },
  { name: "◦ Wave",    fn: (bands,cols,rows,_f,_t,s)   => renderBrailleWave(s,cols,rows,bands) },
  { name: "◦ Scatter", fn: (bands,cols,rows,frame)     => renderBrailleScatter(bands,cols,rows,frame) },
  { name: "◦ Flame",   fn: (bands,cols,rows,frame,t)   => renderBrailleFlame(bands,cols,rows,frame,t) },
  { name: "◦ Rings",   fn: (bands,cols,rows,_f,t)      => renderBrailleRings(bands,cols,rows,t) },
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
      "16 half-block shaders + 6 braille modes + ASCII mode.",
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
