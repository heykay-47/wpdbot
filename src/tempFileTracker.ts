import { rm } from 'node:fs/promises';

type TrackedPath = { path: string; recursive: boolean };

export class TempFileTracker {
  private readonly paths: TrackedPath[] = [];

  addFile(path: string): void {
    this.paths.push({ path, recursive: false });
  }

  addDirectory(path: string): void {
    this.paths.push({ path, recursive: true });
  }

  async cleanup(): Promise<void> {
    for (const item of [...this.paths].reverse()) {
      await rm(item.path, { force: true, recursive: item.recursive }).catch(() => undefined);
    }
    this.paths.length = 0;
  }
}
