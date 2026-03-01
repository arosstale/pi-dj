import { Composition, registerRoot } from 'remotion';
import { MusicVideo } from './MusicVideo';

export const RemotionRoot = () => (
  <>
    <Composition
      id="MusicVideo"
      component={MusicVideo}
      durationInFrames={300}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{
        title: 'Grain In My Chest',
        artist: '71tick',
        genre: 'Trap Soul',
        audioFile: null,
        coverImage: null,
      }}
    />
  </>
);

registerRoot(RemotionRoot);
