import { describe, expect, it } from 'vitest';
import { canEnableGroup, canManageGroup, parseCommand, validateGroupSettingCommand } from '../src/commands';

describe('parseCommand', () => {
  it.each([
    ['!bot enable', 'enable'],
    ['!bot disable', 'disable'],
    ['!bot status', 'status'],
    ['!bot inspect', 'inspect'],
  ] as const)('parses %s', (body, action) => {
    expect(parseCommand(body)).toEqual({ action });
  });

  it('ignores non-command text', () => {
    expect(parseCommand('hello !bot enable')).toBeNull();
  });
});

describe('group setting commands', () => {
  it.each([
    ['!bot set max-size 1', { setting: 'maxFileSizeMb', value: 1 }],
    [' !BOT SET MAX-SIZE 64 ', { setting: 'maxFileSizeMb', value: 64 }],
    ['!bot set duplicate-window 0', { setting: 'duplicateWindowHours', value: 0 }],
    ['!bot set duplicate-window 720', { setting: 'duplicateWindowHours', value: 720 }],
  ] as const)('accepts valid command %s', (body, expected) => {
    expect(validateGroupSettingCommand(parseCommand(body), 64)).toEqual(expected);
  });

  it.each([
    '!bot set max-size', '!bot set max-size 0', '!bot set max-size 65', '!bot set max-size 1.5',
    '!bot set max-size 1 2', '!bot set duplicate-window -1', '!bot set duplicate-window 721',
    '!bot set other 10',
  ])('rejects malformed or out-of-range command %s without a setting mutation', (body) => {
    expect(validateGroupSettingCommand(parseCommand(body), 64)).toBeNull();
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
