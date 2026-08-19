# Verification report — 커피

보이는 말 · BONEUN MAL — Korean Sign Language · Deaf Culture · Korea

## KSL provenance

```
KSL Source: NONE
KSL API Match: FAIL
Verified Human Clip: NO
```

**Not publishable.** No verified human recording exists for the sign(s) below. No AI-generated signing was substituted — the sign must be recorded with a real signer first.

| Sign | KCISA match | Clip | Status |
| --- | --- | --- | --- |
| 커피 | FAIL | — | NEEDS_KSL_RECORDING |

### What is missing

```
· 커피: KCISA lookup unavailable (MISSING_SERVICE_KEY): KCISA_SERVICE_KEY is not set. Add it to .env (see .env.example). No sign language data is invented in its absence.
```

## Video QA

| Check | Result | Detail |
| --- | --- | --- |
| resolution | ✅ PASS | 1080×1920 |
| aspect ratio | ✅ PASS | 9:16 (SAR 1:1) |
| frame rate | ✅ PASS | 30fps |
| duration | ✅ PASS | 22.00s (allowed 15–45s) |
| audio track | ✅ PASS | aac present |
| video codec | ✅ PASS | h264 |
| audio codec | ✅ PASS | aac |
| black frames | ✅ PASS | none ≥0.4s |
| KSL API source | ❌ FAIL | no KCISA lookup is recorded for this video |
| KCISA sign match | ❌ FAIL | at least one sign has no KCISA entry |
| verified human KSL clip | ❌ FAIL | no verified human clip — publishing is blocked. Record the sign; never generate it. |
| Korean captions | ✅ PASS | 6 cue(s) |
| English captions | ✅ PASS | 6 cue(s) |
| subtitle safe area | ✅ PASS | burn-in occupies 1425–1572px: below the signing space (ends 1420px) and above the Shorts UI reserve (starts 1580px) |
| output files | ✅ PASS | 7 file(s) present |
| metadata | ✅ PASS | "한국수어로 "커피" 🤟 \| KSL" |
| copyright check | ✅ PASS | no music track — nothing to clear |
| commercial disclosure | ➖ SKIP | not commercial content |
| tone guard | ✅ PASS | no generalising claims about Deaf people |
| brand ending | ✅ PASS | 보이는 말 / BONEUN MAL |

## Publish gate

```
PUBLISH_READY=false
```

Blocked by:

1. KSL API source: no KCISA lookup is recorded for this video
1. KCISA sign match: at least one sign has no KCISA entry
1. verified human KSL clip: no verified human clip — publishing is blocked. Record the sign; never generate it.

## Video

- Mode: `preview`
- Series: K-SIGN
- Structure: question-answer
- Duration: 22.00s
- Created: 2026-08-19T01:23:09.173Z
- Title: 한국수어로 "커피" 🤟 | KSL

## Files

- `video` → `shorts.mp4`
- `thumbnail` → `thumbnail.jpg`
- `metadata` → `metadata.json`
- `script.ko` → `script.ko.txt`
- `script.en` → `script.en.txt`
- `captions.ko` → `captions.ko.srt`
- `captions.en` → `captions.en.srt`
- `report` → `verification-report.md`
