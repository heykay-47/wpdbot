import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createDownloader } from './downloader.js';
import { KeyedTaskQueue } from './keyedTaskQueue.js';
import { createStore, type Store } from './store.js';
import { createWhatsappBot, type WhatsappBot } from './whatsapp.js';

export function main(): void {
  const config = loadConfig();
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
  const bot = createWhatsappBot({ config, store, downloader, queue });

  installShutdownHandlers(bot, store);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
