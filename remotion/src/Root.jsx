import { Composition, registerRoot } from 'remotion';
import { MusicVideo } from './MusicVideo';

// durationInFrames and fps overridden at render time from audio duration
export const RemotionRoot = () => (
  <>
    <Composition
      id="MusicVideo"
      component={MusicVideo}
      durationInFrames={900}
      fps={30}
      width={1080}
      height={1080}
      defaultProps={{
        title: 'Track Title',
        artist: 'DJ PiGuy',
        genre: 'Electronic',
        style: 'bars',
        audioSrc: null,
        coverSrc: null,
      }}
    />
  </>
);

registerRoot(RemotionRoot);
