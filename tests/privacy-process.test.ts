import { fork, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acquireAuthLock } from '../src/authLock';

const roots: string[] = [];
const root = () => { const dir = mkdtempSync('/tmp/opencode/wpdbot-privacy-process-'); roots.push(dir); return dir; };
afterEach(() => roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

it.each(['exception', 'rejection'])('real process %s fallback cannot emit raw writes or private errors', async (mode) => {
  const dir = root();
  const child = fork(new URL('./fixtures/privacy-worker.ts', import.meta.url), [dir, mode], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk; }); child.stderr?.on('data', (chunk) => { output += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  expect(code).toBe(1);
  expect(output).toBe('');
  const entries = readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8')).join('');
  expect(entries).not.toContain('PRIVATE');
  expect(JSON.parse(entries)).toMatchObject({ stage: 'startup', cause: 'unknown' });
});

it('actual executable startup failure uses only bounded safe diagnostics before touching auth or relay state', async () => {
  const dir = root();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/entrypoint.ts'], {
    cwd: process.cwd(), env: { ...process.env, BOT_OWNER_ID: '', SQLITE_PATH: join(dir, 'private.sqlite'), DIAGNOSTICS_DIR: join(dir, 'diagnostics'), WHATSAPP_AUTH_DIR: join(dir, 'auth') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  expect(code).toBe(1); expect(output).toBe('');
  expect(readdirSync(dir)).toEqual(['diagnostics']);
  const diagnosticDir = join(dir, 'diagnostics');
  expect(JSON.parse(readFileSync(join(diagnosticDir, readdirSync(diagnosticDir)[0]), 'utf8'))).toMatchObject({ stage: 'startup', cause: 'unknown' });
});

it('auth-volume OS lock survives cross-process contention and is released by actual SIGKILL', async () => {
  const dir = root();
  const child = fork(new URL('./fixtures/privacy-worker.ts', import.meta.url), [dir, 'lock'], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Lock worker did not start')), 10_000);
      child.once('message', () => { clearTimeout(timer); resolve(); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Lock worker exited')); });
    });
    expect(() => acquireAuthLock(dir)).toThrow('already in use');
  } finally { child.kill('SIGKILL'); await exited; }
  const release = acquireAuthLock(dir); release();
});
