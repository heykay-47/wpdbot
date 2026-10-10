import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');

it('keeps health passive and checks readiness without publishing a port or changing restart policy', () => {
  expect(compose).toContain("fetch('http://127.0.0.1:3000/health/ready')");
  expect(compose).toContain('restart: unless-stopped');
  expect(compose).toContain('stop_grace_period: 35s');
  expect(compose).not.toContain('service_healthy');
  expect(compose).not.toMatch(/^\s+ports:/mu);
});

it('mounts an optional cookie file read-only at one stable container path', () => {
  expect(compose).toContain('source: ${YT_DLP_COOKIES_HOST_PATH:-/dev/null}');
  expect(compose).toContain('target: /run/secrets/yt-dlp-cookies.txt');
  expect(compose).toContain('read_only: true');
  expect(compose).toContain('create_host_path: false');
  expect(compose).not.toContain('/root/wpdbot');

  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  expect(example).toContain('YT_DLP_COOKIES_HOST_PATH=');
});

it('documents the private operations handoff without unsafe restore or reconciliation advice', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  expect(readme).toContain('## Operator Runbook');
  expect(readme).toMatch(/process liveness/iu);
  expect(readme).toContain('authenticated and ready');
  expect(readme).toContain('container runs as UID 10001');
  expect(readme).toContain('force-recreate wpdbot');
  expect(readme).toContain('one deliberate graceful restart');
  expect(readme).toContain('service should be running afterward');
  expect(readme).toContain('paired, quiesced snapshot');
  expect(readme).toContain('gpg --symmetric --cipher-algo AES256');
  expect(readme).toContain('mktemp --suffix=.tar.gz.gpg');
  expect(readme).toContain('Never restore SQLite alone');
  expect(readme).toContain('stored repost message ID');
  expect(readme).toContain('missing history');
  expect(readme).not.toContain('/root/wpdbot/youtube-cookies.txt');
});
