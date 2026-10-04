import { normalizeUrlForDuplicate } from './extractors.js';

export type MediaIdentity =
  | { platform: 'youtube'; videoId: string }
  | { platform: 'instagram'; postId: string; itemId: string };

export function isYouTubeVideoId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/u.test(value);
}

export function mediaIdentityKey(identity: MediaIdentity): string {
  if (identity.platform === 'youtube' ? !isYouTubeVideoId(identity.videoId) : !identity.postId.trim() || !identity.itemId.trim()) {
    throw new Error('Media identity is unavailable');
  }
  return JSON.stringify(identity.platform === 'youtube'
    ? ['media', 1, 'youtube', identity.videoId]
    : ['media', 1, 'instagram', identity.postId, identity.itemId]);
}

export function candidateMediaIdentity(value: string): MediaIdentity | null {
  if (!isOrdinaryHttpUrl(new URL(value))) return null;
  const url = new URL(normalizeUrlForDuplicate(value));
  const match = /^\/shorts\/([A-Za-z0-9_-]+)\/?$/u.exec(submittedPath(value));
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname) || !match || !isYouTubeVideoId(match[1]) || url.search) return null;
  return { platform: 'youtube', videoId: match[1] };
}

export function sourceRequestKey(value: string): string {
  const candidate = candidateMediaIdentity(value);
  if (candidate) return mediaIdentityKey(candidate);
  const normalized = normalizeUrlForDuplicate(value);
  const url = new URL(normalized);
  const match = /^\/(?:p|reel)\/([A-Za-z0-9_-]{1,28})\/?$/u.exec(submittedPath(value));
  const selections = url.searchParams.getAll('img_index');
  if (['instagram.com', 'www.instagram.com'].includes(url.hostname) && match
    && isOrdinaryHttpUrl(new URL(value))
    && [...url.searchParams.keys()].every((key) => key === 'img_index')
    && (selections.length === 0 || (selections.length === 1 && /^[1-9]\d*$/u.test(selections[0]) && Number.isSafeInteger(Number(selections[0]))))) {
    return JSON.stringify(['request', 1, 'instagram', match[1], selections[0] ?? 'all']);
  }
  return JSON.stringify(['url', 1, normalized]);
}

function isOrdinaryHttpUrl(url: URL): boolean {
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port;
}

function submittedPath(value: string): string {
  // URL parsing removes literal/encoded dot segments and normalizes backslashes.
  // Recognize ordinary wrappers on the submitted path, never that normalized path.
  return /^https?:\/\/[^/?#\\]+(\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/iu.exec(value)?.[1] ?? '';
}
