import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDiagnostics, diagnosticMaxAgeMs, diagnosticMaxBytes } from '../src/diagnostics';

const roots: string[] = [];
const logs: ReturnType<typeof createDiagnostics>[] = [];
const root = () => { const dir = mkdtempSync('/tmp/opencode/wpdbot-diagnostics-'); roots.push(dir); return dir; };
const bytes = (dir: string) => readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
afterEach(() => { logs.splice(0).forEach((log) => log.close()); roots.splice(0).forEach((dir) => rmSync(dir, { force: true, recursive: true })); vi.useRealTimers(); });

it('independently enforces the actual 30 MiB total cap across rotation and restart', () => {
  const dir = root();
  const now = 1_800_000_000_000;
  writeFileSync(join(dir, `${now - 1}-aaaa.jsonl`), Buffer.alloc(diagnosticMaxBytes - 50));
  const log = createDiagnostics(dir, { now: () => now }); logs.push(log);
  log.log({ stage: 'download', cause: 'unknown', private: 'CANARY', stderr: 'CANARY' });
  expect(bytes(dir)).toBeLessThanOrEqual(diagnosticMaxBytes);
  expect(readdirSync(dir).length).toBeGreaterThan(0);
  expect(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')).not.toContain('CANARY');
  log.close();
  const reopened = createDiagnostics(dir, { now: () => now, maxBytes: 256 }); logs.push(reopened);
  for (let n = 0; n < 20; n++) reopened.log({ stage: 'startup', cause: 'unknown' });
  expect(bytes(dir)).toBeLessThanOrEqual(256);
  expect(readdirSync(dir).length).toBeLessThanOrEqual(3);
});

it('independently expires diagnostics within seven days during idle operation and on restart', () => {
  vi.useFakeTimers();
  const dir = root();
  vi.setSystemTime(1_800_000_000_000);
  const log = createDiagnostics(dir); logs.push(log);
  log.log({ stage: 'startup' });
  expect(readdirSync(dir)).toHaveLength(1);
  vi.advanceTimersByTime(diagnosticMaxAgeMs);
  expect(readdirSync(dir)).toEqual([]);
  writeFileSync(join(dir, `${Date.now() - diagnosticMaxAgeMs}-bbbb.jsonl`), '{}\n');
  const reopened = createDiagnostics(dir); logs.push(reopened);
  expect(readdirSync(dir)).toEqual([]);
});

it('logger storage failure never throws or falls back to ordinary output', () => {
  const dir = root();
  const file = join(dir, 'not-a-directory'); writeFileSync(file, 'private');
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const log = createDiagnostics(file); logs.push(log);
  expect(() => log.log({ message: 'CANARY', stack: 'CANARY' })).not.toThrow();
  expect(error).not.toHaveBeenCalled();
  error.mockRestore();
});
