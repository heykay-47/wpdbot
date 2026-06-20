import { describe, expect, it } from 'vitest';
import { extractFirstSupportedUrl, normalizeUrlForDuplicate } from '../src/url';

describe('extractFirstSupportedUrl', () => {
  it.each([
    ['short https://www.youtube.com/shorts/abc123 now', 'youtube'],
    ['reel https://www.instagram.com/reel/C123/?igsh=abc', 'instagram'],
    ['post https://www.instagram.com/p/C123/', 'instagram'],
  ] as const)('extracts %s', (body, platform) => {
    const result = extractFirstSupportedUrl(body);
    expect(result?.platform).toBe(platform);
    expect(result?.url.startsWith('https://')).toBe(true);
  });

  it('returns null for unsupported links', () => {
    expect(extractFirstSupportedUrl('see https://example.com/video')).toBeNull();
  });

  it.each([
    ['https://youtube.com/shorts/abc123', 'youtube'],
    ['https://www.youtube.com/shorts/abc123', 'youtube'],
    ['https://m.youtube.com/shorts/abc123', 'youtube'],
    ['https://instagram.com/p/C123/', 'instagram'],
    ['https://instagram.com/reel/C123/', 'instagram'],
    ['https://www.instagram.com/p/C123/', 'instagram'],
    ['https://www.instagram.com/reel/C123/', 'instagram'],
    ['https://m.instagram.com/reel/C123/', 'instagram'],
  ] as const)('supports host in %s', (url, platform) => {
    expect(extractFirstSupportedUrl(`open ${url}`)?.platform).toBe(platform);
  });

  it.each([
    'https://youtu.be/abc123',
    'https://youtube.com/watch?v=abc123',
    'https://www.youtube.com/watch?v=abc123',
    'https://facebook.com/watch/?v=123',
    'https://m.facebook.com/watch/?v=123',
    'https://fb.watch/abc123/',
    'https://instagram.com/stories/user/123',
    'https://instagram.com/tv/C123/',
  ])('ignores unsupported URL %s', (url) => {
    expect(extractFirstSupportedUrl(`open ${url}`)).toBeNull();
  });

  it('extracts the first supported link only', () => {
    expect(extractFirstSupportedUrl('see https://example.com then https://instagram.com/p/C123/')?.platform).toBe('instagram');
  });

  it('preserves original extracted url while normalization removes tracking params', () => {
    const result = extractFirstSupportedUrl('reel https://www.instagram.com/reel/C123/?igsh=abc!');

    expect(result?.url).toBe('https://www.instagram.com/reel/C123/?igsh=abc');
    expect(normalizeUrlForDuplicate(result?.url ?? '')).toBe('https://www.instagram.com/reel/C123');
  });

  it.each([']', '}', "'", ';', ':'] as const)('strips trailing message punctuation %s', (punctuation) => {
    expect(extractFirstSupportedUrl(`watch https://www.youtube.com/shorts/abc123${punctuation}`)?.url).toBe(
      'https://www.youtube.com/shorts/abc123',
    );
  });

  it('normalizes url for duplicate checks', () => {
    expect(normalizeUrlForDuplicate('HTTPS://YOUTUBE.COM/shorts/abc123?utm_source=x')).toBe('https://youtube.com/shorts/abc123');
  });

  it('removes tracking params, hash, and trailing slash when normalizing', () => {
    expect(normalizeUrlForDuplicate('http://WWW.INSTAGRAM.COM/reel/C123/?igsh=abc&fbclid=def#frag')).toBe(
      'https://www.instagram.com/reel/C123',
    );
  });

  it('sorts remaining query params when normalizing', () => {
    expect(normalizeUrlForDuplicate('https://www.youtube.com/shorts/abc123?z=last&a=first&utm_source=x')).toBe(
      'https://www.youtube.com/shorts/abc123?a=first&z=last',
    );
  });
});
