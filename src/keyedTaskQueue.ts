export class KeyedTaskQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly maxConcurrent: number;
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(maxConcurrent = Number.POSITIVE_INFINITY) {
    this.maxConcurrent = maxConcurrent;
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, current);

    await previous;

    const waitForSlot = this.acquire();
    if (waitForSlot) await waitForSlot;

    try {
      return await task();
    } finally {
      this.releaseSlot();
      release();
      if (this.tails.get(key) === current) {
        this.tails.delete(key);
      }
    }
  }

  runIfIdle<T>(key: string, task: () => Promise<T>): Promise<T> | null {
    if (this.tails.has(key)) return null;
    return this.run(key, task);
  }

  has(key: string): boolean {
    return this.tails.has(key);
  }

  activeCount(): number {
    return this.tails.size;
  }

  private acquire(): Promise<void> | undefined {
    if (this.running < this.maxConcurrent) {
      this.running += 1;
      return undefined;
    }

    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }

    this.running -= 1;
  }
}
