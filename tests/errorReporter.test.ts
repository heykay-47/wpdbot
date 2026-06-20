import { describe, expect, it, vi } from 'vitest';
import { messageForError, userError } from '../src/errorReporter';

describe('errorReporter', () => {
  it('returns expected user-facing error messages without logging', () => {
    const logger = vi.fn();

    expect(messageForError(userError('Could not download this video: blocked'), { step: 'download', logger })).toBe(
      'Could not download this video: blocked',
    );
    expect(logger).not.toHaveBeenCalled();
  });

  it('logs unexpected errors and returns a short error id', () => {
    const logger = vi.fn();
    const error = new Error('download failed cookie=session-cookie-123 whatsappAuth=secret-auth-token');
    error.stack = 'Error: download failed cookie=session-cookie-123\n    at auth(session=whatsapp-session-456)';

    const message = messageForError(error, {
      step: 'record',
      groupId: 'group-1@g.us',
      messageId: 'message-1',
      urlHash: 'abc123',
      extractorId: 'youtube',
      logger,
    });

    expect(message).toMatch(/^Something went wrong\. Error ID: ERR-[0-9A-F]{6}$/u);
    expect(logger).toHaveBeenCalledOnce();
    const entry = logger.mock.calls[0][0];
    expect(entry).toMatchObject({
      step: 'record',
      groupId: 'group-1@g.us',
      urlHash: 'abc123',
      errorId: expect.stringMatching(/^ERR-[0-9A-F]{6}$/u),
      name: 'Error',
      message: 'download failed cookie=[REDACTED] whatsappAuth=[REDACTED]',
      stack: 'Error: download failed cookie=[REDACTED]\n    at auth(session=[REDACTED])',
    });
    expect(entry).not.toHaveProperty('error');
    expect(JSON.stringify(entry)).not.toContain('session-cookie-123');
    expect(JSON.stringify(entry)).not.toContain('secret-auth-token');
    expect(JSON.stringify(entry)).not.toContain('whatsapp-session-456');
  });

  it('redacts downloader cookie and proxy arguments plus HTTP auth headers', () => {
    const logger = vi.fn();
    const error = new Error(
      'yt-dlp failed --cookies /run/secrets/cookies.txt --proxy http://user:pass@example.test Cookie: session=abc Authorization: Bearer token123',
    );
    error.stack = [
      'Error: yt-dlp failed --cookies /run/secrets/cookies.txt',
      '    at proxy(--proxy http://user:pass@example.test)',
      '    at headers(Cookie: session=abc; theme=dark)',
      '    at headers(Authorization: Bearer token123)',
    ].join('\n');

    messageForError(error, { step: 'download', logger });

    const serialized = JSON.stringify(logger.mock.calls[0][0]);
    expect(serialized).toContain('--cookies [REDACTED]');
    expect(serialized).toContain('--proxy [REDACTED]');
    expect(serialized).toContain('Cookie: [REDACTED]');
    expect(serialized).toContain('Authorization: [REDACTED]');
    expect(serialized).not.toContain('/run/secrets/cookies.txt');
    expect(serialized).not.toContain('http://user:pass@example.test');
    expect(serialized).not.toContain('session=abc');
    expect(serialized).not.toContain('Bearer token123');
  });
});
