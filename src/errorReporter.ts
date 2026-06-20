import { createHash, randomBytes } from 'node:crypto';

export class UserFacingError extends Error {
  readonly userFacing = true;
}

export type ErrorReportContext = {
  step: string;
  groupId?: string;
  messageId?: string;
  urlHash?: string;
  extractorId?: string;
  logger?: (entry: Record<string, unknown>) => void;
};

export function userError(message: string): UserFacingError {
  return new UserFacingError(message);
}

function errorId(error: unknown): string {
  const source = error instanceof Error && error.stack ? error.stack : `${String(error)}:${randomBytes(4).toString('hex')}`;
  return `ERR-${createHash('sha256').update(source).digest('hex').slice(0, 6).toUpperCase()}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function scrub(value: string): string {
  return value
    .replace(/(^|[\s(])(--cookies)(?:=|\s+)(?:"[^"]+"|'[^']+'|\S+)/giu, '$1$2 [REDACTED]')
    .replace(/(^|[\s(])(--proxy)(?:=|\s+)(?:"[^"]+"|'[^']+'|\S+)/giu, '$1$2 [REDACTED]')
    .replace(/\b(Cookie:\s*).*?(?=\s+Authorization:|[\r\n)]|$)/giu, '$1[REDACTED]')
    .replace(/\b(Authorization:\s*).*?(?=[\r\n)]|$)/giu, '$1[REDACTED]')
    .replace(/\.wwebjs_auth\/[^\s)]+/giu, '.wwebjs_auth/[REDACTED]')
    .replace(/\b(cookie|whatsappAuth|auth|session|password|token)=([^\s)]+)/giu, '$1=[REDACTED]');
}

export function messageForError(error: unknown, context: ErrorReportContext): string {
  if (error instanceof UserFacingError) return error.message;

  const id = errorId(error);
  const diagnostics =
    error instanceof Error
      ? {
          name: error.name,
          message: scrub(error.message),
          ...(error.stack ? { stack: scrub(error.stack), stackHash: hash(error.stack) } : {}),
        }
      : { message: scrub(String(error)) };

  context.logger?.({
    errorId: id,
    step: context.step,
    groupId: context.groupId,
    messageId: context.messageId,
    urlHash: context.urlHash,
    extractorId: context.extractorId,
    ...diagnostics,
  });
  return `Something went wrong. Error ID: ${id}`;
}
