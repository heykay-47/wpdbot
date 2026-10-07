import { afterEach, expect, it, vi } from 'vitest';
import { RelayLifecycle } from '../src/relayLifecycle';

afterEach(() => vi.useRealTimers());

it('stops new submissions immediately but permits outstanding evidence until its bounded shutdown ends', async () => {
  vi.useFakeTimers();
  const lifecycle = new RelayLifecycle();
  lifecycle.track(new Promise(() => undefined));
  const drained = lifecycle.stop(30_000);
  expect(lifecycle.canSubmit()).toBe(false);
  expect(lifecycle.canPersist()).toBe(true);
  await vi.advanceTimersByTimeAsync(30_000);
  await drained;
  lifecycle.close();
  expect(lifecycle.canPersist()).toBe(false);
});

it('finishes its grace period early when the last active submission settles', async () => {
  const lifecycle = new RelayLifecycle();
  let finish!: () => void;
  lifecycle.track(new Promise<void>((resolve) => { finish = resolve; }));
  const drained = lifecycle.stop(30_000);
  finish();
  await drained;
  expect(lifecycle.canSubmit()).toBe(false);
});
