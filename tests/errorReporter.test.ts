import { describe, expect, it, vi } from 'vitest';
import { diagnosticEntry, downloadCause, messageForError, userError } from '../src/errorReporter';

const reference = `W-${'A'.repeat(32)}`;
const canary = 'PRIVATE-CANARY https://private.test/path?q=secret group@g.us sender@c.us /auth/cookies token=secret QR-CREDENTIAL';

describe('errorReporter privacy allowlist', () => {
  it.each(['download', 'upload', 'record', 'startup', 'whatsapp-runtime', 'notification', canary])('never copies raw error material at %s', (step) => {
    const logger = vi.fn();
    const error = Object.assign(new Error(canary), { stdout: canary, stderr: canary, command: canary, headers: canary });
    error.stack = canary;
    const text = messageForError(error, { step, reference, groupId: canary, messageId: canary, urlHash: canary, extractorId: canary, logger });
    expect(logger).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.mock.calls)).not.toContain('PRIVATE');
    expect(text).not.toContain('PRIVATE');
    expect(text).toContain(reference);
    expect(Object.keys(logger.mock.calls[0][0]).sort()).toEqual(['cause', 'reference', 'stage', 'timestamp']);
  });

  it('logs expected failures and uses evidence, never user-facing free-form error text', () => {
    const logger = vi.fn();
    const text = messageForError(userError(canary, 'rate_limited'), { step: 'download', link: 2, item: 3, logger });
    expect(text).toContain('Link 2, item 3');
    expect(text).toContain('rate-limited');
    expect(text).toContain('Work reference unavailable');
    expect(text).not.toContain(canary);
    expect(logger.mock.calls[0][0]).toMatchObject({ stage: 'download', cause: 'rate_limited', link: 2, item: 3 });
  });

  it('does not infer causes from raw stderr, messages, or untrusted free-form codes', () => {
    expect(downloadCause(Object.assign(new Error('403 rate limited timeout'), { stderr: canary, code: canary }))).toBe('unknown');
    expect(downloadCause({ statusCode: 429 })).toBe('rate_limited');
    expect(downloadCause({ timedOut: true })).toBe('timeout');
    expect(downloadCause({ code: 'ECONNRESET' })).toBe('network');
  });

  it('reporter failure cannot escape and never creates a stack-derived reference', () => {
    expect(() => messageForError(new Error(canary), { step: 'upload', logger: () => { throw new Error(canary); } })).not.toThrow();
    expect(messageForError(new Error(canary), { step: 'upload' })).toContain('Work reference unavailable');
    expect(diagnosticEntry({ ...{ reference: canary, stage: canary, cause: canary, platform: canary }, stack: canary, link: -1 })).toMatchObject({ stage: 'runtime', cause: 'unknown' });
  });

  it('unknown record errors remain unknown; only structured storage and numeric evidence survives', () => {
    const logger = vi.fn();
    messageForError(new Error('database IO error SQLITE_FULL 429'), { step: 'record', logger });
    expect(logger.mock.calls[0][0].cause).toBe('unknown');
    messageForError(Object.assign(new Error(canary), { code: 'SQLITE_FULL' }), { step: 'record', logger });
    expect(logger.mock.calls[1][0].cause).toBe('storage_failed');
    messageForError(Object.assign(new Error(canary), { statusCode: 429, exitCode: 1 }), { step: 'download', logger });
    expect(logger.mock.calls[2][0]).toMatchObject({ cause: 'rate_limited', httpStatus: 429, exitCode: 1 });
    expect(JSON.stringify(logger.mock.calls)).not.toContain(canary);
  });
});
