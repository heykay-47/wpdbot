import { describe, expect, it } from 'vitest';
import { formatCaption } from '../src/caption';

describe('formatCaption', () => {
  it('formats sender, timestamp, and original url', () => {
    const caption = formatCaption({
      displayName: 'Mom',
      timestampMs: Date.UTC(2026, 5, 8, 14, 12),
      timezone: 'Asia/Kolkata',
      originalUrl: 'https://youtu.be/abc123',
    });

    expect(caption).toBe('Sent by Mom at 08 Jun 2026, 7:42 PM IST\nOriginal: https://youtu.be/abc123');
  });
});
