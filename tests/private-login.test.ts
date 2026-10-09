import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ open: vi.fn(() => 123), write: vi.fn(), close: vi.fn(), release: vi.fn(), lock: vi.fn(), render: vi.fn(), initialize: vi.fn(), destroy: vi.fn(), clients: [] as any[] }));
vi.mock('node:fs', () => ({ openSync: mocks.open, writeSync: mocks.write, closeSync: mocks.close }));
vi.mock('../src/authLock', () => ({ acquireAuthLock: mocks.lock }));
vi.mock('../src/whatsappRuntime', () => ({ resolveWhatsappRuntimePaths: () => ({ authDir: '/synthetic/auth', chromeCacheDir: '/synthetic/cache' }), prepareWhatsappRuntime: vi.fn(async () => undefined) }));
vi.mock('qrcode-terminal', () => ({ default: { generate: mocks.render } }));
vi.mock('whatsapp-web.js', () => ({ default: {
  LocalAuth: class { constructor(readonly options: unknown) {} },
  Client: class extends EventEmitter {
    destroy = mocks.destroy;
    initialize = () => mocks.initialize(this);
    constructor(readonly options: unknown) { super(); mocks.clients.push(this); }
  },
} }));
beforeEach(() => {
  mocks.initialize.mockImplementation(async (client) => { client.emit('qr', 'PRIVATE-QR-CANARY'); client.emit('ready'); });
  mocks.destroy.mockResolvedValue(undefined);
  mocks.lock.mockReturnValue(mocks.release);
});
afterEach(() => { vi.clearAllMocks(); mocks.clients.length = 0; vi.useRealTimers(); });

it('explicit login renders QR only to the private terminal and destroys without relay or logout', async () => {
  mocks.lock.mockReturnValue(mocks.release);
  mocks.render.mockImplementation((qr, _options, callback) => callback(qr));
  const { privateLogin } = await import('../src/login');
  const log = vi.spyOn(console, 'log');
  const error = vi.spyOn(console, 'error');
  await privateLogin();
  expect(mocks.open).toHaveBeenCalledWith('/dev/tty', 'w');
  expect(mocks.write).toHaveBeenCalledWith(123, expect.stringContaining('PRIVATE-QR-CANARY'));
  expect(mocks.lock).toHaveBeenCalledWith('/synthetic/auth');
  expect(mocks.clients[0].options.authStrategy.options).toEqual({ dataPath: '/synthetic/auth' });
  expect(mocks.clients[0].eventNames()).not.toContain('message');
  expect(mocks.clients[0].destroy).toHaveBeenCalledOnce();
  expect(mocks.release).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledWith(123);
  expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  log.mockRestore(); error.mockRestore();
});

it('noninteractive invocation refuses before touching authentication', async () => {
  mocks.open.mockImplementationOnce(() => { throw new Error('No controlling terminal'); });
  const { privateLogin } = await import('../src/login');
  await expect(privateLogin()).rejects.toThrow('No controlling terminal');
  expect(mocks.lock).not.toHaveBeenCalled();
  expect(mocks.clients).toEqual([]);
});

it('active daemon lock rejects login before creating a client or rendering credentials', async () => {
  mocks.lock.mockImplementationOnce(() => { throw new Error('Profile in use'); });
  const { privateLogin } = await import('../src/login');
  await expect(privateLogin()).rejects.toThrow('Profile in use');
  expect(mocks.clients).toEqual([]);
  expect(mocks.render).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledOnce();
});

it.each(['timeout', 'SIGINT', 'SIGTERM'])('terminates on %s during pending initialization without releasing profile ownership early', async (mode) => {
  vi.useFakeTimers();
  mocks.initialize.mockImplementation(() => new Promise(() => undefined));
  const { privateLogin } = await import('../src/login');
  const terminate = vi.fn((): never => { throw new Error('process terminated'); });
  const pending = privateLogin({ terminate });
  const rejected = expect(pending).rejects.toThrow('process terminated');
  await vi.advanceTimersByTimeAsync(0);
  if (mode === 'timeout') await vi.advanceTimersByTimeAsync(5 * 60_000);
  else process.emit(mode as 'SIGINT');
  await rejected;
  expect(terminate).toHaveBeenCalledWith(1);
  expect(mocks.release).not.toHaveBeenCalled();
  expect(mocks.destroy).not.toHaveBeenCalled();
  expect(mocks.write).toHaveBeenCalledWith(123, expect.stringContaining('Private login stopped'));
});

it('bounds stalled browser destruction and retains ownership until process termination', async () => {
  vi.useFakeTimers();
  mocks.destroy.mockImplementation(() => new Promise(() => undefined));
  const { privateLogin } = await import('../src/login');
  const terminate = vi.fn((): never => { throw new Error('process terminated'); });
  const rejected = expect(privateLogin({ terminate })).rejects.toThrow('process terminated');
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  expect(terminate).toHaveBeenCalledWith(1);
  expect(mocks.release).not.toHaveBeenCalled();
});
