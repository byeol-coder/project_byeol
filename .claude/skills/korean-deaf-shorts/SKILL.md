---
name: korean-deaf-shorts
description: Build, extend or run the 보이는 말 / BONEUN MAL Korean Sign Language Shorts pipeline in boneun-mal-shorts/. Use whenever the task involves KSL (한국수어) content, KCISA 수어 OpenAPI data, Korean Deaf culture shorts, verified sign clips, the 9:16 renderer, ko/en captions, the publish gate, or YouTube upload for this brand. Enforces the fixed order API → KSL → topic → script → video → QA and the rule that sign language is never AI-generated.
---

# Korean Deaf Culture × KSL Shorts

Project root: `boneun-mal-shorts/`. Read its `CLAUDE.md` first — the rules there
outrank anything convenient.

## The one rule that overrides everything else

Korean Sign Language is never invented, never AI-generated, never approximated.
The KCISA / 문화체육관광부 한국수어 OpenAPI is the authoritative reference, and the
signing a viewer sees is always a recording of a real, consenting human from
`assets/ksl/` with `verified: true`.

If the data or the clip is missing, the correct output is a stopped pipeline and a
report saying what is needed — not a finished-looking video. Waiting for a real
KSL asset always beats shipping a plausible fake.

## Fixed working order

Never reorder these, and never skip ahead to the fun part.

```
1. API 확인    — is KCISA_SERVICE_KEY present, is the endpoint answering?
2. KSL 확인    — does the sign exist in KCISA, and is there a verified human clip?
3. 소재 선정   — pick the topic + series (rotation, priority, recency)
4. 대본        — assemble ko/en copy from human-authored seeds
5. 영상        — timeline → subtitles → FFmpeg 9:16 render
6. QA          — ffprobe checks, KSL verification report, publish gate
```

Step 2 gates steps 3–6. A script written before the sign is verified is wasted
work at best and a source of fake KSL at worst.

## How to run it

```bash
cd boneun-mal-shorts
npm install
npm run doctor                      # node / ffmpeg / ffprobe / font / .env check
npm run ksl:probe -- "커피"          # dump the RAW KCISA response (schema check)
npm run ksl:search -- "커피"         # normalised search results
npm run ksl:library                 # what verified clips exist right now
npm run shorts -- --topic "커피"     # full pipeline
npm run shorts:random               # pipeline, topic chosen by rotation
npm run shorts:preview              # render with placeholders when a clip is missing
npm run verify -- output/<dir>      # re-run QA on an existing output
npm run youtube:upload -- output/<dir>   # private upload, gated on PUBLISH_READY
```

## When extending the code

* `src/api/kcisa.ts` — the only place that talks to KCISA. Timeouts, bounded
  retries, JSON **and** XML handling, disk cache, raw-response logging. On any
  failure it returns a `KSL_DATA_UNAVAILABLE` result; it must never manufacture a
  record. If the live response shape differs from the adapter's field candidates,
  run `ksl:probe`, read the saved raw payload, and extend
  `src/ksl/normalize.ts` — do not guess.
* `src/ksl/matcher.ts` / `verifier.ts` — decide `VERIFIED` vs
  `NEEDS_KSL_RECORDING`. Never widen these to accept AI-generated or
  unconsented material, and never let a missing sidecar count as verified.
* `src/content/generateContent.ts` — assembles copy from `data/topics.json`
  seeds. Keep sentences short and dry. The banned-phrase guard is a feature; if
  it trips, rewrite the copy, don't relax the list.
* `src/video/renderShort.ts` — nothing may be drawn inside
  `config/video.json → signingSpace` on a signing segment, and burn-in text stays
  inside `safeArea`. Both constraints are asserted before rendering.
* `scripts/verify-output.ts` — the publish gate. Adding an output field means
  adding its check here too.

## Reporting back

Lead with results, not with a development narrative:

```
✅ 완료된 것
⚠️ 추가로 필요한 것
▶ 실행 방법
📁 결과물 위치
```

Then give the real paths to `shorts.mp4`, the thumbnail, the captions and
`verification-report.md`. Say plainly whether `PUBLISH_READY` is true or false and
what is blocking it.
