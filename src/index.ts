import 'dotenv/config';
import { loadConfig } from './config';
import { createDownloader } from './downloader';
import { createStore } from './store';
import { createWhatsappBot } from './whatsapp';

const config = loadConfig();
const store = createStore(config.sqlitePath, {
  maxFileSizeMb: config.maxFileSizeMb,
  duplicateWindowHours: config.duplicateWindowHours,
});

store.setBotOwnerId(config.ownerId);

const downloader = createDownloader({ downloadDir: config.downloadDir });
const bot = createWhatsappBot({ config, store, downloader });

process.on('SIGINT', () => {
  store.close();
  process.exit(0);
});

bot.start();
