import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createDownloader } from './downloader.js';
import { KeyedTaskQueue } from './keyedTaskQueue.js';
import { createStore } from './store.js';
import { createWhatsappBot } from './whatsapp.js';

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
    },
  });
  const queue = new KeyedTaskQueue(config.concurrentDownloads);
  const bot = createWhatsappBot({ config, store, downloader, queue });

  process.on('SIGINT', () => {
    store.close();
    process.exit(0);
  });

  bot.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
