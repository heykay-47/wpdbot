import { describe, expect, it } from 'vitest';
import { extractFirstSupportedUrl, normalizeUrlForDuplicate } from '../src/url';

describe('extractFirstSupportedUrl', () => {
  it.each([
    ['watch https://youtu.be/abc123 now', 'youtube'],
    ['watch https://www.youtube.com/watch?v=abc123 now', 'youtube'],
    ['reel https://www.instagram.com/reel/C123/?igsh=abc', 'instagram'],
    ['fb https://www.facebook.com/watch/?v=123', 'facebook'],
  ] as const)('extracts %s', (body, platform) => {
    const result = extractFirstSupportedUrl(body);
    expect(result?.platform).toBe(platform);
    expect(result?.url.startsWith('https://')).toBe(true);
  });

  it('returns null for unsupported links', () => {
    expect(extractFirstSupportedUrl('see https://example.com/video')).toBeNull();
  });

  it.each([
    ['https://youtube.com/watch?v=abc123', 'youtube'],
    ['https://m.youtube.com/watch?v=abc123', 'youtube'],
    ['https://instagram.com/p/C123/', 'instagram'],
    ['https://facebook.com/watch/?v=123', 'facebook'],
    ['https://m.facebook.com/watch/?v=123', 'facebook'],
    ['https://fb.watch/abc123/', 'facebook'],
  ] as const)('supports host in %s', (url, platform) => {
    expect(extractFirstSupportedUrl(`open ${url}`)?.platform).toBe(platform);
  });

  it('extracts the first supported link only', () => {
    expect(extractFirstSupportedUrl('see https://example.com then https://instagram.com/p/C123/')?.platform).toBe('instagram');
  });

  it('normalizes url for duplicate checks', () => {
    expect(normalizeUrlForDuplicate('HTTPS://YOUTU.BE/abc123?utm_source=x')).toBe('https://youtu.be/abc123');
  });

  it('removes tracking params, hash, and trailing slash when normalizing', () => {
    expect(normalizeUrlForDuplicate('http://WWW.INSTAGRAM.COM/reel/C123/?igsh=abc&fbclid=def#frag')).toBe(
      'https://www.instagram.com/reel/C123',
    );
  });
});
