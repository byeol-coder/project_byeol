# assets/music — cleared music only

lo-fi / minimal / ambient / subtle beat / Korean indie-inspired. Quiet enough
that the video still reads with the sound off — these are sign language videos,
they are **visual first**.

A track is only used when a sidecar proves the rights:

```json
{
  "title": "track name",
  "artist": "artist",
  "license": "CC-BY 4.0 | purchased license | commissioned | public domain",
  "licenseUrl": "https://…",
  "attributionRequired": true,
  "attributionText": "text to include in the video description",
  "copyrightCleared": true
}
```

No sidecar, or `copyrightCleared: false` → the track is skipped and the
copyright check in the publish gate fails. Music is optional; silence is fine.
