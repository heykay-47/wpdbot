import { createServer } from 'node:http';

const readinessPort = 3000;

export function createHealthServer(isReady: () => boolean, port = readinessPort) {
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');

    if (request.method !== 'GET') {
      response.writeHead(405).end('method not allowed\n');
      return;
    }

    if (request.url === '/health/live') {
      response.writeHead(200).end('live\n');
      return;
    }

    if (request.url !== '/health/ready') {
      response.writeHead(404).end('not found\n');
      return;
    }

    let ready = false;
    try { ready = isReady(); } catch { /* Readiness must fail closed without exposing private errors. */ }
    response.writeHead(ready ? 200 : 503).end(ready ? 'ready\n' : 'not ready\n');
  });

  return {
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError);
          const address = server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('Health listener did not bind to a TCP port'));
            return;
          }
          resolve(address.port);
        });
      });
    },

    close(): Promise<void> {
      if (!server.listening) return Promise.resolve();
      return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
