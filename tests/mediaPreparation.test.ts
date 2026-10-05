import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { prepareMedia } from '../src/mediaPreparation';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp('/tmp/opencode/wpdbot-media-');
  roots.push(root);
  const filePath = join(root, 'source.mp4');
  await writeFile(filePath, 'video');
  const probe = { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10', tags: { major_brand: 'isom' } }, streams: [
    { codec_type: 'video', codec_name: 'h264', width: 640, height: 360, pix_fmt: 'yuv420p', avg_frame_rate: '25/1' },
    { codec_type: 'audio', codec_name: 'aac' },
  ] };
  const runner = vi.fn(async (_file: string, _args: string[], _timeoutMs: number) => ({ stdout: JSON.stringify(probe) }));
  return { root, filePath, probe, runner };
}

it('rejects unknown final duration when a duration limit is configured before any conversion', async () => {
  const input = await fixture();
  delete (input.probe.format as { duration?: string }).duration;
  await expect(prepareMedia(input.filePath, 1, input.runner, 120)).rejects.toThrow('duration');
  expect(input.runner).toHaveBeenCalledTimes(1);
});

it('does not use audio duration as evidence of an unknown video duration', async () => {
  const input = await fixture();
  delete (input.probe.format as { duration?: string }).duration;
  Object.assign(input.probe.streams[1], { duration: '10' });
  await expect(prepareMedia(input.filePath, 1, input.runner, 120)).rejects.toThrow('duration');
  expect(input.runner).toHaveBeenCalledTimes(1);
});

it('does not treat the MOV demuxer name as proof of an MP4 container', async () => {
  const input = await fixture();
  input.probe.format.tags.major_brand = 'qt  ';
  input.runner.mockImplementation(async (file) => {
    if (file === 'ffmpeg') throw new Error('Conversion unavailable');
    return { stdout: JSON.stringify(input.probe) };
  });
  expect((await prepareMedia(input.filePath, 1, input.runner)).deliveryMode).toBe('document');
});

it('chooses the validated original as a document when its one pre-send conversion fails', async () => {
  const input = await fixture();
  input.probe.streams[0].codec_name = 'vp9';
  input.runner.mockImplementation(async (file) => {
    if (file === 'ffmpeg') throw new Error('Encoder unavailable');
    return { stdout: JSON.stringify(input.probe) };
  });
  await expect(prepareMedia(input.filePath, 1, input.runner, 120)).resolves.toEqual({ filePath: input.filePath, sizeBytes: 5, deliveryMode: 'document' });
  expect(input.runner.mock.calls.filter(([file]) => file === 'ffmpeg')).toHaveLength(1);
});

it('never overwrites or removes an original named like the prepared output', async () => {
  const input = await fixture();
  const source = join(input.root, 'prepared.whatsapp.mp4');
  await writeFile(source, 'keep-original');
  input.probe.streams[0].codec_name = 'vp9';
  input.runner.mockImplementation(async (file, args) => {
    if (file === 'ffmpeg') {
      await writeFile(args.at(-1)!, 'partial');
      throw new Error('Conversion failed');
    }
    return { stdout: JSON.stringify(input.probe) };
  });
  expect((await prepareMedia(source, 1, input.runner)).deliveryMode).toBe('document');
  expect(await readFile(source, 'utf8')).toBe('keep-original');
});

it.each(['oversize', 'truncated', 'unprobeable', 'incompatible', 'valid'])('validates the converted output before choosing a delivery mode: %s', async (mode) => {
  const input = await fixture();
  const original = structuredClone(input.probe);
  original.streams[0].codec_name = 'vp9';
  const output = `${input.filePath}.whatsapp.mp4`;
  input.runner.mockImplementation(async (file, args) => {
    if (file === 'ffmpeg') {
      await writeFile(output, mode === 'oversize' ? Buffer.alloc(1024 * 1024 + 1) : 'converted');
      return { stdout: '' };
    }
    if (args.at(-1) === input.filePath) return { stdout: JSON.stringify(original) };
    if (mode === 'unprobeable') throw new Error('Invalid media');
    if (mode === 'truncated') input.probe.format.duration = '5';
    if (mode === 'incompatible') input.probe.streams[0].pix_fmt = 'yuv444p';
    return { stdout: JSON.stringify(input.probe) };
  });
  expect(await prepareMedia(input.filePath, 1, input.runner)).toEqual(mode === 'valid'
    ? { filePath: output, sizeBytes: 9, deliveryMode: 'video' }
    : { filePath: input.filePath, sizeBytes: 5, deliveryMode: 'document' });
});

it.each(['oversize', 'empty', 'no-video', 'long-duration', 'bad-json'])('rejects unsafe originals without attempting conversion: %s', async (mode) => {
  const input = await fixture();
  if (mode === 'oversize') await writeFile(input.filePath, Buffer.alloc(1024 * 1024 + 1));
  if (mode === 'empty') await writeFile(input.filePath, '');
  if (mode === 'no-video') input.probe.streams.splice(0, 1);
  if (mode === 'long-duration') input.probe.format.duration = '121';
  if (mode === 'bad-json') input.runner.mockResolvedValue({ stdout: 'invalid' });
  await expect(prepareMedia(input.filePath, 1, input.runner, 120)).rejects.toThrow();
  expect(input.runner.mock.calls.some(([file]) => file === 'ffmpeg')).toBe(false);
});

it('passes compatible video through without re-encoding, including silent video', async () => {
  const input = await fixture();
  input.probe.streams.splice(1, 1);
  expect(await prepareMedia(input.filePath, 1, input.runner)).toEqual({ filePath: input.filePath, sizeBytes: 5, deliveryMode: 'video' });
  expect(input.runner).toHaveBeenCalledTimes(1);
});

it.each([
  { size: '320x180', rate: 24, width: 320, height: 180, fps: '24/1' },
  { size: '800x800', rate: 24, width: 720, height: 720, fps: '24/1' },
  { size: '180x320', rate: 60, width: 180, height: 320, fps: '30/1' },
])('preserves full duration without upscaling a real local video $size at $rate fps', async ({ size, rate, width, height, fps }) => {
  const input = await fixture();
  const runner = async (file: string, args: string[], timeoutMs: number) => execa(file, args, { timeout: timeoutMs });
  const source = join(input.root, 'local.webm');
  await runner('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', `color=c=red:s=${size}:r=${rate}:d=1`, '-c:v', 'libvpx-vp9', '-threads', '2', source], 30_000);
  const result = await prepareMedia(source, 1, runner, 10);
  expect(result.deliveryMode).toBe('video');
  expect(result.filePath).not.toBe(source);
  const { stdout } = await runner('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', result.filePath], 30_000);
  const probe = JSON.parse(stdout);
  expect(probe.streams[0]).toMatchObject({ codec_name: 'h264', width, height, pix_fmt: 'yuv420p', avg_frame_rate: fps });
  expect(Number(probe.format.duration)).toBeGreaterThanOrEqual(0.99);
  expect(Number(probe.format.duration)).toBeLessThanOrEqual(1.25);
}, 30_000);
