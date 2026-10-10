import { mediaIdentityKey } from './mediaIdentity.js';
import { messageForError, userError } from './errorReporter.js';
import { addCleanupDisqualification, serializeRelaySource, type CleanupDeferral, type CleanupDisqualification, type RelaySource } from './relayState.js';
import type { Store } from './store.js';

export type CleanupSourceIdentity = Pick<RelaySource, 'groupId' | 'messageId' | 'senderId' | 'contentHash'>;
export type CleanupCheckResult = 'ready' | 'missing' | 'unavailable' | 'mismatch' | 'authority-unavailable' | 'client-unavailable';
export type CleanupDeleteResult = Exclude<CleanupCheckResult, 'ready'> | 'blocked' | 'returned';
export type CleanupWhatsapp = {
  checkSourceForCleanup(source: CleanupSourceIdentity): Promise<CleanupCheckResult>;
  deleteSourceForCleanup(source: CleanupSourceIdentity, canInvoke: () => boolean): Promise<CleanupDeleteResult>;
};

type CleanupStore = Pick<Store, 'getRelaySource' | 'saveRelaySource' | 'beginRelaySourceCleanup'
  | 'recordRelaySourceCleanupOutcome' | 'getGroupSettings' | 'getMediaAttempt'>;

export type GuardedCleanupInput = {
  store: CleanupStore;
  whatsapp: CleanupWhatsapp & { sendText(groupId: string, text: string): Promise<void> };
  source: RelaySource;
  now: () => number;
  canSubmit: () => boolean;
  canPersist: () => boolean;
  failStorage: () => void;
  track?: <T>(operation: Promise<T>) => Promise<T>;
  logger?: (entry: Record<string, unknown>) => void;
};

const cleanupAgeLimitMs = 24 * 60 * 60 * 1000;

export function isLinkOnlySource(body: string, links: ReadonlyArray<{ url: string }>): boolean {
  if (!links.length) return false;
  let remainder = body;
  for (const link of links) remainder = remainder.split(link.url).join('');
  return remainder.trim().length === 0;
}

export async function attemptGuardedSourceCleanup(input: GuardedCleanupInput): Promise<void> {
  const { store, whatsapp, source, canSubmit, canPersist } = input;
  if (!canSubmit() || source.version !== 2 || source.cleanup.initial !== 'link-only' || source.cleanup.intentRecorded
    || source.cleanup.disqualifications.length) return;

  try {
    const current = store.getRelaySource(source.groupId, source.messageId);
    if (!current || !sameCleanupState(current, source) || current.version !== 2 || current.cleanup.intentRecorded
      || current.cleanup.initial !== 'link-only' || current.cleanup.disqualifications.length) return;
    if (!eligibleMediaIsConfirmed(current, store)) {
      deferAndSave(store, current, 'media-unconfirmed');
      return;
    }

    const ageReason = cleanupAgeFailure(input.now(), current.acceptedAtMs);
    if (ageReason) {
      disqualifyAndSave(store, current, ageReason);
      return;
    }
    if (!store.getGroupSettings(current.groupId).enabled) {
      deferAndSave(store, current, 'group-disabled');
      return;
    }

    const target = cleanupIdentity(current);
    const check = await whatsapp.checkSourceForCleanup(target).catch(() => 'unavailable' as const);
    if (check === 'mismatch') {
      disqualifyAndSave(store, current, 'source-edited');
      return;
    }
    if (check !== 'ready') {
      const reason = check === 'missing' ? 'source-missing' : check === 'unavailable' ? 'source-unavailable' : check;
      deferAndSave(store, current, reason);
      return;
    }
    if (!canSubmit()) return;

    const beforeIntent = store.getRelaySource(current.groupId, current.messageId);
    if (!beforeIntent || !sameCleanupState(beforeIntent, current) || beforeIntent.version !== 2) return;
    const beforeIntentAgeFailure = cleanupAgeFailure(input.now(), beforeIntent.acceptedAtMs);
    if (beforeIntentAgeFailure) {
      disqualifyAndSave(store, beforeIntent, beforeIntentAgeFailure);
      return;
    }
    if (!eligibleMediaIsConfirmed(beforeIntent, store)) {
      deferAndSave(store, beforeIntent, 'media-unconfirmed');
      return;
    }
    if (!store.getGroupSettings(current.groupId).enabled) {
      deferAndSave(store, beforeIntent, 'group-disabled');
      return;
    }
    if (!canSubmit()) return;
    if (!store.beginRelaySourceCleanup(beforeIntent)) return;

    const afterIntent = store.getRelaySource(current.groupId, current.messageId);
    if (!afterIntent || afterIntent.version !== 2 || !afterIntent.cleanup.intentRecorded) return;
    const finish = async () => {
      if (!canPersist()) return;
      let result: CleanupDeleteResult;
      let deletionThrew = false;
      let finalGuardStorageFailed = false;
      try {
        result = await whatsapp.deleteSourceForCleanup(target, () => {
          try {
            if (!canSubmit() || !canPersist() || !store.getGroupSettings(current.groupId).enabled) return false;
            const latest = store.getRelaySource(current.groupId, current.messageId);
            if (!latest || latest.version !== 2 || !latest.cleanup.intentRecorded || latest.cleanup.outcome !== 'unknown'
              || latest.cleanup.initial !== 'link-only' || latest.cleanup.disqualifications.length
              || latest.contentHash !== current.contentHash || !eligibleMediaIsConfirmed(latest, store, true)) return false;
            const finalAgeFailure = cleanupAgeFailure(input.now(), latest.acceptedAtMs);
            if (finalAgeFailure) {
              disqualifyAndSave(store, latest, finalAgeFailure);
              return false;
            }
            return true;
          } catch {
            finalGuardStorageFailed = true;
            input.failStorage();
            messageForError(userError('Cleanup state could not be verified', 'storage_failed'),
              { step: 'cleanup', reference: current.workReference, logger: input.logger });
            return false;
          }
        });
      } catch (error) {
        messageForError(error, { step: 'cleanup', reference: current.workReference, logger: input.logger });
        result = 'unavailable';
        deletionThrew = true;
      }

      if (!canPersist()) return;
      if (result === 'mismatch') {
        const latest = store.getRelaySource(current.groupId, current.messageId);
        if (latest) disqualifyAndSave(store, latest, 'source-edited');
      }
      const notify = !finalGuardStorageFailed && result !== 'returned' && canSubmit() && store.getGroupSettings(current.groupId).enabled;
      const outcome = result === 'returned' ? 'returned-unverified' : deletionThrew ? 'threw' : 'not-invoked';
      const claimed = store.recordRelaySourceCleanupOutcome(current.groupId, current.messageId, outcome, notify);
      if (!claimed || !notify || !canSubmit()) return;
      await whatsapp.sendText(current.groupId,
        `Source cleanup for Ref ${current.workReference ?? 'unavailable'} could not be confirmed; the source may still be visible. Reply to the source with !bot inspect.`)
        .catch((error: unknown) => { messageForError(error, { step: 'notification', reference: current.workReference, logger: input.logger }); });
    };
    const operation = finish();
    if (input.track) await input.track(operation);
    else await operation;
  } catch (error) {
    if (!canPersist()) return;
    input.failStorage();
    try {
      const latest = store.getRelaySource(source.groupId, source.messageId);
      if (latest) deferAndSave(store, latest, 'storage-unavailable');
    } catch { /* A failing store may not retain diagnostic state; never infer a successful write. */ }
    messageForError(userError('Cleanup state could not be verified', 'storage_failed'),
      { step: 'cleanup', reference: source.workReference, logger: input.logger });
  }
}

function deferAndSave(store: CleanupStore, source: RelaySource, reason: CleanupDeferral): void {
  if (source.version !== 2 || source.cleanup.intentRecorded || source.cleanup.disqualifications.length
    || source.cleanup.deferredReason === reason) return;
  source.cleanup.deferredReason = reason;
  store.saveRelaySource(source);
}

function eligibleMediaIsConfirmed(source: RelaySource, store: CleanupStore, allowIntent = false): boolean {
  if (source.version !== 2 || source.cleanup.initial !== 'link-only' || source.cleanup.disqualifications.length
    || (!allowIntent && source.cleanup.intentRecorded) || !source.links.length) return false;
  let changed = false;
  const incomplete = () => {
    if (changed) store.saveRelaySource(source);
    return false;
  };
  for (const link of source.links) {
    if (link.status === 'skipped') {
      disqualifyAndSave(store, source, 'prior-message-duplicate');
      return incomplete();
    }
    if (link.status !== 'ready' || !link.plan) return incomplete();
    for (const item of link.plan.items) {
      if (item.kind !== 'video') {
        disqualifyAndSave(store, source, 'skipped-media');
        return incomplete();
      }
      if (item.status === 'skipped') {
        disqualifyAndSave(store, source, 'prior-message-duplicate');
        return incomplete();
      }
      if (!item.identity) return incomplete();
      const attempt = store.getMediaAttempt({ groupId: source.groupId, messageId: source.messageId, identity: item.identity });
      if (attempt?.status !== 'confirmed') return incomplete();
      if (attempt.deliveryMode === 'document') {
        disqualifyAndSave(store, source, 'document-repost');
        return incomplete();
      }
      if (attempt.deliveryMode !== 'video' || !attempt.sentMessageId?.trim()
        || !Number.isSafeInteger(attempt.confirmedAtMs)
        || !Number.isInteger(attempt.ack) || attempt.ack! < 1 || attempt.ack! > 4
        || !source.links.some((candidate) => candidate.url === attempt.sourceUrl
          && candidate.plan?.items.some((other) => other.identity && mediaIdentityKey(other.identity) === mediaIdentityKey(item.identity!)))) return incomplete();
      if (item.status !== 'confirmed') { item.status = 'confirmed'; changed = true; }
    }
  }
  if (changed) store.saveRelaySource(source);
  return true;
}

function disqualifyAndSave(store: CleanupStore, source: RelaySource, reason: CleanupDisqualification): void {
  if (addCleanupDisqualification(source, reason)) store.saveRelaySource(source);
}

function cleanupIdentity(source: RelaySource): CleanupSourceIdentity {
  return { groupId: source.groupId, messageId: source.messageId, senderId: source.senderId, contentHash: source.contentHash };
}

function cleanupAgeFailure(nowMs: number, acceptedAtMs: number): CleanupDisqualification | null {
  const age = nowMs - acceptedAtMs;
  if (!Number.isSafeInteger(nowMs) || age < 0) return 'clock-uncertain';
  return age > cleanupAgeLimitMs ? 'expired' : null;
}

function sameCleanupState(left: RelaySource, right: RelaySource): boolean {
  if (left.version !== 2 || right.version !== 2) return false;
  return serializeRelaySource(left) === serializeRelaySource(right);
}
