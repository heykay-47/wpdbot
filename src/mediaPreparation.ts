import { rm, stat } from 'node:fs/promises';
import { extname } from 'node:path';

export type MediaRunner = (file: string, args: string[], timeoutMs: number) => Promise<{ stdout: string }>;
export type PreparedMedia = { filePath: string; sizeBytes: number; deliveryMode: 'video' | 'document' };

type Stream = { codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string; avg_frame_rate?: string; duration?: string; disposition?: { attached_pic?: number } };
type Inspection = { size: number; duration?: number; compatible: boolean };

async function inspect(filePath: string, maxFileSizeMb: number, runner: MediaRunner, maxDurationSeconds?: number): Promise<Inspection> {
  if (!Number.isSafeInteger(maxFileSizeMb) || maxFileSizeMb <= 0) throw new Error('Media size limit is invalid');
  const file = await stat(filePath);
  if (!file.isFile() || file.size === 0) throw new Error('Video output is empty or unavailable');
  if (file.size > maxFileSizeMb * 1024 * 1024) throw new Error(`Downloaded file exceeds ${maxFileSizeMb} MB`);
  const { stdout } = await runner('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath], 30_000);
  const probe = JSON.parse(stdout) as { format?: { format_name?: string; duration?: string; tags?: { major_brand?: string } }; streams?: Stream[] };
  if (!Array.isArray(probe.streams)) throw new Error('Video streams are unavailable');
  const videos = probe.streams.filter((stream) => stream?.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = probe.streams.filter((stream) => stream?.codec_type === 'audio');
  const video = videos[0];
  if (!video?.codec_name || !Number.isInteger(video.width) || !Number.isInteger(video.height) || video.width! <= 0 || video.height! <= 0) throw new Error('Video stream is unavailable');
  const durations = [probe.format?.duration, ...probe.streams.map((stream) => stream?.duration)]
    .map(Number).filter((value) => Number.isFinite(value) && value > 0);
  const containerDuration = Number(probe.format?.duration);
  const videoDurationsKnown = videos.every((stream) => Number.isFinite(Number(stream.duration)) && Number(stream.duration) > 0);
  const videoDurationKnown = (Number.isFinite(containerDuration) && containerDuration > 0) || videoDurationsKnown;
  const duration = videoDurationKnown && durations.length ? Math.max(...durations) : undefined;
  if (maxDurationSeconds !== undefined) {
    if (duration === undefined) throw new Error('Video duration is unavailable');
    if (duration > maxDurationSeconds) throw new Error(`Video exceeds ${maxDurationSeconds} seconds`);
  }
  const [numerator, denominator] = (video.avg_frame_rate ?? '').split('/').map(Number);
  const fps = numerator / denominator;
  // The MOV demuxer reports "mov,mp4,..." even for QuickTime containers.
  const mp4 = Boolean(probe.format?.format_name?.split(',').includes('mp4'))
    && /^(isom|iso[2-9]|mp4[12]|avc1|dash)$/u.test(probe.format?.tags?.major_brand ?? '')
    && extname(filePath).toLowerCase() === '.mp4';
  const compatible = mp4 && videos.length === 1
    && video.codec_name === 'h264' && video.pix_fmt === 'yuv420p'
    && Math.min(video.width!, video.height!) <= 720 && video.width! % 2 === 0 && video.height! % 2 === 0
    && Number.isFinite(fps) && fps > 0 && fps <= 30 && audio.every((stream) => stream.codec_name === 'aac');
  return { size: file.size, duration, compatible };
}

export async function prepareMedia(filePath: string, maxFileSizeMb: number, runner: MediaRunner, maxDurationSeconds?: number): Promise<PreparedMedia> {
  const original = await inspect(filePath, maxFileSizeMb, runner, maxDurationSeconds);
  if (original.compatible) return { filePath, sizeBytes: original.size, deliveryMode: 'video' };
  // Unknown source duration cannot establish that a conversion retained the full video.
  if (original.duration === undefined) return { filePath, sizeBytes: original.size, deliveryMode: 'document' };
  const outputPath = `${filePath}.whatsapp.mp4`;
  try {
    await runner('ffmpeg', [
      '-nostdin', '-y', '-i', filePath, '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', "scale=w='trunc(iw*min(1,720/min(iw,ih))/2)*2':h='trunc(ih*min(1,720/min(iw,ih))/2)*2'",
      '-fpsmax', '30', '-c:v', 'libx264', '-threads', '2', '-filter_threads', '2', '-preset', 'veryfast', '-crf', '28',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath,
    ], 120_000);
    const converted = await inspect(outputPath, maxFileSizeMb, runner, maxDurationSeconds);
    if (!converted.compatible || converted.duration === undefined || Math.abs(converted.duration - original.duration) > 0.25) {
      throw new Error('Converted video does not preserve the source duration or playback profile');
    }
    return { filePath: outputPath, sizeBytes: converted.size, deliveryMode: 'video' };
  } catch {
    await rm(outputPath, { force: true }).catch(() => undefined);
    return { filePath, sizeBytes: original.size, deliveryMode: 'document' };
  }
}
