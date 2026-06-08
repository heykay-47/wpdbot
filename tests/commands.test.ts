import { describe, expect, it } from 'vitest';
import { canManageGroup, parseCommand } from '../src/commands';

describe('parseCommand', () => {
  it.each([
    ['!bot enable', 'enable'],
    ['!bot disable', 'disable'],
    ['!bot status', 'status'],
  ] as const)('parses %s', (body, action) => {
    expect(parseCommand(body)).toEqual({ action });
  });

  it('ignores non-command text', () => {
    expect(parseCommand('hello !bot enable')).toBeNull();
  });
});

describe('canManageGroup', () => {
  it('allows bot owner', () => {
    expect(canManageGroup({ senderId: 'owner@c.us', ownerId: 'owner@c.us', senderIsGroupAdmin: false })).toBe(true);
  });

  it('allows group admins', () => {
    expect(canManageGroup({ senderId: 'admin@c.us', ownerId: 'owner@c.us', senderIsGroupAdmin: true })).toBe(true);
  });

  it('rejects normal members', () => {
    expect(canManageGroup({ senderId: 'member@c.us', ownerId: 'owner@c.us', senderIsGroupAdmin: false })).toBe(false);
  });
});
