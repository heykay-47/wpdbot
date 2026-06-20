import { describe, expect, it } from 'vitest';
import { canEnableGroup, canManageGroup, parseCommand } from '../src/commands';

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

  it('allows bot owner configured as bare phone number', () => {
    expect(canManageGroup({ senderId: '919999999999@c.us', ownerId: '919999999999', senderIsGroupAdmin: false })).toBe(true);
  });

  it('allows group admins', () => {
    expect(canManageGroup({ senderId: 'admin@c.us', ownerId: 'owner@c.us', senderIsGroupAdmin: true })).toBe(true);
  });

  it('rejects normal members', () => {
    expect(canManageGroup({ senderId: 'member@c.us', ownerId: 'owner@c.us', senderIsGroupAdmin: false })).toBe(false);
  });
});

describe('canEnableGroup', () => {
  it('rejects when bot is not group admin', () => {
    expect(canEnableGroup({
      senderId: 'owner@c.us',
      ownerId: 'owner@c.us',
      senderIsGroupAdmin: false,
      botIsGroupAdmin: false,
    })).toBe(false);
  });

  it('allows when sender can manage group and bot is group admin', () => {
    expect(canEnableGroup({
      senderId: 'admin@c.us',
      ownerId: 'owner@c.us',
      senderIsGroupAdmin: true,
      botIsGroupAdmin: true,
    })).toBe(true);
  });
});
