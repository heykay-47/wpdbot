import type { SupportedPlatform, SupportedUrl } from './types.js';

const URL_PATTERN = /https?:\/\/[^\s<>"]+/gi;

const PLATFORM_HOSTS = new Map<string, SupportedPlatform>([
  ['youtube.com', 'youtube'],
  ['www.youtube.com', 'youtube'],
  ['m.youtube.com', 'youtube'],
  ['instagram.com', 'instagram'],
  ['www.instagram.com', 'instagram'],
  ['m.instagram.com', 'instagram'],
]);

const TRACKING_PARAMS = new Set(['fbclid', 'igsh']);

function platformForUrl(value: string): SupportedPlatform | null {
  try {
    const url = new URL(value);
    const platform = PLATFORM_HOSTS.get(url.hostname.toLowerCase());
    if (!platform) return null;

    const path = url.pathname.toLowerCase();
    if (platform === 'youtube') return path.startsWith('/shorts/') ? 'youtube' : null;
    if (platform === 'instagram') return path.startsWith('/reel/') || path.startsWith('/p/') ? 'instagram' : null;

    return null;
  } catch {
    return null;
  }
}

function trimUrlCandidate(value: string): string {
  return value.replace(/[\])}.,!?';:]+$/u, '');
}

export function normalizeUrlForDuplicate(value: string): string {
  const url = new URL(value);
  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';

  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.startsWith('utm_') || TRACKING_PARAMS.has(normalizedKey)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();

  while (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString().replace(/\/$/u, '');
}

export function extractFirstSupportedUrl(body: string): SupportedUrl | null {
  for (const match of body.matchAll(URL_PATTERN)) {
    const candidate = trimUrlCandidate(match[0]);
    const platform = platformForUrl(candidate);
    if (platform) {
      return {
        platform,
        url: candidate,
      };
    }
  }

  return null;
}
