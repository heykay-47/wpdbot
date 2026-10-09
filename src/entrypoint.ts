import { pathToFileURL } from 'node:url';
import { createDiagnostics, isolateDiagnosticOutput } from './diagnostics.js';
import { messageForError } from './errorReporter.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Establish the privacy boundary before loading dotenv, WhatsApp or native
  // dependencies, so import-time failures cannot take Node's raw fallback path.
  isolateDiagnosticOutput();
  let diagnostics: ReturnType<typeof createDiagnostics> | undefined;
  const logger = (entry: Record<string, unknown>) => {
    diagnostics ??= createDiagnostics(process.env.DIAGNOSTICS_DIR?.trim() || '.diagnostics');
    diagnostics.log(entry);
  };
  const fatal = (error: unknown) => {
    messageForError(error, { step: 'startup', logger });
    diagnostics?.close();
    process.exit(1);
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  void import('dotenv/config').then(async () => {
    diagnostics = createDiagnostics(process.env.DIAGNOSTICS_DIR?.trim() || '.diagnostics');
    if (process.argv[2] === 'login') {
      const { privateLogin } = await import('./login.js');
      await privateLogin();
      diagnostics.close();
      process.exit(0);
    } else {
      const { main } = await import('./index.js');
      main(logger);
    }
  }).catch(fatal);
}
