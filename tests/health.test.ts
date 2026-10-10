import { afterEach, expect, it } from 'vitest';
import { createHealthServer } from '../src/health';

const servers: Array<ReturnType<typeof createHealthServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

it('reports process liveness separately from readiness as dependencies change', async () => {
  let sqliteOpen = false;
  let whatsappReady = false;
  const server = createHealthServer(() => sqliteOpen && whatsappReady, 0);
  servers.push(server);
  const port = await server.listen();
  const request = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);

  expect((await request('/health/live')).status).toBe(200);
  expect((await request('/health/ready')).status).toBe(503);

  sqliteOpen = true;
  expect((await request('/health/ready')).status).toBe(503);

  whatsappReady = true;
  expect((await request('/health/ready')).status).toBe(200);

  whatsappReady = false;
  expect((await request('/health/ready')).status).toBe(503);
  expect((await request('/health/live')).status).toBe(200);
});

it('fails readiness closed when its check throws and exposes no details', async () => {
  const server = createHealthServer(() => { throw new Error('PRIVATE-CANARY'); }, 0);
  servers.push(server);
  const port = await server.listen();

  const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('not ready\n');
});
