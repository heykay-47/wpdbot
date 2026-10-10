import 'dotenv/config';
import { loadConfig } from './config.js';
import { createDownloader } from './downloader.js';
import { messageForError } from './errorReporter.js';
import { KeyedTaskQueue } from './keyedTaskQueue.js';
import { createStore, type Store } from './store.js';
import { createWhatsappBot, type WhatsappBot } from './whatsapp.js';
import { acquireAuthLock } from './authLock.js';
import { createHealthServer } from './health.js';
import { resolveWhatsappRuntimePaths } from './whatsappRuntime.js';

export function main(logger?: (entry: Record<string, unknown>) => void): void {
  const config = loadConfig();
  const release = acquireAuthLock(resolveWhatsappRuntimePaths().authDir);
  const store = createStore(config.sqlitePath, {
    maxFileSizeMb: config.maxFileSizeMb,
    duplicateWindowHours: config.duplicateWindowHours,
  });

  store.setBotOwnerId(config.ownerId);

  const downloader = createDownloader({
    downloadDir: config.downloadDir,
    options: {
      cookiesPath: config.ytDlpCookiesPath,
      proxy: config.ytDlpProxy,
      maxDurationSeconds: config.maxDurationSeconds,
      maxMediaSizeMb: config.maxMediaSizeMb,
    },
  });
  const queue = new KeyedTaskQueue(config.concurrentDownloads);
  const bot = createWhatsappBot({ config, store, downloader, queue, logger });
  const health = createHealthServer(() => bot.isReady());
  void health.listen().catch((error: unknown) => { messageForError(error, { step: 'runtime', logger }); });

  installShutdownHandlers(bot, { close() { void health.close().catch(() => undefined); store.close(); release(); } });
  bot.start();
}

export function installShutdownHandlers(bot: Pick<WhatsappBot, 'stop'>, store: Pick<Store, 'close'>): void {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void bot.stop().then(() => {
      store.close();
      process.exit(0);
    }, () => {
      store.close();
      process.exit(1);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

}
