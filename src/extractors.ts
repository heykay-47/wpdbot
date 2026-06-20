export type ExtractorId = 'youtube' | 'instagram';

export type ExtractedUrl = {
  extractorId: ExtractorId;
  platform: ExtractorId;
  url: string;
};

export type Extractor = {
  id: ExtractorId;
  displayName: string;
  hosts: readonly string[];
  matchesPath(pathname: string): boolean;
};

const URL_PATTERN = /https?:\/\/[^\s<>"]+/gi;
const TRACKING_PARAMS = new Set(['fbclid', 'igsh']);

export const supportedExtractors: readonly Extractor[] = [
  {
    id: 'youtube',
    displayName: 'YouTube Shorts',
    hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com'],
    matchesPath: (pathname) => pathname.toLowerCase().startsWith('/shorts/'),
  },
  {
    id: 'instagram',
    displayName: 'Instagram reels/posts',
    hosts: ['instagram.com', 'www.instagram.com', 'm.instagram.com'],
    matchesPath: (pathname) => {
      const path = pathname.toLowerCase();
      return path.startsWith('/reel/') || path.startsWith('/p/');
    },
  },
];

function trimUrlCandidate(value: string): string {
  return value.replace(/[\])}.,!?';:]+$/u, '');
}

function extractorForUrl(value: string): Extractor | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return supportedExtractors.find((extractor) => extractor.hosts.includes(hostname) && extractor.matchesPath(url.pathname)) ?? null;
  } catch {
    return null;
  }
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

export function extractFirstSupportedUrl(body: string): ExtractedUrl | null {
  for (const match of body.matchAll(URL_PATTERN)) {
    const candidate = trimUrlCandidate(match[0]);
    const extractor = extractorForUrl(candidate);
    if (!extractor) continue;

    return {
      extractorId: extractor.id,
      platform: extractor.id,
      url: candidate,
    };
  }

  return null;
}
