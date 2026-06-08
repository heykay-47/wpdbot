export type BotCommand = { action: 'enable' | 'disable' | 'status' };

export function parseCommand(body: string): BotCommand | null {
  const normalized = body.trim().toLowerCase();
  if (normalized === '!bot enable') return { action: 'enable' };
  if (normalized === '!bot disable') return { action: 'disable' };
  if (normalized === '!bot status') return { action: 'status' };
  return null;
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
