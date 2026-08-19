import { brand, content as contentConfig } from '../util/config.js';
import { log } from '../util/log.js';
import type { ContentScript, KslMatch, SeriesName, YoutubeMetadata } from '../types.js';

// ---------------------------------------------------------------------------
// YouTube metadata. Korean first, English alongside. No clickbait, no emoji
// spam, 3–5 hashtags. Commercial disclosure is written in automatically and
// cannot be switched off from here.
// ---------------------------------------------------------------------------

const SERIES_TAGS: Record<SeriesName, string[]> = {
  'K-SIGN': ['한국수어', 'KSL', 'Korean Sign Language', 'Korean culture'],
  'DEAF PICK': ['농인', 'Deaf accessibility', 'accessibility', 'Deaf friendly'],
  'DEAF PERKS': ['Deaf culture', 'Deaf pride', '농인 문화'],
  'SIGN KOREA': ['Korea travel', '한국 여행', 'Korean Sign Language', 'Seoul'],
};

function titleVariants(script: ContentScript): string[] {
  const word = script.kslWord;
  const en = script.hookEn || script.pointEn || 'Korean Sign Language';
  return [
    `"${word}"를 한국수어로 🤟 | Korean Sign Language`,
    `한국수어로 "${word}" 🤟 | KSL`,
    `${word} in Korean Sign Language 🤟 | 한국수어`,
    `${en.replace(/\.$/, '')} — "${word}" in KSL 🤟`,
  ];
}

/** Stable per topic, so re-running does not churn the title. */
function pickVariant(variants: string[], key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return variants[h % variants.length]!;
}

export function buildHashtags(script: ContentScript): string[] {
  const cfg = contentConfig().hashtags;
  const chosen = [...cfg.always];
  const contextual: string[] = [];
  if (script.series === 'DEAF PERKS' || script.series === 'K-SIGN') contextual.push('#DeafCulture');
  if (script.series === 'DEAF PERKS') contextual.push('#DeafPride');
  if (script.series === 'SIGN KOREA') contextual.push('#Korea');
  if (script.series === 'DEAF PICK') contextual.push('#농인');
  contextual.push('#KoreanSignLanguage');

  for (const tag of contextual) {
    if (chosen.length >= cfg.maxCount) break;
    if (!chosen.includes(tag) && cfg.pool.concat(cfg.always).includes(tag)) chosen.push(tag);
  }
  if (chosen.length < cfg.minCount) {
    for (const tag of cfg.pool) {
      if (chosen.length >= cfg.minCount) break;
      if (!chosen.includes(tag)) chosen.push(tag);
    }
  }
  return chosen.slice(0, cfg.maxCount);
}

export interface MetadataInput {
  script: ContentScript;
  matches: KslMatch[];
  kcisaEndpoint: string;
  musicAttribution: string | null;
  mode: 'render' | 'preview';
}

export function buildMetadata(input: MetadataInput): YoutubeMetadata {
  const cfg = contentConfig();
  const b = brand();
  const { script, matches, mode } = input;

  const title = pickVariant(titleVariants(script), script.topicId);
  const hashtags = buildHashtags(script);

  const kcisaLine = matches
    .filter((m) => m.kcisaRecord)
    .map((m) => `· ${m.word} — KCISA ${m.kcisaRecord!.sourceEndpoint} (${m.kcisaRecord!.id})`)
    .join('\n');

  const descriptionParts: string[] = [];

  if (script.commercial.disclosureKo) {
    // Disclosure goes first, before anything else, and is never hidden.
    descriptionParts.push(`${script.commercial.disclosureKo}\n${script.commercial.disclosureEn}`);
  }

  descriptionParts.push(
    [script.hookKo, ...script.bodyKo].filter(Boolean).join(' '),
    [script.hookEn, ...script.bodyEn].filter(Boolean).join(' '),
  );

  if (script.pointKo || script.pointEn) {
    descriptionParts.push([script.pointKo, script.pointEn].filter(Boolean).join('\n'));
  }

  descriptionParts.push(
    [
      `수어 / Sign: ${script.kslWord} (한국수어 · Korean Sign Language)`,
      '영상 속 수어는 실제 농인·수어 사용자가 직접 촬영한 영상입니다.',
      'The signing in this video is performed by a real person. No AI-generated signing.',
      kcisaLine
        ? `수어 참고 자료 / Reference: 문화체육관광부·KCISA 한국수어 OpenAPI\n${kcisaLine}`
        : '수어 참고 자료 / Reference: 문화체육관광부·KCISA 한국수어 OpenAPI',
    ].join('\n'),
  );

  if (input.musicAttribution) descriptionParts.push(`Music: ${input.musicAttribution}`);

  descriptionParts.push(`${b.brandNameKo} · ${b.brandNameEn}\n${b.descriptor}`);
  descriptionParts.push(hashtags.join(' '));

  if (mode === 'preview') {
    descriptionParts.unshift(
      'PREVIEW — not for publication. A verified human KSL clip is still required.',
    );
  }

  const tags = [
    ...(SERIES_TAGS[script.series] ?? []),
    script.topic,
    script.kslWord,
    b.brandNameEn,
    b.brandNameKo,
  ]
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .slice(0, 15);

  const metadata: YoutubeMetadata = {
    title: title.length > 100 ? `${title.slice(0, 99)}…` : title,
    description: descriptionParts.filter(Boolean).join('\n\n'),
    hashtags,
    tags,
    categoryId: cfg.youtube.categoryId,
    defaultLanguage: cfg.youtube.defaultLanguage,
    defaultAudioLanguage: cfg.youtube.defaultAudioLanguage,
    // Always private on upload. A human flips it public after review.
    privacyStatus: 'private',
    madeForKids: cfg.youtube.madeForKids,
  };

  log.ok(`metadata: "${metadata.title}" (${hashtags.length} hashtags, ${tags.length} tags)`);
  return metadata;
}
