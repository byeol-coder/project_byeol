// ---------------------------------------------------------------------------
// Shared contracts. Anything crossing a module boundary is typed here.
// ---------------------------------------------------------------------------

export type SeriesName = 'K-SIGN' | 'DEAF PICK' | 'DEAF PERKS' | 'SIGN KOREA';

export const SERIES_NAMES: SeriesName[] = ['K-SIGN', 'DEAF PICK', 'DEAF PERKS', 'SIGN KOREA'];

// --- KCISA -----------------------------------------------------------------

/** A KCISA record after normalisation. Only ever built from a real response. */
export interface KslRecord {
  id: string;
  title: string;
  description: string;
  handshapeDescription: string;
  imageUrl: string;
  videoUrl: string;
  location: string;
  source: 'KCISA';
  sourceEndpoint: string;
  /** Field names the adapter actually matched, so mapping drift is visible. */
  mappedFrom: Record<string, string>;
  raw: Record<string, unknown>;
}

export type KcisaStatus =
  | 'OK'
  | 'EMPTY_RESULT'
  | 'KSL_DATA_UNAVAILABLE';

export type KcisaFailureReason =
  | 'MISSING_SERVICE_KEY'
  | 'HTTP_ERROR'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_BLOCKED'
  | 'UNPARSEABLE_RESPONSE'
  | 'API_ERROR_CODE'
  | 'SCHEMA_UNRECOGNISED';

export interface KcisaSearchResult {
  status: KcisaStatus;
  /** Set whenever status is KSL_DATA_UNAVAILABLE. */
  reason: KcisaFailureReason | null;
  message: string;
  query: string;
  records: KslRecord[];
  totalCount: number;
  pageNo: number;
  numOfRows: number;
  fromCache: boolean;
  /** Path of the saved raw payload, for schema inspection. */
  rawLogPath: string | null;
  httpStatus: number;
  endpoint: string;
  fetchedAt: string;
}

// --- KSL clip library ------------------------------------------------------

export interface KslClipMetadata {
  word: string;
  wordEn?: string;
  verified: boolean;
  source: string;
  language: string;
  signer?: string;
  consent?: string;
  recordedAt?: string;
  framing?: string;
  kcisaId?: string;
  notes?: string;
  /** Set when the clip is an imported officially-licensed recording, not a fresh shoot. */
  license?: string;
  licenseUrl?: string;
  attributionText?: string;
  officialSourceUrl?: string;
}

export interface KslClip {
  word: string;
  file: string;
  metadataFile: string | null;
  metadata: KslClipMetadata | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
}

export type KslMatchStatus = 'VERIFIED' | 'NEEDS_KSL_RECORDING';

export interface KslMatch {
  word: string;
  status: KslMatchStatus;
  clip: KslClip | null;
  /** KCISA record that authorises this word as a real KSL entry. */
  kcisaRecord: KslRecord | null;
  kcisaMatch: 'PASS' | 'FAIL';
  problems: string[];
}

// --- Content ---------------------------------------------------------------

export interface TopicSeed {
  id: string;
  topic: string;
  series: SeriesName;
  priority: number;
  status: 'unused' | 'used' | 'retired' | 'needs-ksl';
  kslWords: string[];
  place?: string;
  brollTags?: string[];
  lastUsedAt?: string | null;
  usedCount?: number;
  commercial?: boolean;
  affiliate?: boolean;
  sponsor?: string | null;
  product?: string | null;
  copy?: {
    hookKo?: string;
    hookEn?: string;
    beatsKo?: string[];
    beatsEn?: string[];
    pointKo?: string;
    pointEn?: string;
    ctaKo?: string;
    ctaEn?: string;
  };
}

export interface TopicsFile {
  _comment?: string;
  _schemaVersion?: number;
  topics: TopicSeed[];
}

export interface Commercial {
  commercial: boolean;
  affiliate: boolean;
  sponsor: string | null;
  product: string | null;
  disclosureKo: string | null;
  disclosureEn: string | null;
}

export interface ContentScript {
  topicId: string;
  topic: string;
  series: SeriesName;
  hookKo: string;
  hookEn: string;
  bodyKo: string[];
  bodyEn: string[];
  kslWord: string;
  kslWords: string[];
  pointKo: string;
  pointEn: string;
  endingKo: string;
  endingEn: string;
  ctaKo: string;
  ctaEn: string;
  durationTarget: number;
  /** Which of the structure variants was used, so consecutive videos differ. */
  structureVariant: string;
  commercial: Commercial;
}

// --- Timeline / render ----------------------------------------------------

export type SegmentKind = 'hook' | 'context' | 'ksl' | 'point' | 'ending';

export interface TimelineSegment {
  kind: SegmentKind;
  startSeconds: number;
  durationSeconds: number;
  /** Source media; null means a solid brand card is generated instead. */
  sourceFile: string | null;
  sourceKind: 'ksl-clip' | 'broll' | 'image' | 'generated-card' | 'placeholder';
  /** Signing segments forbid every overlay inside the signing space. */
  protectsSigningSpace: boolean;
  textKo: string;
  textEn: string;
  /** Set on preview renders where a verified clip is missing. */
  placeholderNotice: string | null;
  sourceInPointSeconds: number;
}

export interface Timeline {
  totalSeconds: number;
  segments: TimelineSegment[];
  musicFile: string | null;
  musicAttribution: string | null;
  brollUsed: string[];
}

// --- Output / QA ----------------------------------------------------------

export type CheckState = 'PASS' | 'FAIL' | 'SKIP';

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
}

export interface VerificationResult {
  checks: Check[];
  kslSource: 'KCISA' | 'NONE';
  kslApiMatch: 'PASS' | 'FAIL';
  verifiedHumanClip: 'YES' | 'NO';
  publishReady: boolean;
  blockers: string[];
}

export interface YoutubeMetadata {
  title: string;
  description: string;
  hashtags: string[];
  tags: string[];
  categoryId: string;
  defaultLanguage: string;
  defaultAudioLanguage: string;
  privacyStatus: 'private' | 'unlisted' | 'public';
  madeForKids: boolean;
}

export interface OutputManifest {
  brand: { nameKo: string; nameEn: string; descriptor: string };
  createdAt: string;
  slug: string;
  topic: string;
  topicId: string;
  series: SeriesName;
  mode: 'render' | 'preview';
  durationSeconds: number;
  script: ContentScript;
  ksl: {
    words: string[];
    matches: KslMatch[];
    source: 'KCISA' | 'NONE';
    apiMatch: 'PASS' | 'FAIL';
    verifiedHumanClip: 'YES' | 'NO';
    kcisaEndpoint: string;
    kcisaFetchedAt: string | null;
  };
  commercial: Commercial;
  youtube: YoutubeMetadata;
  files: Record<string, string>;
  verification: VerificationResult | null;
  publishReady: boolean;
}
