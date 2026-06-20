import { describe, expect, it } from 'vitest';
import { extractFirstSupportedUrl, normalizeUrlForDuplicate, supportedExtractors } from '../src/extractors';

describe('extractor registry', () => {
  it('exposes stable extractor ids for current platforms only', () => {
    expect(supportedExtractors.map((extractor) => extractor.id)).toEqual(['youtube', 'instagram']);
  });

  it.each([
    ['short https://www.youtube.com/shorts/abc123 now', 'youtube'],
    ['reel https://www.instagram.com/reel/C123/?igsh=abc', 'instagram'],
    ['post https://www.instagram.com/p/C123/', 'instagram'],
  ] as const)('extracts %s', (body, extractorId) => {
    expect(extractFirstSupportedUrl(body)).toMatchObject({ extractorId, platform: extractorId });
  });

  it.each([
    'https://youtu.be/abc123',
    'https://youtube.com/watch?v=abc123',
    'https://x.com/user/status/123',
    'https://www.tiktok.com/@user/video/123',
  ])('does not expand support yet for %s', (url) => {
    expect(extractFirstSupportedUrl(`open ${url}`)).toBeNull();
  });

  it('normalizes duplicate URLs through extractor boundary', () => {
    expect(normalizeUrlForDuplicate('http://WWW.INSTAGRAM.COM/reel/C123/?igsh=abc&utm_source=x#frag')).toBe(
      'https://www.instagram.com/reel/C123',
    );
  });
});
