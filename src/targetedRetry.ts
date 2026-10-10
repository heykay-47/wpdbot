import { randomUUID } from 'node:crypto';
import type { Downloader } from './downloader.js';
import type { GroupSettings, RetryPassTarget, Store } from './store.js';
import { serializeRelaySource, type RelayItem, type RelayPlan, type RelaySource } from './relayState.js';

const previewLifetimeMs = 5 * 60 * 1000;

export type RetryPreview = {
  id: string;
  groupId: string;
  messageId: string;
  requesterId: string;
  settingsRevision: number;
  requestMessageAtMs: number;
  issuedAtMs: number;
  expiresAtMs: number;
  groupGeneration: number;
  sourceGeneration: number;
  sourceBefore: RelaySource;
  sourceAfter: RelaySource;
  targets: RetryPassTarget[];
};

export type RetryPreviewInput = Omit<RetryPreview, 'id' | 'issuedAtMs' | 'expiresAtMs' | 'groupGeneration' | 'sourceGeneration'>;

export class RetryPreviewRegistry {
  private readonly previews = new Map<string, RetryPreview>();
  private readonly groupGenerations = new Map<string, number>();
  private readonly sourceGenerations = new Map<string, number>();

  constructor(private readonly createId: () => string = () => randomUUID()) {}

  issue(input: RetryPreviewInput, nowMs: number): { preview: RetryPreview; reused: boolean } {
    for (const [key, preview] of this.previews) if (nowMs >= preview.expiresAtMs) this.previews.delete(key);
    const key = previewKey(input.groupId, input.messageId, input.requesterId);
    const existing = this.previews.get(key);
    if (existing && nowMs < existing.expiresAtMs) return { preview: existing, reused: true };
    const preview: RetryPreview = { ...input, id: this.createId(), issuedAtMs: nowMs, expiresAtMs: nowMs + previewLifetimeMs,
      groupGeneration: this.groupGenerations.get(input.groupId) ?? 0,
      sourceGeneration: this.sourceGenerations.get(previewKey(input.groupId, input.messageId, '')) ?? 0 };
    this.previews.set(key, preview);
    return { preview, reused: false };
  }

  get(groupId: string, messageId: string, requesterId: string): RetryPreview | null {
    return this.previews.get(previewKey(groupId, messageId, requesterId)) ?? null;
  }

  consume(groupId: string, messageId: string, requesterId: string): RetryPreview | null {
    const key = previewKey(groupId, messageId, requesterId);
    const preview = this.previews.get(key);
    if (!preview) return null;
    this.previews.delete(key);
    return preview;
  }

  invalidateGroup(groupId: string): void {
    this.groupGenerations.set(groupId, (this.groupGenerations.get(groupId) ?? 0) + 1);
    for (const [key, preview] of this.previews) if (preview.groupId === groupId) this.previews.delete(key);
  }

  invalidateSource(groupId: string, messageId: string): void {
    const sourceKey = previewKey(groupId, messageId, '');
    this.sourceGenerations.set(sourceKey, (this.sourceGenerations.get(sourceKey) ?? 0) + 1);
    for (const [key, preview] of this.previews) {
      if (preview.groupId === groupId && preview.messageId === messageId) this.previews.delete(key);
    }
  }

  isValid(preview: RetryPreview): boolean {
    return preview.groupGeneration === (this.groupGenerations.get(preview.groupId) ?? 0)
      && preview.sourceGeneration === (this.sourceGenerations.get(previewKey(preview.groupId, preview.messageId, '')) ?? 0);
  }
}

export class RetryValidationError extends Error {
  constructor(readonly reason: 'source-unavailable' | 'source-changed' | 'settings-changed' | 'not-eligible') {
    super(reason);
  }
}

export type RetryPreparationStore = Pick<Store, 'getMediaAttempt' | 'getMediaDisposition' | 'wasRecentlyPosted'>;

export async function prepareRetryWork(
  source: RelaySource,
  store: RetryPreparationStore,
  downloader: Pick<Downloader, 'resolveYouTube' | 'resolveInstagram'>,
  settings: GroupSettings,
  nowMs: number,
): Promise<{ sourceAfter: RelaySource; targets: RetryPassTarget[] }> {
  const retryableHold = source.holdReason === 'stale' || source.holdReason === 'retry-unresolved-send'
    || source.holdReason === 'retry-interrupted-with-unknown-send';
  if (!settings.enabled || (source.status === 'held' && !retryableHold)
    || !Number.isSafeInteger(source.acceptedAtMs) || nowMs < source.acceptedAtMs) {
    throw new RetryValidationError('not-eligible');
  }

  const candidates = new Map<number, number[]>();
  for (const [linkIndex, link] of source.links.entries()) {
    if (link.status === 'skipped') continue;
    if (!link.plan) {
      if (!['ready', 'failed'].includes(link.status)) continue;
      if (settings.duplicateWindowHours > 0
        && store.wasRecentlyPosted(source.groupId, link.urlHash, nowMs, settings.duplicateWindowHours)) continue;
      candidates.set(linkIndex, []);
      continue;
    }
    for (const item of link.plan.items) {
      if (item.kind !== 'video' || !item.identity || !['ready', 'failed'].includes(item.status)) continue;
      const key = { groupId: source.groupId, messageId: source.messageId, identity: item.identity };
      if (store.getMediaAttempt(key)) continue;
      if (store.getMediaDisposition(key, nowMs, settings.duplicateWindowHours) !== 'ready') continue;
      candidates.set(linkIndex, [...(candidates.get(linkIndex) ?? []), item.index]);
    }
  }
  if (!candidates.size) throw new RetryValidationError('not-eligible');

  const sourceAfter = cloneSource(source);
  for (const [linkIndex, link] of source.links.entries()) {
    const isCandidate = candidates.has(linkIndex);
    if (!link.plan && !isCandidate) continue;
    const freshPlan = await resolvePlan(link, downloader);
    if (link.plan && planSignature(freshPlan) !== planSignature(link.plan)) throw new RetryValidationError('source-changed');
    if (!link.plan) {
      const projected = { ...sourceAfter.links[linkIndex], plan: freshPlan };
      for (const item of projected.plan!.items) {
        if (!item.identity) continue;
        const disposition = store.getMediaDisposition({ groupId: source.groupId, messageId: source.messageId, identity: item.identity }, nowMs, settings.duplicateWindowHours);
        item.status = disposition === 'ready' ? 'ready' : disposition === 'completed' ? 'confirmed' : disposition === 'duplicate' ? 'skipped' : 'held';
      }
      sourceAfter.links[linkIndex] = projected;
    }
    const savedPlan = sourceAfter.links[linkIndex].plan;
    if (savedPlan) {
      for (const item of savedPlan.items) {
        if (!item.identity || !['ready', 'failed'].includes(item.status)) continue;
        const key = { groupId: source.groupId, messageId: source.messageId, identity: item.identity };
        const attempt = store.getMediaAttempt(key);
        if (attempt?.status === 'confirmed') { item.status = 'confirmed'; continue; }
        if (attempt?.status === 'sending') { item.status = 'held'; continue; }
        const disposition = store.getMediaDisposition(key, nowMs, settings.duplicateWindowHours);
        item.status = disposition === 'ready' ? 'ready' : disposition === 'completed' ? 'confirmed' : disposition === 'duplicate' ? 'skipped' : 'held';
      }
    }
  }

  const targets: RetryPassTarget[] = [];
  for (const [linkIndex, candidateItems] of candidates) {
    const currentLink = source.links[linkIndex];
    const preparedLink = sourceAfter.links[linkIndex];
    const itemIndexes = currentLink.plan ? candidateItems : preparedLink.plan!.items
      .filter((item) => item.kind === 'video' && item.identity
        && store.getMediaDisposition({ groupId: source.groupId, messageId: source.messageId, identity: item.identity }, nowMs, settings.duplicateWindowHours) === 'ready')
      .map((item) => item.index);
    if (!itemIndexes.length || !preparedLink.plan) continue;
    for (const itemIndex of itemIndexes) {
      const item = preparedLink.plan.items.find((candidate) => candidate.index === itemIndex);
      if (!item?.identity || store.getMediaDisposition({ groupId: source.groupId, messageId: source.messageId, identity: item.identity }, nowMs, settings.duplicateWindowHours) !== 'ready') continue;
      item.status = 'ready';
    }
    const eligible = itemIndexes.filter((itemIndex) => preparedLink.plan!.items.some((item) => item.index === itemIndex && item.status === 'ready'));
    if (!eligible.length) continue;
    preparedLink.status = 'ready';
    targets.push({ linkIndex, itemIndexes: eligible });
  }

  if (!targets.length) throw new RetryValidationError('not-eligible');
  sourceAfter.status = 'ready';
  delete sourceAfter.holdReason;
  return { sourceAfter, targets };
}

export async function checkRetryLinkPlan(link: RelaySource['links'][number], downloader: Pick<Downloader, 'resolveYouTube' | 'resolveInstagram'>): Promise<'matching' | 'changed' | 'unavailable'> {
  if (!link.plan) return 'unavailable';
  try { return planSignature(await resolvePlan(link, downloader)) === planSignature(link.plan) ? 'matching' : 'changed'; }
  catch { return 'unavailable'; }
}

export function sameRetrySource(left: RelaySource, right: RelaySource): boolean {
  return serializeRelaySource(left) === serializeRelaySource(right);
}

function previewKey(groupId: string, messageId: string, requesterId: string): string {
  return JSON.stringify([groupId, messageId, requesterId]);
}

function cloneSource(source: RelaySource): RelaySource {
  return structuredClone(source);
}

function planSignature(plan: RelayPlan): string {
  return JSON.stringify({
    parentId: plan.parentId,
    totalItems: plan.totalItems,
    items: plan.items.map(({ index, kind, identity }) => ({ index, kind, identity })),
  });
}

async function resolvePlan(link: RelaySource['links'][number], downloader: Pick<Downloader, 'resolveYouTube' | 'resolveInstagram'>): Promise<RelayPlan> {
  try {
    if (link.platform === 'youtube') {
      const video = await downloader.resolveYouTube(link.url);
      if (!video.id?.trim()) throw new Error('unavailable');
      const identity = { platform: 'youtube' as const, videoId: video.id };
      return { parentId: video.id, totalItems: 1, items: [{ index: 1, kind: 'video', identity, status: 'ready' }] };
    }
    const source = await downloader.resolveInstagram(link.url);
    if (!source.id?.trim() || !Number.isSafeInteger(source.totalItems) || source.totalItems < 1 || !source.items.length) throw new Error('unavailable');
    const items: RelayItem[] = source.items.map((item) => ({
      index: item.index,
      kind: item.kind,
      status: item.kind === 'video' ? 'ready' : 'skipped',
      ...(item.kind === 'video' ? { identity: { platform: 'instagram' as const, postId: source.id, itemId: item.id } } : {}),
    }));
    return { parentId: source.id, totalItems: source.totalItems, items };
  } catch {
    throw new RetryValidationError('source-unavailable');
  }
}
