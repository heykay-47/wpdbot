import { createDiagnostics, isolateDiagnosticOutput } from '../../src/diagnostics.js';
import { messageForError } from '../../src/errorReporter.js';
import { acquireAuthLock } from '../../src/authLock.js';

const [directory, mode] = process.argv.slice(2);
if (mode === 'lock') {
  acquireAuthLock(directory);
  process.send?.('locked');
  setInterval(() => undefined, 1000);
} else {
  isolateDiagnosticOutput();
  const diagnostics = createDiagnostics(directory);
  const fail = (error: unknown) => {
    messageForError(error, { step: 'startup', logger: diagnostics.log });
    diagnostics.close();
    process.exit(1);
  };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  const canary = 'PRIVATE-CANARY https://private.test /private/auth/cookies group@g.us secret=TOKEN QR-CREDENTIAL';
  console.log(canary);
  console.error(canary);
  process.stdout.write(canary);
  process.stderr.write(canary);
  if (mode === 'rejection') void Promise.reject(Object.assign(new Error(canary), { stderr: canary, stdout: canary }));
  else throw new Error(canary);
}
