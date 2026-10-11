import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('private Compose operations preserve a quiesced SQLite/LocalAuth pair', { timeout: 1_200_000 }, async () => {
  const work = mkdtempSync(join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'wpdbot-docker-qualification-'));
  const project = `wpdbot-qualification-${randomUUID()}`;
  const image = `${project}:test`;
  const envFile = join(work, 'synthetic.env');
  const override = join(work, 'override.yml');
  const cookies = join(work, 'cookies.txt');
  const snapshot = join(work, 'snapshot.tar.gz.gpg');
  const archive = join(work, 'snapshot.tar.gz');
  let imageBuilt = false;
  const env = { ...process.env, YT_DLP_COOKIES_HOST_PATH: '' };
  for (const key of Object.keys(env)) if (key.startsWith('COMPOSE_')) delete env[key];
  const composeArgs = ['compose', '--project-name', project, '--env-file', envFile,
    '-f', join(root, 'docker-compose.yml'), '-f', override];
  function run(command, args, options = {}) {
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 900_000,
      maxBuffer: 32 * 1024 * 1024, ...options });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${command} failed:\n${result.stderr?.toString()}\n${result.stdout?.toString()}`);
    return result.stdout;
  }
  const compose = (...args) => run('docker', [...composeArgs, ...args]);
  const helper = (...args) => compose('run', '--rm', '--no-deps', '-T', ...args);
  const fixture = (mode) => helper('wpdbot', 'node', '/app/docker-operations.mjs', mode);
  const inspect = (id) => JSON.parse(run('docker', ['inspect', id]))[0];
  const containerId = () => compose('ps', '-aq', 'wpdbot').trim();
  async function healthStatus(expected) {
    for (let tries = 0; tries < 40; tries++) {
      if (inspect(containerId()).State.Health.Status === expected) return;
      await delay(500);
    }
    assert.fail(`Docker health never became ${expected}`);
  }
  function endpoint(path, status) {
    compose('exec', '-T', 'wpdbot', 'node', '-e',
      `fetch('http://127.0.0.1:3000/health/${path}').then(r => { if(r.status !== ${status}) process.exit(1); })`);
  }
  function signal(name) { compose('exec', '-T', 'wpdbot', 'kill', `-${name}`, '1'); }
  function writeOverride() {
    writeFileSync(override, `services:
  wpdbot:
    image: ${image}
    build: !reset null
    env_file: !override [${JSON.stringify(envFile)}]
    network_mode: none
    depends_on: !reset []
    command: [node, /app/docker-operations.mjs, serve]
    healthcheck:
      interval: 1s
      timeout: 2s
      retries: 2
      start_period: 1s
    volumes:
      - type: bind
        source: ${JSON.stringify(join(root, 'tests/fixtures/docker-operations.mjs'))}
        target: /app/docker-operations.mjs
        read_only: true
        bind:
          create_host_path: false
`);
  }
  try {
    run('docker', ['info', '--format', '{{.ServerVersion}}']);
    run('gpg', ['--version']);
    writeFileSync(envFile, readFileSync(join(root, '.env.example')));
    writeOverride();
    const config = JSON.parse(compose('config', '--format', 'json'));
    assert.equal(config.services.wpdbot.network_mode, 'none');
    assert.deepEqual(config.services.wpdbot.depends_on ?? {}, {});
    assert.equal(config.services.wpdbot.restart, 'unless-stopped');
    assert.equal(config.services.wpdbot.stop_grace_period, '35s');
    assert.equal(config.services.wpdbot.logging.driver, 'none');
    assert.equal(config.services.wpdbot.environment.YT_DLP_COOKIES_PATH, '');
    assert.equal(config.services.wpdbot.ports, undefined);
    assert.ok(config.services.wpdbot.healthcheck.test.join(' ').includes('/health/ready'));
    for (const volume of Object.values(config.volumes)) assert.ok(volume.name.startsWith(`${project}_`));
    console.log('Building the repository Dockerfile (includes the full unit suite and TypeScript build).');
    run('docker', ['build', '-t', image, '.']);
    imageBuilt = true;
    fixture('seed');
    fixture('verify');
    compose('up', '-d', '--no-deps', 'wpdbot');
    await healthStatus('healthy');
    const id = containerId();
    const before = inspect(id);
    assert.equal(before.Config.User, 'wpdbot');
    assert.equal(before.HostConfig.NetworkMode, 'none');
    assert.deepEqual(before.HostConfig.PortBindings, {});
    assert.equal(before.HostConfig.LogConfig.Type, 'none');
    assert.equal(before.Config.Env.find((value) => value.startsWith('YT_DLP_COOKIES_PATH=')), 'YT_DLP_COOKIES_PATH=');
    const cookieMount = before.Mounts.find((mount) => mount.Destination === '/run/secrets/yt-dlp-cookies.txt');
    assert.equal(cookieMount.RW, false);
    assert.equal(cookieMount.Source, '/dev/null');
    endpoint('live', 200);
    for (const name of ['USR1', 'USR2', 'WINCH']) {
      signal(name);
      await healthStatus('unhealthy');
      endpoint('live', 200);
      endpoint('ready', 503);
      const unhealthy = inspect(id);
      assert.equal(unhealthy.State.Running, true);
      assert.equal(unhealthy.RestartCount, before.RestartCount, 'Unhealthy readiness must not restart the process');
      assert.equal(containerId(), id);
      signal(name);
      await healthStatus('healthy');
      endpoint('ready', 200);
    }
    console.log('PASS: passive health transitions, process liveness, loopback-only network, absent cookies.');

    // The actual runbook helper mounts and tar/cp commands, with synthetic noninteractive encryption.
    compose('stop', 'wpdbot');
    assert.equal(inspect(id).State.Running, false);
    assert.equal(inspect(id).State.ExitCode, 0);
    const pairedTar = run('docker', [...composeArgs, 'run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', 'wpdbot', '-ec',
      'test -f /data/bot.db && test -d /app/.wwebjs_auth && tar -C / -czf - data app/.wwebjs_auth'], { encoding: null });
    const gpgArgs = ['--homedir', work, '--batch', '--pinentry-mode', 'loopback', '--passphrase', 'SYNTHETIC-ONLY-NOT-A-REAL-SECRET'];
    run('gpg', [...gpgArgs, '--symmetric', '--cipher-algo', 'AES256', '--yes', '--output', snapshot], { input: pairedTar });
    chmodSync(snapshot, 0o600);
    assert.equal(statSync(snapshot).mode & 0o777, 0o600);
    run('gpg', [...gpgArgs, '--decrypt', '--output', archive, snapshot]);
    chmodSync(archive, 0o600);
    const members = run('tar', ['-tzf', archive]);
    assert.ok(members.includes('data/bot.db'));
    assert.ok(members.includes('app/.wwebjs_auth/session/Default/synthetic-auth'));
    assert.ok(!members.includes('.wwebjs_cache'));
    assert.ok(!members.includes('wpdbot-downloads'));
    helper('wpdbot', 'node', '-e', `
      const fs = require('node:fs'); const Database = require('better-sqlite3');
      const db = new Database('/data/bot.db'); db.exec('DELETE FROM media_relay_attempts; DELETE FROM relay_sources;'); db.close();
      fs.writeFileSync('/app/.wwebjs_auth/session/Default/synthetic-auth', 'SYNTHETIC-MUTATION');
      fs.writeFileSync('/data/post-snapshot-file', 'remove during restore');
    `);
    helper('-v', `${archive}:/restore/snapshot.tar.gz:ro`, '--user', '0:0', '--entrypoint', 'sh', 'wpdbot', '-ec', `
      mkdir -p /tmp/wpdbot-restore
      tar -xzf /restore/snapshot.tar.gz -C /tmp/wpdbot-restore
      test -f /tmp/wpdbot-restore/data/bot.db
      test -d /tmp/wpdbot-restore/app/.wwebjs_auth
      find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
      cp -a /tmp/wpdbot-restore/data/. /data/
      find /app/.wwebjs_auth -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
      cp -a /tmp/wpdbot-restore/app/.wwebjs_auth/. /app/.wwebjs_auth/
    `);
    helper('wpdbot', 'test', '!', '-e', '/data/post-snapshot-file');
    fixture('verify');
    compose('start', 'wpdbot');
    await healthStatus('healthy');
    console.log('PASS: encrypted paired snapshot, stopped restore, UID/modes, all rows and guards through two reopens.');

    writeFileSync(cookies, '# Netscape HTTP Cookie File\n# SYNTHETIC-ONLY\n', { mode: 0o644 });
    env.YT_DLP_COOKIES_HOST_PATH = cookies;
    // Allow only traversal of this synthetic temporary directory by the runtime UID.
    chmodSync(work, 0o711);
    compose('up', '-d', '--no-deps', '--force-recreate', 'wpdbot');
    await healthStatus('healthy');
    const withCookies = inspect(containerId());
    assert.equal(withCookies.Config.Env.find((value) => value.startsWith('YT_DLP_COOKIES_PATH=')),
      'YT_DLP_COOKIES_PATH=/run/secrets/yt-dlp-cookies.txt');
    assert.equal(withCookies.Mounts.find((mount) => mount.Destination === '/run/secrets/yt-dlp-cookies.txt').RW, false);
    compose('exec', '-T', 'wpdbot', 'node', '-e', `
      const fs = require('node:fs'); const assert = require('node:assert/strict');
      assert.equal(process.getuid(), 10001);
      assert.match(fs.readFileSync('/run/secrets/yt-dlp-cookies.txt', 'utf8'), /SYNTHETIC-ONLY/);
      assert.throws(() => fs.appendFileSync('/run/secrets/yt-dlp-cookies.txt', 'write'),
        (error) => ['EACCES', 'EROFS'].includes(error.code));
    `);
    compose('exec', '-T', '--user', '0:0', 'wpdbot', 'node', '-e', `
      const fs = require('node:fs'); const assert = require('node:assert/strict');
      assert.equal(process.getuid(), 0);
      assert.throws(() => fs.appendFileSync('/run/secrets/yt-dlp-cookies.txt', 'root-write'), { code: 'EROFS' });
    `);
    fixture('verify');
    console.log('PASS: optional cookie mount readable as UID 10001 and write rejected.');
  } finally {
    // Names are generated here; never use the normal deployment project or volumes.
    const cleanupErrors = [];
    if (existsSync(override)) {
      const cleanup = spawnSync('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans'],
        { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
      if (cleanup.status !== 0) cleanupErrors.push(`Disposable project ${project} cleanup failed: ${cleanup.error ?? cleanup.stderr}`);
    }
    if (imageBuilt) {
      const cleanup = spawnSync('docker', ['image', 'rm', image], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
      if (cleanup.status !== 0) cleanupErrors.push(`Disposable image ${image} cleanup failed: ${cleanup.error ?? cleanup.stderr}`);
    }
    if (cleanupErrors.length === 0) rmSync(work, { recursive: true, force: true });
    else assert.fail(`${cleanupErrors.join('\n')}\nRetained fixture configuration in ${work} for cleanup.`);
  }
});
