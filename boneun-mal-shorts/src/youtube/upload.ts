import fs from 'node:fs';
import path from 'node:path';
import { env } from '../util/env.js';
import { log } from '../util/log.js';
import { rel } from '../util/paths.js';
import type { OutputManifest } from '../types.js';

// ---------------------------------------------------------------------------
// YouTube Data API v3 upload — plain HTTPS, no browser automation, no SDK.
//
// Policy, enforced here and not overridable by config:
//   · The publish gate must be green (PUBLISH_READY=true).
//   · privacyStatus is always "private". A human flips it public after review.
// ---------------------------------------------------------------------------

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const VIDEOS_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const CAPTIONS_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/captions';
const THUMBNAIL_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set';

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function oauthConfig(): OAuthConfig | null {
  const clientId = env('YOUTUBE_CLIENT_ID');
  const clientSecret = env('YOUTUBE_CLIENT_SECRET');
  const refreshToken = env('YOUTUBE_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

async function accessToken(cfg: OAuthConfig): Promise<string> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `OAuth token refresh failed (HTTP ${res.status}): ${text.slice(0, 400)}\n` +
        'Check YOUTUBE_CLIENT_ID / SECRET / REFRESH_TOKEN in .env, and that the refresh token ' +
        'carries the youtube.upload and youtube.force-ssl scopes.',
    );
  }
  const parsed = JSON.parse(text) as { access_token?: string };
  if (!parsed.access_token) throw new Error(`OAuth response had no access_token: ${text.slice(0, 200)}`);
  return parsed.access_token;
}

export interface UploadResult {
  videoId: string;
  watchUrl: string;
  studioUrl: string;
  captionsUploaded: string[];
  thumbnailSet: boolean;
}

/** Resumable upload. Shorts files are small, so one PUT completes the session. */
async function uploadVideo(
  token: string,
  manifest: OutputManifest,
  videoFile: string,
): Promise<string> {
  const size = fs.statSync(videoFile).size;
  const meta = manifest.youtube;

  const snippet = {
    snippet: {
      title: meta.title,
      description: meta.description,
      tags: meta.tags,
      categoryId: meta.categoryId,
      defaultLanguage: meta.defaultLanguage,
      defaultAudioLanguage: meta.defaultAudioLanguage,
    },
    status: {
      // Not read from config: private is the only allowed value on upload.
      privacyStatus: 'private',
      selfDeclaredMadeForKids: meta.madeForKids,
      embeddable: true,
      license: 'youtube',
    },
  };

  const init = await fetch(`${VIDEOS_UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(size),
      'X-Upload-Content-Type': 'video/mp4',
    },
    body: JSON.stringify(snippet),
    signal: AbortSignal.timeout(60_000),
  });
  if (!init.ok) {
    throw new Error(`Upload session could not be created (HTTP ${init.status}): ${(await init.text()).slice(0, 500)}`);
  }
  const location = init.headers.get('location');
  if (!location) throw new Error('Upload session created but no Location header was returned.');

  log.info(`uploading ${(size / 1_048_576).toFixed(2)} MB…`);
  const put = await fetch(location, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) },
    body: fs.readFileSync(videoFile),
    signal: AbortSignal.timeout(1_800_000),
  });
  const putText = await put.text();
  if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status}): ${putText.slice(0, 500)}`);
  const parsed = JSON.parse(putText) as { id?: string };
  if (!parsed.id) throw new Error(`Upload response had no video id: ${putText.slice(0, 300)}`);
  return parsed.id;
}

/** Caption track upload as multipart/related, built by hand — no SDK needed. */
async function uploadCaption(
  token: string,
  videoId: string,
  srtFile: string,
  language: 'ko' | 'en',
  name: string,
): Promise<void> {
  const boundary = `boneunmal-${Date.now().toString(36)}`;
  const metadata = JSON.stringify({
    snippet: { videoId, language, name, isDraft: false },
  });
  const srt = fs.readFileSync(srtFile, 'utf8');
  const body = Buffer.from(
    [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      metadata,
      `--${boundary}`,
      'Content-Type: application/octet-stream',
      '',
      srt,
      `--${boundary}--`,
      '',
    ].join('\r\n'),
    'utf8',
  );

  const res = await fetch(`${CAPTIONS_UPLOAD_URL}?uploadType=multipart&part=snippet`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`Caption upload (${language}) failed (HTTP ${res.status}): ${(await res.text()).slice(0, 400)}`);
  }
}

async function setThumbnail(token: string, videoId: string, imageFile: string): Promise<void> {
  const res = await fetch(`${THUMBNAIL_UPLOAD_URL}?videoId=${encodeURIComponent(videoId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' },
    body: fs.readFileSync(imageFile),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    // A custom thumbnail needs a verified channel; not having one is not fatal.
    throw new Error(`Thumbnail upload failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
}

export interface UploadOptions {
  dir: string;
  manifest: OutputManifest;
  /** Skip caption track upload (the burn-in and SRT sidecars still exist). */
  skipCaptions?: boolean;
  skipThumbnail?: boolean;
}

export async function uploadToYoutube(opts: UploadOptions): Promise<UploadResult> {
  const { dir, manifest } = opts;

  // --- gate ---------------------------------------------------------------
  if (!manifest.publishReady) {
    const blockers = manifest.verification?.blockers ?? ['verification has not been run'];
    throw new Error(
      `PUBLISH_READY=false — upload refused.\n${blockers.map((b) => `  · ${b}`).join('\n')}\n` +
        'Fix the blockers and re-run `npm run verify`. The gate is not bypassable.',
    );
  }
  if (manifest.ksl.verifiedHumanClip !== 'YES') {
    throw new Error('Refusing to upload: no verified human KSL clip. This check has no override.');
  }
  if (manifest.mode === 'preview') {
    throw new Error('Refusing to upload a preview render. Preview output is never publishable.');
  }

  const cfg = oauthConfig();
  if (!cfg) {
    throw new Error(
      'YouTube OAuth is not configured. Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and ' +
        'YOUTUBE_REFRESH_TOKEN in .env (see .env.example).',
    );
  }

  const videoFile = path.join(dir, 'shorts.mp4');
  if (!fs.existsSync(videoFile)) throw new Error(`Missing ${rel(videoFile)}`);

  log.info('refreshing access token…');
  const token = await accessToken(cfg);

  const videoId = await uploadVideo(token, manifest, videoFile);
  log.ok(`uploaded as private: ${videoId}`);

  const captionsUploaded: string[] = [];
  if (!opts.skipCaptions) {
    for (const [lang, file, name] of [
      ['ko', path.join(dir, 'captions.ko.srt'), '한국어'],
      ['en', path.join(dir, 'captions.en.srt'), 'English'],
    ] as const) {
      if (!fs.existsSync(file)) {
        log.warn(`no ${lang} caption file at ${rel(file)} — skipped`);
        continue;
      }
      try {
        await uploadCaption(token, videoId, file, lang, name);
        captionsUploaded.push(lang);
        log.ok(`caption track uploaded: ${lang}`);
      } catch (err) {
        log.warn((err as Error).message);
      }
    }
  }

  let thumbnailSet = false;
  const thumb = path.join(dir, 'thumbnail.jpg');
  if (!opts.skipThumbnail && fs.existsSync(thumb)) {
    try {
      await setThumbnail(token, videoId, thumb);
      thumbnailSet = true;
      log.ok('thumbnail set');
    } catch (err) {
      log.warn(`${(err as Error).message} (custom thumbnails require a verified channel)`);
    }
  }

  return {
    videoId,
    watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
    studioUrl: `https://studio.youtube.com/video/${videoId}/edit`,
    captionsUploaded,
    thumbnailSet,
  };
}
