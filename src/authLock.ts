import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// SQLite's OS lock is shared across containers on the auth volume and released on
// process death. Never rely on container-local PIDs or delete a live Chromium lock.
export function acquireAuthLock(authDir: string): () => void {
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(authDir, 'instance-lock.db'), { timeout: 0 });
  try { db.exec('BEGIN EXCLUSIVE'); }
  catch { db.close(); throw new Error('Authentication profile is already in use'); }
  return () => { if (db.open) db.close(); };
}
