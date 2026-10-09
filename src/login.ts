import { openSync, writeSync, closeSync } from 'node:fs';
import qrcode from 'qrcode-terminal';
import whatsappWeb from 'whatsapp-web.js';
import { acquireAuthLock } from './authLock.js';
import { prepareWhatsappRuntime, resolveWhatsappRuntimePaths } from './whatsappRuntime.js';

export async function privateLogin(options: { terminate?: (code: number) => never } = {}): Promise<void> {
  // /dev/tty bypasses Docker logs and rejects noninteractive invocation. No relay,
  // database, downloader, stdout QR, logout, or authentication deletion is used.
  const terminal = openSync('/dev/tty', 'w');
  const paths = resolveWhatsappRuntimePaths();
  let release: (() => void) | undefined;
  let client: InstanceType<typeof whatsappWeb.Client> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupt: (() => void) | undefined;
  let initializationSettled = false;
  const terminate = options.terminate ?? ((code: number): never => process.exit(code));
  const abort = (): never => { writeSync(terminal, '\x1b[2J\x1b[HPrivate login stopped.\n'); return terminate(1); };
  try {
    release = acquireAuthLock(paths.authDir);
    await prepareWhatsappRuntime(paths);
    client = new whatsappWeb.Client({ authStrategy: new whatsappWeb.LocalAuth({ dataPath: paths.authDir }),
      puppeteer: { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', `--disk-cache-dir=${paths.chromeCacheDir}`] } });
    const loginClient = client;
    writeSync(terminal, 'Private one-shot login. Do not record or share this terminal.\n');
    let initialization: Promise<void>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Login timed out')), 5 * 60_000);
      interrupt = () => reject(new Error('Login interrupted'));
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
    });
    const ready = new Promise<void>((resolve, reject) => {
      loginClient.on('qr', (qr) => qrcode.generate(qr, { small: true }, (rendered) => writeSync(terminal, `\x1b[2J\x1b[H${rendered}\n`)));
      loginClient.once('ready', resolve);
      loginClient.once('auth_failure', () => reject(new Error('Login failed')));
      loginClient.once('disconnected', () => reject(new Error('Login disconnected')));
      initialization = loginClient.initialize().finally(() => { initializationSettled = true; });
      void initialization.catch(reject);
    });
    await Promise.race([Promise.all([ready, initialization!]), deadline]);
    writeSync(terminal, '\x1b[2J\x1b[HAuthentication ready. Start the normal service.\n');
  } finally {
    clearTimeout(timer);
    if (interrupt) { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
    // Never release ownership while initialization or browser teardown can still
    // use the profile. A stalled one-shot process must exit, releasing its OS lock.
    try {
      if (client && !initializationSettled) abort();
      if (client) {
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const destroyed = await Promise.race([
            client.destroy().then(() => true, () => false),
            new Promise<false>((resolve) => { cleanupTimer = setTimeout(() => resolve(false), 30_000); }),
          ]);
          if (!destroyed) abort();
        } finally { clearTimeout(cleanupTimer); }
      }
      release?.();
    } finally { writeSync(terminal, '\x1b[2J\x1b[HPrivate login finished.\n'); closeSync(terminal); }
  }
}
