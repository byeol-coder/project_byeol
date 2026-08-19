# 보이는 말 · BONEUN MAL — working rules

Korean Sign Language · Deaf Culture · Korea.
A Korean Deaf culture media brand. Not an AI shorts factory.

Read this before touching anything in `boneun-mal-shorts/`.

---

## Non-negotiable

```
Never invent Korean Sign Language.

KCISA data is the authoritative content reference.

Never generate fake sign language with AI.

Human-verified KSL clips are required before publishing.

Do not portray Deaf people through pity or inspiration-porn framing.

Deaf Pride and Korean Deaf culture should feel natural, contemporary and human.

Visual communication comes first.

Hands and facial expressions must remain visible.

No video may be published automatically without QA.
```

These are enforced in code, not just in prose. If a change makes any of them
easier to bypass, the change is wrong.

## 1. Sign language accuracy comes first

* The reference for every sign is the KCISA / 문화체육관광부 한국수어 OpenAPI
  (`getCTE01701`). Nothing else is authoritative.
* The visible signing in a video is **always** a recording of a real person
  (`assets/ksl/`, `verified: true`). Two legitimate origins: someone films it
  themselves with consent on file, or `npm run ksl:import` pulls the official
  recording KCISA already links to (국립국어원 한국수어사전) under a confirmed
  public licence with attribution — never a third option involving generated
  hands. Either way a human watches the clip once before it counts as verified.
* This chain is forbidden, in whole or in part:
  `text prompt → AI video generator → plausible hand motion → published as KSL`.
* When the API is unreachable or the key is missing, the pipeline returns
  `KSL_DATA_UNAVAILABLE` and stops. It does **not** fabricate a fallback record.
* When no verified clip exists for a needed sign, the state is
  `NEEDS_KSL_RECORDING`. Options: swap in a different verified sign, or render a
  preview with a `[ VERIFIED KSL CLIP REQUIRED ]` placeholder. Never a third
  option involving generated hands.
* Leaving a deliverable unfinished while waiting for a real KSL asset is the
  correct outcome. Shipping a plausible-looking fake is not.

## 2. AI's place in this project

AI is backstage technology. It may:

* fetch, normalise and cache API data,
* select topics and assemble copy from human-authored seeds,
* cut, encode and QA video,
* generate background / atmosphere / transition footage **only** when the clip's
  sidecar declares `aiGenerated: true` and `containsSigning: false`.

It may never appear to be a person signing, and it should never be the thing the
viewer notices. Success is a viewer thinking "한국수어 멋있다", not "AI로 만들었네".

## 3. Tone

Aim for: pride, culture, language, identity, lifestyle, humour, Korea,
connection, visual communication.

Avoid: pity, overcoming narratives, forced emotion, "please help us", "life is
hard for deaf people", disability-explainer framing, PSA voice, clickbait hooks,
AI-avatar talking heads, neon motion graphics, full-screen subtitle walls,
generic YouTube templates.

Never generalise. Write "이런 순간이 있습니다", never "모든 농인은 이렇습니다".
`config/content.json → copy.banned*Phrases` encodes the hard bans and
`src/content/generateContent.ts` fails the build when one slips through.

## 4. Frame rules

* 1080 × 1920, 30fps, H.264 / AAC.
* On any segment showing signing, the **signing space**
  (`config/video.json → signingSpace`) is untouchable: no subtitle, CTA, logo,
  graphic or transition may enter it. Face, upper body and both hands stay in
  frame — expression is grammar, not decoration, so do not crop to hands only.
* Burn-in text sits inside `safeArea`, clear of the Shorts UI.
* Both `captions.ko.srt` and `captions.en.srt` are always produced. Korean is
  primary and larger; English is a secondary subtitle line.

## 5. Publish gate

`PUBLISH_READY=true` requires all of: KCISA match PASS, verified human clip YES,
video QA PASS, subtitle PASS, copyright check PASS, metadata PASS. Any failure →
`false`, and `npm run youtube:upload` refuses to run. Uploads are created
`private`; a human flips them public. Never automate that flip.

## 6. Commercial content

`DEAF PICK` may be sponsored or affiliate. When it is, disclosure is written into
`metadata.json` and the description automatically. Never hide it, never let the
video read as an ad, and only cover things that genuinely help Deaf / HoH people.

## 7. Working order

Always in this order — see `.claude/skills/korean-deaf-shorts/SKILL.md`:

```
API 확인 → KSL 확인 → 소재 선정 → 대본 → 영상 → QA
```

Verifying the sign data before writing a single line of script is the point. Do
not reorder it for speed.

## 8. Code conventions

TypeScript, ESM, `strict`. No secrets in source — everything through `.env`
(`KCISA_SERVICE_KEY`, YouTube OAuth). Every external call gets a timeout, bounded
retries with backoff, and a logged outcome. Config lives in `config/*.json`, not
in literals. Logs are human-readable step lines (`[3/9] …`). Failures are loud and
specific; nothing fails silently into a default.
