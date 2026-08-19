# Sample output — PREVIEW, not publishable

A committed copy of one `output/` folder so the repo shows what the pipeline
produces. Everything under `output/` is git-ignored and regenerable; this copy
is here for reference only.

Rendered with:

```bash
npm run shorts:preview -- --topic "커피"
```

`PUBLISH_READY=false`, on purpose, for two reasons recorded in
`verification-report.md`:

1. **No `KCISA_SERVICE_KEY`** was available, so the sign could not be confirmed
   against the 문화체육관광부 · KCISA 한국수어 OpenAPI. (In the session that built
   this, `api.kcisa.kr` was also blocked by network policy.)
2. **No verified human KSL clip** exists in `assets/ksl/` yet.

So the signing beat renders a `[ VERIFIED KSL CLIP REQUIRED ]` placeholder card.
No hand motion was generated, imitated or approximated to fill the gap — that is
the whole point. Add the key and a real recording, run `npm run shorts`, and the
same topic renders a publishable video.

What this sample does demonstrate end to end: topic selection, ko/en copy
assembly, the 22s timeline, 1080×1920 · 30fps · H.264/AAC encoding, burn-in
placement below the signing space, both SRT sidecars, YouTube metadata, and the
QA gate correctly refusing to pass.
