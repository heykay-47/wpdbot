import { describe, expect, it } from 'vitest';
import { KeyedTaskQueue } from '../src/keyedTaskQueue';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('KeyedTaskQueue', () => {
  it('serializes tasks with the same key', async () => {
    const queue = new KeyedTaskQueue();
    const firstGate = deferred();
    const events: string[] = [];

    const first = queue.run('group:url', async () => {
      events.push('first:start');
      await firstGate.promise;
      events.push('first:end');
    });
    const second = queue.run('group:url', async () => {
      events.push('second:start');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('allows different keys to run concurrently', async () => {
    const queue = new KeyedTaskQueue();
    const gate = deferred();
    const events: string[] = [];

    const first = queue.run('a', async () => {
      events.push('a:start');
      await gate.promise;
    });
    const second = queue.run('b', async () => {
      events.push('b:start');
    });

    await second;
    expect(events).toEqual(['a:start', 'b:start']);
    gate.resolve();
    await first;
    expect(queue.activeCount()).toBe(0);
  });

  it('caps concurrent tasks across different keys', async () => {
    const queue = new KeyedTaskQueue(1);
    const firstGate = deferred();
    const events: string[] = [];

    const first = queue.run('a', async () => {
      events.push('a:start');
      await firstGate.promise;
      events.push('a:end');
    });
    const second = queue.run('b', async () => {
      events.push('b:start');
    });

    await Promise.resolve();
    expect(events).toEqual(['a:start']);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start']);
  });
});
