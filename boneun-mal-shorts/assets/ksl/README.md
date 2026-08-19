# assets/ksl — verified Korean Sign Language clips

**Nothing in this folder may be AI-generated.**

Every clip here is a recording of a real human signing Korean Sign Language.
No AI avatar, no diffusion video, no "plausible hand motion". If a clip is
missing, the pipeline reports `NEEDS_KSL_RECORDING` and refuses to publish —
that is the intended behaviour, not a bug to work around.

## File layout

```
assets/ksl/
  감사.mp4        ← the clip
  감사.json       ← its metadata sidecar (required)
```

The filename stem must be the Korean word/phrase exactly as it is signed
(`맛있다.mp4`), or an ASCII slug with the word declared in the sidecar.

## Metadata sidecar (required)

```json
{
  "word": "감사",
  "wordEn": "thank you",
  "verified": true,
  "source": "human-recorded",
  "language": "KSL",
  "signer": "credited name or role",
  "consent": "on file",
  "recordedAt": "2026-08-01",
  "framing": "face + upper body + both hands visible",
  "kcisaId": "optional KCISA record id this clip corresponds to",
  "notes": ""
}
```

`verified: true` requires **all** of:

1. `source` is `human-recorded` (or another human-authored, rights-cleared origin),
2. face, upper body and both hands stay in frame for the whole sign,
3. the sign matches the KCISA / 문화체육관광부 reference for that word,
4. the signer consented to publication.

Set `verified: false` (or leave the sidecar out) and the clip is treated as
absent. `npm run ksl:library` prints the current state of this folder.

## Recording notes

* Vertical 9:16 preferred; the renderer will pillarbox/crop otherwise but
  never crops into the signing space.
* Plain, non-busy background. Natural light. No text or graphics baked in.
* Leave ~0.4s of stillness before and after the sign so the edit can breathe.
