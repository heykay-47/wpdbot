import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { diagnosticEntry } from './errorReporter.js';

export const diagnosticMaxBytes = 30 * 1024 * 1024;
export const diagnosticMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

// Private bounded files, not Docker stdout: Docker size rotation alone cannot enforce age.
export function createDiagnostics(directory: string, options: { now?: () => number; maxBytes?: number; maxAgeMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const maxBytes = Math.min(options.maxBytes ?? diagnosticMaxBytes, diagnosticMaxBytes);
  const maxAgeMs = Math.min(options.maxAgeMs ?? diagnosticMaxAgeMs, diagnosticMaxAgeMs);
  let active: string | undefined;
  const prune = (incomingBytes = 0) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const files = readdirSync(directory).filter((name) => /^\d+-[a-f0-9]+\.jsonl$/u.test(name)).sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]))
      .map((name) => ({ name, size: statSync(join(directory, name)).size, time: Number(name.split('-')[0]) }));
    let bytes = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      // Expire one maintenance interval early, so an idle logger still meets the bound.
      if (now() - file.time < Math.max(0, maxAgeMs - 60_000) && file.time <= now() && bytes + incomingBytes <= maxBytes) continue;
      unlinkSync(join(directory, file.name));
      bytes -= file.size;
      if (active === file.name) active = undefined;
    }
  };
  const maintain = () => { try { prune(); } catch { /* Never fall back to raw console data. */ } };
  maintain();
  const timer = setInterval(maintain, 60_000);
  timer.unref();
  return {
    log(input: Record<string, unknown>) {
      try {
        const line = `${JSON.stringify(diagnosticEntry(input, now()))}\n`;
        const size = Buffer.byteLength(line);
        if (size > maxBytes) return;
        prune(size);
        if (active && statSync(join(directory, active)).size + size > Math.min(maxBytes, 1024 * 1024)) active = undefined;
        active ??= `${now()}-${randomBytes(8).toString('hex')}.jsonl`;
        appendFileSync(join(directory, active), line, { mode: 0o600 });
      } catch { /* Storage failure must not change relay behavior or emit private material. */ }
    },
    maintain,
    close() { clearInterval(timer); },
  };
}

// Install only at the executable boundary. Third-party console/direct writes and Node's
// exception fallback cannot leak credentials into Docker's ordinary retained logs.
export function isolateDiagnosticOutput(): void {
  const discard = (_chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') done();
    return true;
  };
  process.stdout.write = discard as typeof process.stdout.write;
  process.stderr.write = discard as typeof process.stderr.write;
}
