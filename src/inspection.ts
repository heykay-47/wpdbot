import type { RelaySource } from './relayState.js';
import type { Store } from './store.js';

export function sourceUnfinished(source: RelaySource, store: InspectionStore): boolean {
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
  const lines = [`Ref ${source.workReference ?? 'unavailable'} — ${source.status}`, 'Original retained.'];
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

export function formatGroupInspection(store: Store, groupId: string): string {
  const sources = store.listRelaySources().filter((source) => source.groupId === groupId && sourceUnfinished(source, store));
  return [`Unfinished work in this group: ${sources.length} sources`, ...sources.slice(0, 10).map((source) => {
    const failed = source.links.some((link, linkIndex) => link.status === 'failed' || link.plan?.items.some((_item, itemIndex) => itemOutcome(store, source, linkIndex, itemIndex) === 'failed'));
    const unknown = source.links.some((link, linkIndex) => link.plan?.items.some((_item, itemIndex) => itemOutcome(store, source, linkIndex, itemIndex) === 'delivery_unknown'));
    return `${source.workReference ?? 'Reference unavailable'} — ${source.status}${failed ? '; failed items' : ''}${unknown ? '; delivery unknown — do not retry' : ''}\n  ${source.links.length} links · original retained`;
  }),
  ...(sources.length > 10 ? ['More sources omitted. Reply to a source with !bot inspect for its current status.'] : [])].join('\n\n');
}
