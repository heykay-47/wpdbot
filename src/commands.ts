export type GroupSetting = 'maxFileSizeMb' | 'duplicateWindowHours';
export type GroupSettingUpdate = { setting: GroupSetting; value: number };

export type BotCommand =
  | { action: 'enable' | 'disable' | 'status' | 'inspect' }
  | { action: 'set'; raw: string }
  | { action: 'retry' | 'retry-confirm' | 'invalid-retry' };

export function parseCommand(body: string): BotCommand | null {
  const normalized = body.trim().toLowerCase();
  if (normalized === '!bot enable') return { action: 'enable' };
  if (normalized === '!bot disable') return { action: 'disable' };
  if (normalized === '!bot status') return { action: 'status' };
  if (normalized === '!bot inspect') return { action: 'inspect' };
  if (normalized === '!bot retry') return { action: 'retry' };
  if (normalized === '!bot retry confirm') return { action: 'retry-confirm' };
  if (normalized.startsWith('!bot retry ')) return { action: 'invalid-retry' };
  if (normalized === '!bot set' || normalized.startsWith('!bot set ')) return { action: 'set', raw: normalized.slice('!bot set'.length).trim() };
  return null;
}

export function validateGroupSettingCommand(command: BotCommand | null, globalMaxFileSizeMb: number): GroupSettingUpdate | null {
  if (!command || command.action !== 'set') return null;
  const match = /^(max-size|duplicate-window) ([0-9]+)$/u.exec(command.raw);
  if (!match) return null;
  const value = Number(match[2]);
  if (!Number.isSafeInteger(value)) return null;
  if (match[1] === 'max-size') {
    return value >= 1 && value <= globalMaxFileSizeMb ? { setting: 'maxFileSizeMb', value } : null;
  }
  return value <= 720 ? { setting: 'duplicateWindowHours', value } : null;
}

export type ManageCheckInput = {
  senderId: string;
  ownerId: string;
  senderIsGroupAdmin: boolean;
};

export function canManageGroup(input: ManageCheckInput): boolean {
  const ownerId = input.ownerId.includes('@') ? input.ownerId : `${input.ownerId}@c.us`;
  return input.senderId === ownerId || input.senderIsGroupAdmin;
}

export type EnableCheckInput = ManageCheckInput & {
  botIsGroupAdmin: boolean;
};

export function canEnableGroup(input: EnableCheckInput): boolean {
  return canManageGroup(input) && input.botIsGroupAdmin;
}
