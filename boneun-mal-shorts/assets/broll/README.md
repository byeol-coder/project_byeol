# assets/broll — real places, real people

Documentary / editorial / street-photography feel. Contemporary Korean daily
life: convenience stores, subway, cafés, the Han river, alleys, markets,
schools, offices, Seoul and Busan streets. **Not** flags, palaces, hanbok or
traditional patterns as default decoration.

```
assets/broll/
  seoul/  cafe/  subway/  hanriver/  street/  food/  travel/
```

Rules the pipeline enforces:

* The same B-roll file is not reused within the last 3 videos
  (`config/content.json → rotation.brollNoRepeatWindow`).
* AI-generated footage is allowed **only** as background / atmosphere /
  transition, and only when `"aiGenerated": true` is declared in its sidecar.
  A clip whose sidecar declares `"containsSigning": true` **and**
  `"aiGenerated": true` is rejected outright — AI must never appear to sign.

Optional sidecar `<name>.json`:

```json
{
  "location": "성수",
  "aiGenerated": false,
  "containsSigning": false,
  "rights": "own footage",
  "shotAt": "2026-07-12"
}
```
