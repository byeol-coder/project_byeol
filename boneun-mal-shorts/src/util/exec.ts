import { spawn } from 'node:child_process';
import { env } from './env.js';
import { log } from './log.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], timeoutMs = 600_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    log.debug(`$ ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} could not be started: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export const ffmpegBin = (): string => env('FFMPEG_PATH', 'ffmpeg');
export const ffprobeBin = (): string => env('FFPROBE_PATH', 'ffprobe');

export async function toolAvailable(bin: string): Promise<boolean> {
  try {
    const r = await run(bin, ['-version'], 15_000);
    return r.code === 0;
  } catch {
    return false;
  }
}

export interface ProbeStreams {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string;
  audioCodec: string;
  sampleAspectRatio: string;
}

export async function ffprobeMedia(file: string): Promise<ProbeStreams> {
  const r = await run(
    ffprobeBin(),
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    60_000,
  );
  if (r.code !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr.trim()}`);
  const parsed = JSON.parse(r.stdout) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s['codec_type'] === 'video');
  const audio = streams.find((s) => s['codec_type'] === 'audio');
  const fpsRaw = String(video?.['avg_frame_rate'] ?? video?.['r_frame_rate'] ?? '0/1');
  const [num, den] = fpsRaw.split('/').map((n) => Number(n));
  const fps = den && den !== 0 ? (num ?? 0) / den : 0;
  const durFormat = Number(parsed.format?.['duration'] ?? 0);
  const durVideo = Number(video?.['duration'] ?? 0);
  return {
    durationSeconds: Number.isFinite(durFormat) && durFormat > 0 ? durFormat : durVideo,
    width: Number(video?.['width'] ?? 0),
    height: Number(video?.['height'] ?? 0),
    fps: Number(fps.toFixed(3)),
    hasAudio: Boolean(audio),
    videoCodec: String(video?.['codec_name'] ?? ''),
    audioCodec: String(audio?.['codec_name'] ?? ''),
    sampleAspectRatio: String(video?.['sample_aspect_ratio'] ?? '1:1'),
  };
}
