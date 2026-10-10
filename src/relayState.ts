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

export type RelaySource = {
  version: 1;
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
  cleanup: 'retained';
  links: RelayLink[];
};

export class UnsupportedRelayStateError extends Error {}

export function serializeRelaySource(source: RelaySource): string {
  const { workReference: _workReference, ...persisted } = source;
  return JSON.stringify(persisted);
}

export function validateRelaySource(source: RelaySource): void {
  try { validateSource(source); }
  catch { throw new UnsupportedRelayStateError('Durable source state is invalid or unsupported'); }
}

function validateSource(source: RelaySource): void {
  if (!source || source.version !== 1 || source.cleanup !== 'retained'
    || !['ready', 'paused', 'held', 'settled'].includes(source.status)
    || ![source.groupId, source.messageId, source.senderId, source.senderName, source.contentHash].every((value) => typeof value === 'string' && value.length > 0)
    || !/^[0-9a-f]{64}$/u.test(source.contentHash)
    || !Number.isSafeInteger(source.timestampMs) || !Number.isSafeInteger(source.acceptedAtMs)
    || !Array.isArray(source.links) || !source.links.length) throw new Error('Durable source state is invalid or unsupported');
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
