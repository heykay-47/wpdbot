export class RelayLifecycle {
  private stopping = false;
  private closed = false;
  private usable = true;
  private storageFailed = false;
  private readonly submissions = new Set<Promise<unknown>>();

  canSubmit(): boolean {
    return !this.stopping && !this.closed && this.usable && !this.storageFailed;
  }

  canPersist(): boolean {
    return !this.closed;
  }

  isStopping(): boolean {
    return this.stopping;
  }

  setUsable(usable: boolean): void {
    this.usable = usable;
  }

  failStorage(): void {
    this.storageFailed = true;
  }

  track<T>(submission: Promise<T>): Promise<T> {
    this.submissions.add(submission);
    void submission.then(() => this.submissions.delete(submission), () => this.submissions.delete(submission));
    return submission;
  }

  async stop(graceMs = 30_000): Promise<void> {
    this.stopping = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.submissions]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  close(): void {
    this.closed = true;
  }
}
