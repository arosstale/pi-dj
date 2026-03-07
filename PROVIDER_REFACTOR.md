# pi-dj Provider Refactor Plan

## Current State
7 playback sources mixed flat in 1,251 lines. No shared interface.

## Target Architecture (cliamp-inspired)

```typescript
interface Provider {
  name: string;
  canHandle(uri: string): boolean;      // Can this provider play this URI?
  play(uri: string, ctx: any): Promise<void>;
  search?(query: string): Promise<Track[]>;
  stop?(): void;
}

class CompositeProvider implements Provider {
  providers: Provider[];
  // Routes to first provider that canHandle()
}
```

## Providers to Extract

| Provider | Source | canHandle pattern |
|----------|--------|-------------------|
| LocalProvider | cliamp | file paths, directories |
| YouTubeProvider | mpv + yt-dlp | youtube.com, youtu.be URLs |
| RadioProvider | Radio Browser API | `radio:` prefix, station names |
| SoundCloudProvider | scdl | soundcloud.com URLs |
| BandcampProvider | yt-dlp | bandcamp.com URLs |
| BandlabProvider | fetch | bandlab.com URLs |
| LyriaProvider | cliamp | `lyria:` prefix |
| SunoProvider | API | `suno:` prefix |

## Migration Plan
1. Define Provider interface + CompositeProvider
2. Extract one provider at a time (start with RadioProvider — self-contained)
3. Replace direct calls with `composite.play(uri, ctx)`
4. Keep all 22 commands — just route through providers internally

## Not Now
- This is a refactor, not a feature add
- No new providers until the interface exists
- Estimated: 2-3 sessions of focused work
