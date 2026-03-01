import { AbsoluteFill, Audio, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';

// Waveform bars that pulse to music
function WaveformBars({ numBars = 64 }) {
  const frame = useCurrentFrame();
  const bars = Array.from({ length: numBars });

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 3,
      height: '100%',
      width: '100%',
    }}>
      {bars.map((_, i) => {
        const offset = i * 0.4;
        const height = interpolate(
          Math.sin((frame * 0.15) + offset) + Math.sin((frame * 0.08) + offset * 1.3),
          [-2, 2],
          [8, 200]
        );
        const hue = (i / numBars) * 60 + 200; // blue → purple
        return (
          <div key={i} style={{
            width: 8,
            height,
            borderRadius: 4,
            background: `hsl(${hue}, 80%, 60%)`,
            opacity: 0.85,
            transition: 'height 0.05s',
          }} />
        );
      })}
    </div>
  );
}

// Floating particles
function Particles() {
  const frame = useCurrentFrame();
  const particles = Array.from({ length: 20 });

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {particles.map((_, i) => {
        const seed = i * 137.5;
        const x = ((seed * 13.7) % 100);
        const y = ((frame * (0.1 + (i % 5) * 0.05) + seed) % 110) - 10;
        const size = 4 + (i % 6) * 3;
        const opacity = interpolate(y, [0, 100], [0.8, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return (
          <div key={i} style={{
            position: 'absolute',
            left: `${x}%`,
            top: `${y}%`,
            width: size,
            height: size,
            borderRadius: '50%',
            background: `hsl(${(seed * 7) % 360}, 70%, 70%)`,
            opacity,
          }} />
        );
      })}
    </div>
  );
}

export function MusicVideo({ title, artist, genre, audioFile, coverImage }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: 'clamp' });
  const titleY = interpolate(frame, [0, 30], [40, 0], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{
      background: 'linear-gradient(135deg, #0a0a0f 0%, #0d0820 50%, #0a0a0f 100%)',
      fontFamily: 'monospace',
    }}>
      {/* Particles */}
      <Particles />

      {/* Cover art glow */}
      {coverImage && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 500,
          height: 500,
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 0 120px rgba(120, 80, 255, 0.4)',
          opacity: 0.15,
        }}>
          <img src={coverImage} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
      )}

      {/* Waveform */}
      <div style={{
        position: 'absolute',
        bottom: 160,
        left: 60,
        right: 60,
        height: 200,
        opacity: 0.7,
      }}>
        <WaveformBars numBars={80} />
      </div>

      {/* Title block */}
      <div style={{
        position: 'absolute',
        top: '50%',
        left: 60,
        transform: `translateY(calc(-50% + ${titleY}px))`,
        opacity: titleOpacity,
      }}>
        <div style={{
          fontSize: 13,
          color: '#7b6cf0',
          letterSpacing: 6,
          textTransform: 'uppercase',
          marginBottom: 12,
        }}>{genre}</div>
        <div style={{
          fontSize: 72,
          fontWeight: 900,
          color: '#fff',
          lineHeight: 1,
          marginBottom: 16,
          textShadow: '0 0 40px rgba(120, 80, 255, 0.6)',
        }}>{title}</div>
        <div style={{
          fontSize: 24,
          color: '#888',
          letterSpacing: 2,
        }}>{artist}</div>
      </div>

      {/* dj-piguy.com watermark */}
      <div style={{
        position: 'absolute',
        bottom: 40,
        right: 60,
        fontSize: 14,
        color: '#333',
        letterSpacing: 3,
        textTransform: 'uppercase',
      }}>dj-piguy.com</div>

      {/* Audio */}
      {audioFile && <Audio src={audioFile} />}
    </AbsoluteFill>
  );
}
