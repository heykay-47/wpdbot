export type AppConfig = {
  ownerId: string;
  sqlitePath: string;
  timezone: string;
  maxFileSizeMb: number;
  duplicateWindowHours: number;
  downloadDir: string;
};

function readPositiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }

  return value;
}

function readRequired(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    ownerId: readRequired(env, 'BOT_OWNER_ID'),
    sqlitePath: readRequired(env, 'SQLITE_PATH'),
    timezone: env.TIMEZONE?.trim() || 'Asia/Kolkata',
    maxFileSizeMb: readPositiveInteger(env, 'MAX_FILE_SIZE_MB', 64),
    duplicateWindowHours: readPositiveInteger(env, 'DUPLICATE_WINDOW_HOURS', 24),
    downloadDir: env.DOWNLOAD_DIR?.trim() || '/tmp/wpdbot-downloads',
  };
}
