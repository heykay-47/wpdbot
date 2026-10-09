const messages = {
  unknown: 'Processing failed; the cause could not be verified. Original kept. Contact the operator.',
  access_required: 'Source access is required. This item was not sent; original kept. Contact the operator.',
  rate_limited: 'Source temporarily rate-limited. This item was not sent; original kept. Wait and contact the operator.',
  unavailable: 'Source unavailable. This item was not sent; original kept. Contact the operator.',
  network: 'Source network unavailable. This item was not sent; original kept. Contact the operator.',
  timeout: 'Source request timed out. This item was not sent; original kept. Contact the operator.',
  size_limit: 'Media exceeds the current size limit. This item was not sent; original kept.',
  duration_limit: 'Media exceeds the duration limit. This item was not sent; original kept.',
  unsupported_media: 'Media could not be verified. This item was not sent; original kept.',
  preparation_failed: 'Media preparation failed. This item was not sent; original kept. Contact the operator.',
  delivery_unknown: 'Delivery unknown; this item may already have been delivered. Do not retry or repost to bypass the hold. Original kept. Reply to the source with !bot inspect.',
  permission_rejected: 'Only current-group admins or the bot owner may run this command. Command not run; no work details were shown.',
  storage_failed: 'Processing paused because storage failed. Delivery status could not be verified; do not retry. Original kept. Contact the operator.',
  source_changed: 'Source changed. Remaining work held; original kept.',
  source_unavailable: 'Source unavailable or changed. Remaining work held; original kept.',
  age_held: 'Source age could not permit automatic recovery. Remaining work held; original kept.',
  auth_required: 'Private operator login required.',
  unsupported_state: 'Saved source state unavailable or unsupported. Work held; original kept. Contact the operator.',
};
export type FailureCause = keyof typeof messages;
const causes = Object.keys(messages);
export type ErrorFacts = { exitCode?: number; httpStatus?: number };
const stages = ['relay', 'settings', 'record', 'download', 'upload', 'duplicate-check', 'recovery', 'whatsapp-message', 'whatsapp-runtime', 'startup', 'permission', 'inspect', 'auth', 'notification', 'runtime', 'login'] as const;

export class UserFacingError extends Error {
  readonly userFacing = true;
  constructor(message: string, readonly causeCode: FailureCause = 'unknown', readonly facts: ErrorFacts = {}) { super(message); }
}

export type ErrorReportContext = {
  step: string;
  groupId?: string;
  messageId?: string;
  urlHash?: string;
  extractorId?: string;
  reference?: string;
  link?: number;
  item?: number;
  attempt?: number;
  logger?: (entry: Record<string, unknown>) => void;
};

export function userError(message: string, cause: FailureCause = 'unknown', facts: ErrorFacts = {}): UserFacingError {
  return new UserFacingError(message, cause, facts);
}

// No free-form error material is ever copied to diagnostics, even in fallback paths.
export function diagnosticEntry(input: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    timestamp: new Date(now).toISOString(),
    stage: stages.includes(input.stage as typeof stages[number]) ? input.stage : 'runtime',
    cause: causes.includes(input.cause as string) ? input.cause : 'unknown',
  };
  if (typeof input.reference === 'string' && /^W-[A-F0-9]{32}$/u.test(input.reference)) entry.reference = input.reference;
  if (input.platform === 'instagram' || input.platform === 'youtube') entry.platform = input.platform;
  for (const key of ['link', 'item', 'attempt', 'exitCode', 'httpStatus']) {
    if (Number.isSafeInteger(input[key]) && (input[key] as number) >= 0 && (input[key] as number) <= 1_000_000) entry[key] = input[key];
  }
  return entry;
}

export function downloadCause(error: unknown): FailureCause {
  if (error instanceof UserFacingError) return error.causeCode;
  if (!error || typeof error !== 'object') return 'unknown';
  try {
    const facts = error as { timedOut?: unknown; statusCode?: unknown; code?: unknown };
    if (facts.timedOut === true || facts.code === 'ETIMEDOUT') return 'timeout';
    if (facts.statusCode === 429) return 'rate_limited';
    if (facts.statusCode === 401 || facts.statusCode === 403) return 'access_required';
    if (facts.statusCode === 404 || facts.statusCode === 410) return 'unavailable';
    if (facts.code === 'ECONNRESET' || facts.code === 'ENOTFOUND' || facts.code === 'ECONNREFUSED') return 'network';
  } catch { /* Hostile/unreadable exceptions carry no reliable cause evidence. */ }
  return 'unknown';
}

export function errorFacts(error: unknown): ErrorFacts {
  try {
    if (error instanceof UserFacingError) return error.facts;
    if (!error || typeof error !== 'object') return {};
    const facts = error as { exitCode?: unknown; statusCode?: unknown };
    return {
      ...(Number.isSafeInteger(facts.exitCode) && Number(facts.exitCode) >= 0 && Number(facts.exitCode) <= 255 ? { exitCode: Number(facts.exitCode) } : {}),
      ...(Number.isSafeInteger(facts.statusCode) && Number(facts.statusCode) >= 100 && Number(facts.statusCode) <= 599 ? { httpStatus: Number(facts.statusCode) } : {}),
    };
  } catch { return {}; }
}

function storageCause(error: unknown): boolean {
  try {
    const code = (error as { code?: unknown })?.code;
    return typeof code === 'string' && /^(ENOSPC|EACCES|EPERM|EIO|EROFS|SQLITE_(FULL|IOERR(?:_[A-Z]+)?|READONLY(?:_[A-Z]+)?|CANTOPEN|BUSY|LOCKED|CORRUPT|NOTADB))$/u.test(code);
  } catch { return false; }
}

export function messageForError(error: unknown, context: ErrorReportContext): string {
  let cause: FailureCause = error instanceof UserFacingError ? error.causeCode : context.step === 'download' ? downloadCause(error) : 'unknown';
  if (!(error instanceof UserFacingError) && storageCause(error)) cause = 'storage_failed';
  try {
    context.logger?.(diagnosticEntry({ stage: context.step, cause, reference: context.reference,
      link: context.link, item: context.item, attempt: context.attempt, platform: context.extractorId, ...errorFacts(error) }));
  } catch { /* Reporting cannot affect delivery evidence or trigger another send. */ }
  const position = context.link ? `Link ${context.link}${context.item ? `, item ${context.item}` : ''} — ` : '';
  return `${position}${messages[cause]}\n${context.reference && /^W-[A-F0-9]{32}$/u.test(context.reference) ? `Ref ${context.reference}` : 'Work reference unavailable.'}`;
}
