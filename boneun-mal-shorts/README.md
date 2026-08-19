# 보이는 말 · BONEUN MAL

**Korean Sign Language · Deaf Culture · Korea**

A production pipeline for a Korean Deaf culture YouTube Shorts channel: it picks
a topic, confirms the sign against the 문화체육관광부 · KCISA 한국수어 OpenAPI, cuts a
9:16 short around a **human-recorded** KSL clip, writes Korean and English
captions and YouTube metadata, runs QA, and stages a private upload.

It is not an AI shorts factory. AI is backstage: it fetches data, assembles copy
from human-authored lines, cuts video and checks output. It never performs the
sign language.

---

## The rule the whole thing is built around

```
Never invent Korean Sign Language.
```

* The reference for every sign is KCISA / 문화체육관광부 (`getCTE01701`). Nothing else.
* The signing on screen is always a recording of a real, consenting person from
  `assets/ksl/`.
* No API key, or the API unreachable → `KSL_DATA_UNAVAILABLE`, and the run stops.
  Nothing is fabricated to keep the pipeline moving.
* No verified clip for a needed sign → `NEEDS_KSL_RECORDING`. You can swap the
  script to a sign you *do* have, or render a preview with a
  `[ VERIFIED KSL CLIP REQUIRED ]` placeholder. There is no third option.
* `PUBLISH_READY=false` blocks upload, and the gate has no override.

Leaving a deliverable unfinished while waiting for a real KSL recording is the
intended outcome. A plausible-looking fake is not.

See `CLAUDE.md` for the full working rules.

---

## Quick start

```bash
cd boneun-mal-shorts
npm install
npm run doctor          # node / ffmpeg / ffprobe / Korean font / .env / assets
npm run selftest        # 60 checks on the guards, the adapter and the renderer

cp .env.example .env    # then paste KCISA_SERVICE_KEY into it
```

Requirements: **Node ≥ 20**, **FFmpeg + ffprobe** on PATH, and a Korean-capable
font (`fonts-noto-cjk`, Apple SD Gothic Neo, or Malgun Gothic — or point
`KOREAN_FONT_FILE` at one). `npm run doctor` tells you which of these is missing.

## Commands

```bash
npm run ksl:probe -- "커피"        # dump the RAW KCISA response + show the field mapping
npm run ksl:search -- "커피"       # normalised search results
npm run ksl:library               # which signs are recorded, and which are still needed

npm run shorts                    # pick a topic by rotation and render
npm run shorts -- --topic "커피"   # a specific topic
npm run shorts -- --series K-SIGN # restrict to one series
npm run shorts:random             # weighted-random topic
npm run shorts:preview            # render with placeholders where a clip is missing

npm run verify                    # re-run QA on the newest output folder
npm run youtube:upload            # private upload, gated on PUBLISH_READY
npm run typecheck
```

## What a run produces

```
output/YYYY-MM-DD-topic/
├─ shorts.mp4              1080×1920 · 30fps · H.264/AAC
├─ thumbnail.jpg           a frame from the signing moment
├─ metadata.json           full manifest: script, KSL provenance, QA, YouTube fields
├─ script.ko.txt
├─ script.en.txt
├─ captions.ko.srt
├─ captions.en.srt
└─ verification-report.md  KSL provenance + QA table + the publish gate
```

`samples/2026-08-19-커피-preview/` is a committed example. It is deliberately
`PUBLISH_READY=false` — read its `NOTE.md`.

## Pipeline

```
[1/9] Checking environment        node · ffmpeg · font · KCISA key
[2/9] Selecting topic             unused + priority + recency + series mix
[3/9] Querying KCISA KSL          the authoritative reference, or a hard stop
[4/9] Matching verified KSL clip  VERIFIED / NEEDS_KSL_RECORDING
[5/9] Building script             ko + en copy from human-authored seeds
[6/9] Building timeline           hook · context · sign · point · brand ending
[7/9] Creating captions           ko + en SRT, plus minimal burn-in
[8/9] Rendering Shorts            one FFmpeg pass, 9:16
[9/9] Verifying output            20 checks → PUBLISH_READY
```

Step 3 gates everything after it. Writing a script before the sign is verified is
wasted work at best.

## Series mix

| Series | Share | What it is |
| --- | --- | --- |
| `K-SIGN` | 40% | Everyday Korean life, food and slang, connected to KSL |
| `DEAF PICK` | 25% | Products, apps and features that genuinely help Deaf / HoH people |
| `DEAF PERKS` | 20% | One concrete situation where signing simply works better |
| `SIGN KOREA` | 15% | Place-based KSL across Korea — not Seoul only |

Selection pulls the recent mix back toward these shares, blocks a topic repeat
inside 30 days, and won't run the same series more than twice in a row.
`DEAF PICK` writes a disclosure into the metadata and description automatically
whenever a topic is marked commercial or affiliate.

## Frame rules, enforced in code

* **The signing space is untouchable.** On a segment showing a signer, nothing —
  subtitle, CTA, logo, graphic — may be drawn between y=300 and y=1420. The
  renderer throws rather than cover a hand.
* **KSL clips are fitted, never cropped.** A crop can amputate part of the sign,
  so signing footage letterboxes onto the canvas. B-roll may be cropped to fill.
* **Burn-in lives in a proven band** between the signing space and the Shorts UI
  reserve (1425–1572px as configured), Korean large and English small beneath.
  A config change that would break this fails the render, not the video.
* **Face and upper body stay in frame.** Expression is grammar, not decoration.
* Both SRT sidecars are always written; burn-in stays short.

## Layout

```
config/          brand.json (names, colours, type) · video.json (canvas, safe areas, encode) · content.json (series, banned phrases, hashtags)
data/            topics.json (human-authored seeds) · sign-glosses.json · ksl-cache.json · performance.json · render-history.json
assets/ksl/      verified human KSL clips + metadata sidecars   ← the one folder that gates publishing
assets/broll/    real places: seoul cafe subway hanriver street food travel
assets/music/    rights-cleared tracks only (sidecar proves it)
src/api/         kcisa.ts — the only module that talks to KCISA
src/ksl/         normalize.ts (response adapter) · matcher.ts · verifier.ts
src/content/     selectTopic.ts · generateContent.ts
src/video/       timeline.ts · subtitle.ts · renderShort.ts · assets.ts
src/youtube/     metadata.ts · upload.ts
src/qa/          verify.ts — the checks and the publish gate
scripts/         doctor · selftest · ksl-probe · ksl-search · ksl-library · verify-output · publish
```

## Adding a sign

1. Record a real signer. Vertical if possible, plain background, natural light,
   face + upper body + both hands in frame the whole time, ~0.4s of stillness at
   each end.
2. Save it as `assets/ksl/<word>.mp4`.
3. Write `assets/ksl/<word>.json`:

   ```json
   {
     "word": "커피",
     "wordEn": "coffee",
     "verified": true,
     "source": "human-recorded",
     "language": "KSL",
     "signer": "credited name or role",
     "consent": "on file",
     "framing": "face + upper body + both hands visible"
   }
   ```
4. `npm run ksl:library` confirms it, and any topic needing that sign unblocks.

`verified: true` requires a human origin, consent on file, correct framing, and a
sign matching the KCISA reference. A missing sidecar counts as unverified — never
as "probably fine".

## Confirming the KCISA schema

The adapter in `src/ksl/normalize.ts` matches field names case- and
separator-insensitively against candidate lists, and records which name it
matched (`mappedFrom`) plus the raw record. It is tolerant, not clairvoyant. With
a key in `.env`:

```bash
npm run ksl:probe -- "커피"
```

That saves the raw payload under `.cache/kcisa-raw/`, prints the real field names
next to what the adapter mapped, and tries the plausible search-parameter names
(`keyword`, `srchKwd`, `searchWord`, `title`, `query`) so you can set
`KCISA_QUERY_PARAM` correctly. If a name is missing, add it to
`FIELD_CANDIDATES` — don't guess a mapping.

## YouTube upload

`src/youtube/upload.ts` uses the YouTube Data API v3 over plain HTTPS — resumable
video upload, caption tracks for `ko` and `en`, and a thumbnail. No browser
automation, no SDK.

Uploads are created **private**, always. `privacyStatus` is not read from config
at upload time; a human reviews the video and flips it public.

## Adding a topic

Append to `data/topics.json`:

```json
{
  "id": "ksign-subway",
  "topic": "지하철",
  "series": "K-SIGN",
  "priority": 4,
  "status": "unused",
  "kslWords": ["지하철"],
  "place": "서울 지하철",
  "brollTags": ["subway", "seoul"],
  "copy": {
    "hookKo": "매일 타는 곳에서 쓰는 말.",
    "hookEn": "For the place you're in every day.",
    "beatsKo": ["오늘은 지하철.", "한국수어로는?"],
    "beatsEn": ["Today: the subway.", "In Korean Sign Language?"],
    "pointKo": "노선 모양을 그대로 따라갑니다.",
    "pointEn": "The hand follows the line.",
    "ctaKo": "", "ctaEn": ""
  }
}
```

Copy is human-written. The generator picks a structure, keeps lines short, and
**refuses** anything on the banned list in `config/content.json` — clickbait,
inspiration-porn phrasing, generalisations about Deaf people, like-and-subscribe
CTAs. If the guard trips, rewrite the line; don't relax the list.

## Tone

Aim for pride, culture, language, identity, lifestyle, humour, Korea, connection,
visual communication.

Avoid pity, overcoming narratives, forced emotion, PSA voice, disability-explainer
framing, AI avatars, neon motion graphics, full-screen subtitle walls, generic
templates. Never generalise: one situation, not "all Deaf people".

Success is a viewer thinking *한국수어 멋있다*, not *AI로 만들었네*.
