import {
  AbsoluteFill,
  Audio,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from 'remotion';
import { useAudioData, visualizeAudio, visualizeAudioWaveform } from '@remotion/media-utils';

// ── Styles ─────────────────────────────────────────────────────────────────

function BarsVisualizer({ audioData, numBars = 80 }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const samples = audioData
    ? visualizeAudio({ audioData, frame, fps, numberOfSamples: numBars, smoothing: true })
    : Array.from({ length: numBars }, (_, i) =>
        0.1 + 0.15 * Math.abs(Math.sin(frame * 0.1 + i * 0.4))
      );

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'center',
      gap: 3,
      height: '100%',
      width: '100%',
      paddingBottom: 4,
    }}>
      {samples.map((v, i) => {
        const height = Math.max(4, v * 260);
        const hue = 220 + (i / numBars) * 80; // blue → violet
        return (
          <div key={i} style={{
            width: 8,
            height,
            borderRadius: '4px 4px 2px 2px',
            background: `hsl(${hue}, 75%, ${50 + v * 20}%)`,
            opacity: 0.88,
          }} />
        );
      })}
    </div>
  );
}

function WaveVisualizer({ audioData, numSamples = 300 }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const samples = audioData
    ? visualizeAudioWaveform({ audioData, frame, fps, windowInSeconds: 1 / 30, numberOfSamples: numSamples, normalize: true })
    : Array.from({ length: numSamples }, (_, i) =>
        Math.sin(frame * 0.08 + i * 0.1) * 0.5
      );

  const pts = samples.map((v, i) => {
    const x = (i / (numSamples - 1)) * width;
    const y = height / 2 + v * (height * 0.28);
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
      <defs>
        <linearGradient id="wg" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#4466ff" />
          <stop offset="50%" stopColor="#aa44ff" />
          <stop offset="100%" stopColor="#4466ff" />
        </linearGradient>
      </defs>
      <polyline
        points={pts}
        fill="none"
        stroke="url(#wg)"
        strokeWidth={2.5}
        strokeLinecap="round"
        opacity={0.85}
      />
    </svg>
  );
}

function CircleVisualizer({ audioData, numBars = 120 }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const cx = width / 2;
  const cy = height / 2;
  const baseR = 180;

  const samples = audioData
    ? visualizeAudio({ audioData, frame, fps, numberOfSamples: numBars, smoothing: true })
    : Array.from({ length: numBars }, (_, i) =>
        0.1 + 0.2 * Math.abs(Math.sin(frame * 0.08 + i * 0.25))
      );

  const bars = samples.map((v, i) => {
    const angle = (i / numBars) * Math.PI * 2 - Math.PI / 2;
    const barLen = 20 + v * 140;
    const x1 = cx + Math.cos(angle) * baseR;
    const y1 = cy + Math.sin(angle) * baseR;
    const x2 = cx + Math.cos(angle) * (baseR + barLen);
    const y2 = cy + Math.sin(angle) * (baseR + barLen);
    const hue = (i / numBars) * 300 + 200;
    return { x1, y1, x2, y2, hue, v };
  });

  return (
    <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
      {bars.map(({ x1, y1, x2, y2, hue, v }, i) => (
        <line key={i}
          x1={x1} y1={y1} x2={x2} y2={y2}
          stroke={`hsl(${hue}, 80%, ${50 + v * 25}%)`}
          strokeWidth={2.5}
          strokeLinecap="round"
          opacity={0.82}
        />
      ))}
      {/* Center circle */}
      <circle cx={cx} cy={cy} r={baseR - 2} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
    </svg>
  );
}

// ── Particles (background) ─────────────────────────────────────────────────
function Particles({ count = 18 }) {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      {Array.from({ length: count }, (_, i) => {
        const seed = i * 137.5;
        const x = (seed * 13.7) % 100;
        const y = ((frame * (0.06 + (i % 5) * 0.04) + seed) % 110) - 10;
        const size = 3 + (i % 6) * 2.5;
        const opacity = interpolate(y, [0, 100], [0.6, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return (
          <div key={i} style={{
            position: 'absolute',
            left: `${x}%`, top: `${y}%`,
            width: size, height: size,
            borderRadius: '50%',
            background: `hsl(${(seed * 7) % 360}, 65%, 68%)`,
            opacity,
          }} />
        );
      })}
    </div>
  );
}

// ── Main composition ────────────────────────────────────────────────────────
export function MusicVideo({ title, artist, genre, style = 'bars', audioSrc, coverSrc }) {
  const frame = useCurrentFrame();
  const audioData = audioSrc ? useAudioData(audioSrc) : null;

  const titleOpacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: 'clamp' });
  const titleY       = interpolate(frame, [0, 30], [30, 0], { extrapolateRight: 'clamp' });

  const vizHeight = style === 'wave' ? '100%' : style === 'circle' ? '100%' : 220;
  const vizBottom = style === 'bars' ? 140 : undefined;

  return (
    <AbsoluteFill style={{
      background: 'linear-gradient(145deg, #080810 0%, #0e0820 55%, #080810 100%)',
      fontFamily: '"SF Mono", "Fira Code", monospace',
      overflow: 'hidden',
    }}>
      <Particles />

      {/* Cover glow behind */}
      {coverSrc && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 460, height: 460,
          borderRadius: 20, overflow: 'hidden',
          boxShadow: '0 0 140px rgba(110,70,255,0.35)',
          opacity: style === 'circle' ? 0.08 : 0.12,
        }}>
          <img src={coverSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
      )}

      {/* Visualizer */}
      {style === 'bars' && (
        <div style={{ position: 'absolute', bottom: vizBottom, left: 40, right: 40, height: vizHeight }}>
          <BarsVisualizer audioData={audioData} />
        </div>
      )}
      {style === 'wave' && <WaveVisualizer audioData={audioData} />}
      {style === 'circle' && <CircleVisualizer audioData={audioData} />}

      {/* Title block */}
      <div style={{
        position: 'absolute',
        top: style === 'circle' ? 60 : '50%',
        left: 60,
        transform: style === 'circle' ? undefined : `translateY(calc(-50% + ${titleY}px))`,
        opacity: titleOpacity,
        zIndex: 10,
      }}>
        {genre && (
          <div style={{
            fontSize: 11, color: '#6655cc',
            letterSpacing: 5, textTransform: 'uppercase', marginBottom: 10,
          }}>{genre}</div>
        )}
        <div style={{
          fontSize: style === 'circle' ? 52 : 64,
          fontWeight: 900, color: '#ffffff', lineHeight: 1.05,
          marginBottom: 14,
          textShadow: '0 0 50px rgba(110,70,255,0.5)',
          maxWidth: 600,
        }}>{title}</div>
        <div style={{ fontSize: 20, color: '#666677', letterSpacing: 2 }}>{artist}</div>
      </div>

      {/* Watermark */}
      <div style={{
        position: 'absolute', bottom: 32, right: 48,
        fontSize: 12, color: '#222233',
        letterSpacing: 3, textTransform: 'uppercase',
      }}>dj-piguy.com</div>

      {/* Audio track */}
      {audioSrc && <Audio src={audioSrc} />}
    </AbsoluteFill>
  );
}
