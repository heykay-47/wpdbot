import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWhatsappBot } from '../dist/whatsapp.js';
import { createDownloader } from '../dist/downloader.js';
import { createStore } from '../dist/store.js';
import { prepareWhatsappRuntime } from '../dist/whatsappRuntime.js';

test('WhatsApp initializes a real browser with an isolated profile and offline page', { timeout: 30_000 }, async () => {
  assert.ok(process.env.PUPPETEER_EXECUTABLE_PATH, 'Set PUPPETEER_EXECUTABLE_PATH to an installed Chrome/Chromium binary');
  const root = await mkdtemp(join(tmpdir(), 'wpdbot-browser-'));
  const store = createStore(':memory:');
  const runtimePaths = await prepareWhatsappRuntime({ authDir: join(root, 'auth'), cacheDir: join(root, 'cache') });
  const config = {
    ownerId: 'owner@c.us',
    sqlitePath: ':memory:',
    timezone: 'UTC',
    maxFileSizeMb: 64,
    duplicateWindowHours: 24,
    downloadDir: join(root, 'downloads'),
    concurrentDownloads: 1,
  };
  const { client } = createWhatsappBot({
    config,
    store,
    downloader: createDownloader({ downloadDir: config.downloadDir }),
    runtimePaths,
  });

  // Replace WhatsApp content and injection, not browser launch or profile setup.
  client.initWebVersionCache = async () => {
    await client.pupPage.setRequestInterception(true);
    client.pupPage.on('request', (request) => {
      void request.respond({ status: 200, contentType: 'text/html', body: '<title>wpdbot offline smoke</title>' });
    });
  };
  let injections = 0;
  client.inject = async () => { injections += 1; };

  try {
    await client.initialize();
    assert.equal(await client.pupPage.title(), 'wpdbot offline smoke');
    assert.equal(await client.pupPage.evaluate(() => document.title), 'wpdbot offline smoke');
    assert.equal(injections, 1);
    assert.ok(existsSync(runtimePaths.chromeProfileDir));
    await client.destroy();
    assert.equal(client.pupBrowser.connected, false, 'Client.destroy() must close the browser connection');
  } finally {
    if (client.pupBrowser?.connected) await client.pupBrowser.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
