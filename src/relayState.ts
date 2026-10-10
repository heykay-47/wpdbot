import type { MediaIdentity } from './mediaIdentity.js';
import { mediaIdentityKey } from './mediaIdentity.js';
import { extractSupportedUrls } from './extractors.js';

export type RelayItem = {
  index: number;
  kind: 'video' | 'image' | 'unknown';
  identity?: MediaIdentity;
  status: 'ready' | 'failed' | 'skipped' | 'confirmed' | 'held';
};

export type RelayPlan = { parentId: string; totalItems: number; items: RelayItem[] };
export type RelayLink = {
  url: string;
  platform: 'youtube' | 'instagram';
  urlHash: string;
  status: 'ready' | 'failed' | 'skipped';
  plan: RelayPlan | null;
};

type RelaySourceFields = {
  workReference?: string;
  groupId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  timestampMs: number;
  acceptedAtMs: number;
  contentHash: string;
  status: 'ready' | 'paused' | 'held' | 'settled';
  holdReason?: string;
  links: RelayLink[];
};

export type CleanupDisqualification = 'prior-message-duplicate' | 'skipped-media' | 'document-repost'
  | 'source-edited' | 'media-plan-changed' | 'expired' | 'clock-uncertain';
export type CleanupOutcome = 'not-attempted' | 'unknown' | 'not-invoked' | 'threw' | 'returned-unverified';
export type CleanupDeferral = 'media-unconfirmed' | 'group-disabled' | 'source-missing' | 'source-unavailable'
  | 'authority-unavailable' | 'client-unavailable' | 'storage-unavailable';
export type CleanupEvidence = {
  version: 1;
  initial: 'link-only' | 'mixed-content';
  initialFingerprint: string;
  disqualifications: CleanupDisqualification[];
  intentRecorded: boolean;
  outcome: CleanupOutcome;
  noticeClaimed: boolean;
  deferredReason?: CleanupDeferral;
};

type LegacyRelaySource = RelaySourceFields & { version: 1; cleanup: 'retained' };
type CurrentRelaySource = RelaySourceFields & { version: 2; cleanup: CleanupEvidence };
export type RelaySource = LegacyRelaySource | CurrentRelaySource;

const cleanupDisqualifications = new Set<CleanupDisqualification>([
  'prior-message-duplicate', 'skipped-media', 'document-repost', 'source-edited', 'media-plan-changed', 'expired', 'clock-uncertain',
]);
const cleanupDeferrals = new Set<CleanupDeferral>([
  'media-unconfirmed', 'group-disabled', 'source-missing', 'source-unavailable',
  'authority-unavailable', 'client-unavailable', 'storage-unavailable',
]);

export class UnsupportedRelayStateError extends Error {}

export function addCleanupDisqualification(source: RelaySource, reason: CleanupDisqualification): boolean {
  if (source.version !== 2 || source.cleanup.disqualifications.includes(reason)) return false;
  source.cleanup.disqualifications.push(reason);
  return true;
}

export function serializeRelaySource(source: RelaySource): string {
  const { workReference: _workReference, ...persisted } = source;
  return JSON.stringify(persisted);
}

export function validateRelaySource(source: RelaySource): void {
  try { validateSource(source); }
  catch { throw new UnsupportedRelayStateError('Durable source state is invalid or unsupported'); }
}

function validateSource(source: RelaySource): void {
  if (!source || ![1, 2].includes(source.version)
    || !['ready', 'paused', 'held', 'settled'].includes(source.status)
    || ![source.groupId, source.messageId, source.senderId, source.senderName, source.contentHash].every((value) => typeof value === 'string' && value.length > 0)
    || !/^[0-9a-f]{64}$/u.test(source.contentHash)
    || !Number.isSafeInteger(source.timestampMs) || !Number.isSafeInteger(source.acceptedAtMs)
    || !Array.isArray(source.links) || !source.links.length) throw new Error('Durable source state is invalid or unsupported');
  if (source.version === 1) {
    if (source.cleanup !== 'retained') throw new Error('Legacy cleanup state is invalid');
  } else {
    const cleanup = source.cleanup;
    if (!cleanup || cleanup.version !== 1 || !['link-only', 'mixed-content'].includes(cleanup.initial)
      || cleanup.initialFingerprint !== source.contentHash || !Array.isArray(cleanup.disqualifications)
      || cleanup.disqualifications.some((reason) => !cleanupDisqualifications.has(reason))
      || new Set(cleanup.disqualifications).size !== cleanup.disqualifications.length
      || typeof cleanup.intentRecorded !== 'boolean'
      || !['not-attempted', 'unknown', 'not-invoked', 'threw', 'returned-unverified'].includes(cleanup.outcome)
      || typeof cleanup.noticeClaimed !== 'boolean'
      || (cleanup.deferredReason !== undefined && (!cleanupDeferrals.has(cleanup.deferredReason) || cleanup.intentRecorded))
      || (!cleanup.intentRecorded && (cleanup.outcome !== 'not-attempted' || cleanup.noticeClaimed))
      || (cleanup.intentRecorded && cleanup.outcome === 'not-attempted')
      || (cleanup.initial === 'mixed-content' && cleanup.intentRecorded)
      || (cleanup.noticeClaimed && !['not-invoked', 'threw'].includes(cleanup.outcome))) {
      throw new Error('Durable cleanup evidence is invalid or unsupported');
    }
  }
  for (const link of source.links) {
    if (!link || !['ready', 'failed', 'skipped'].includes(link.status) || typeof link.urlHash !== 'string'
      || typeof link.url !== 'string' || extractSupportedUrls(link.url)[0]?.url !== link.url
      || extractSupportedUrls(link.url)[0]?.platform !== link.platform) throw new Error('Durable source link is invalid');
    if (link.plan === null) continue;
    const plan = link.plan;
    if (!plan || typeof plan.parentId !== 'string' || !plan.parentId.trim() || !Number.isSafeInteger(plan.totalItems)
      || plan.totalItems < 1 || !Array.isArray(plan.items) || !plan.items.length) throw new Error('Durable media plan is invalid');
    let previousIndex = 0;
    for (const item of plan.items) {
      if (!item || !Number.isSafeInteger(item.index) || item.index <= previousIndex || item.index > plan.totalItems
        || !['video', 'image', 'unknown'].includes(item.kind)
        || !['ready', 'failed', 'skipped', 'confirmed', 'held'].includes(item.status)) throw new Error('Durable media item is invalid');
      previousIndex = item.index;
      if (item.kind === 'video') {
        if (!item.identity || item.identity.platform !== link.platform) throw new Error('Durable video identity is unavailable');
        mediaIdentityKey(item.identity);
      } else if (item.identity || item.status !== 'skipped') throw new Error('Non-video durable item is invalid');
    }
  }
}
