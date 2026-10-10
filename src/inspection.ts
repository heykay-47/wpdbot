import type { CleanupDeferral, RelaySource } from './relayState.js';
import type { Store } from './store.js';

export function sourceUnfinished(source: RelaySource, store: InspectionStore): boolean {
  return sourceMediaUnfinished(source, store) || (source.version === 2 && (source.cleanup.intentRecorded
    || (!source.cleanup.disqualifications.length && source.cleanup.deferredReason !== undefined)));
}

export function sourceMediaUnfinished(source: RelaySource, store: InspectionStore): boolean {
  return source.status !== 'settled' || source.links.some((link) => link.status === 'failed'
    || link.plan?.items.some((_item, itemIndex) => !['confirmed', 'skipped'].includes(itemOutcome(store, source, source.links.indexOf(link), itemIndex))));
}

type InspectionStore = Pick<Store, 'getMediaAttempt'>;
type ItemOutcome = 'skipped' | 'confirmed' | 'delivery_unknown' | 'held' | 'failed' | 'ready';

function itemOutcome(store: InspectionStore, source: RelaySource, linkIndex: number, itemIndex: number): ItemOutcome {
  const item = source.links[linkIndex].plan!.items[itemIndex];
  if (item.status === 'skipped') return 'skipped';
  if (item.identity) {
    const attempt = store.getMediaAttempt({ groupId: source.groupId, messageId: source.messageId, identity: item.identity });
    if (attempt?.status === 'confirmed') return 'confirmed';
    if (attempt?.status === 'sending') return 'delivery_unknown';
  }
  return item.status;
}

const outcomeText: Record<ItemOutcome, string> = {
  skipped: 'skipped', confirmed: 'confirmed', ready: 'queued / preparing', failed: 'failed before send; cause unavailable',
  held: 'held; delivery/source evidence unresolved — do not retry',
  delivery_unknown: 'delivery unknown; may already have been delivered — do not retry or repost',
};

export function formatSourceInspection(store: InspectionStore, source: RelaySource): string {
  const lines = [`Ref ${source.workReference ?? 'unavailable'} — ${source.status}`, cleanupSummary(source)];
  let shown = 0;
  for (const [linkIndex, link] of source.links.entries()) {
    if (shown >= 20) { lines.push('More positions omitted from this bounded view.'); break; }
    if (!link.plan) { lines.push(`Link ${linkIndex + 1} — ${link.status === 'failed' ? 'failed before send; cause unavailable' : link.status === 'skipped' ? 'skipped' : 'queued / inspecting'}`); shown++; }
    else for (const [itemIndex, item] of link.plan.items.entries()) {
      if (shown++ >= 20) { lines.push('More positions omitted from this bounded view.'); break; }
      lines.push(`Link ${linkIndex + 1}, item ${item.index} — ${outcomeText[itemOutcome(store, source, linkIndex, itemIndex)]}`);
    }
  }
  if (source.status === 'held') {
    lines.push(source.holdReason === 'retry-unresolved-send' || source.holdReason === 'retry-interrupted-with-unknown-send'
      ? 'Source held because a send may have occurred; delivery-unknown items must not be retried. Only exact positive evidence can resolve this hold.'
      : 'Source held; saved validation/age evidence prevents automatic recovery.');
  }
  return lines.join('\n');
}

function cleanupSummary(source: RelaySource): string {
  if (source.version === 1) return 'Source retained; legacy sources are never cleanup-eligible.';
  if (source.cleanup.intentRecorded) {
    switch (source.cleanup.outcome) {
      case 'unknown': return 'Cleanup intent recorded; outcome unknown — no further attempt.';
      case 'not-invoked': return 'Cleanup intent consumed; deletion was not invoked — no further attempt.';
      case 'threw': return 'Cleanup attempt threw; remote outcome uncertain — no further attempt.';
      case 'returned-unverified': return 'Cleanup request returned; group-wide removal unverified — no further attempt.';
      case 'not-attempted': return 'Cleanup intent recorded; outcome unavailable — no further attempt.';
    }
  }
  if (source.cleanup.initial === 'mixed-content') return 'Source retained; mixed-content sources are never cleaned up.';
  const reason = source.cleanup.disqualifications[0];
  if (reason) {
    const text: Record<typeof reason, string> = {
      'prior-message-duplicate': 'prior-message duplicate skip',
      'skipped-media': 'skipped or unverifiable media',
      'document-repost': 'document repost',
      'source-edited': 'source edit or identity mismatch',
      'media-plan-changed': 'media plan changed',
      expired: 'cleanup age expired',
      'clock-uncertain': 'acceptance time uncertain',
    };
    return `Source retained; cleanup ineligible (${text[reason]}).`;
  }
  if (source.cleanup.deferredReason) {
    const text: Record<CleanupDeferral, string> = {
      'media-unconfirmed': 'inline repost evidence incomplete',
      'group-disabled': 'group was disabled at the last check',
      'source-missing': 'source missing at the last lookup',
      'source-unavailable': 'source lookup unavailable at the last check',
      'authority-unavailable': 'deletion authority unavailable at the last check',
      'client-unavailable': 'client unavailable at the last check',
      'storage-unavailable': 'storage verification failed at the last check',
    };
    return `Source retained; cleanup deferred (${text[source.cleanup.deferredReason]}).`;
  }
  return 'Source retained; guarded cleanup is pending confirmed inline reposts and fresh safety checks.';
}

export function formatGroupInspection(store: Store, groupId: string): string {
  const sources = store.listRelaySources().filter((source) => source.groupId === groupId && sourceUnfinished(source, store));
  return [`Unfinished work in this group: ${sources.length} sources`, ...sources.slice(0, 10).map((source) => {
    const failed = source.links.some((link, linkIndex) => link.status === 'failed' || link.plan?.items.some((_item, itemIndex) => itemOutcome(store, source, linkIndex, itemIndex) === 'failed'));
    const unknown = source.links.some((link, linkIndex) => link.plan?.items.some((_item, itemIndex) => itemOutcome(store, source, linkIndex, itemIndex) === 'delivery_unknown'));
    return `${source.workReference ?? 'Reference unavailable'} — ${source.status}${failed ? '; failed items' : ''}${unknown ? '; delivery unknown — do not retry' : ''}\n  ${source.links.length} links · ${cleanupSummary(source)}`;
  }),
  ...(sources.length > 10 ? ['More sources omitted. Reply to a source with !bot inspect for its current status.'] : [])].join('\n\n');
}
