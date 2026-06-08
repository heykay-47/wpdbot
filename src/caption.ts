export type FormatCaptionInput = {
  displayName: string;
  timestampMs: number;
  timezone: string;
  originalUrl: string;
};

function formatTimestamp(timestampMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).formatToParts(new Date(timestampMs));

  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';

  return `${value('day')} ${value('month')} ${value('year')}, ${value('hour')}:${value('minute')} ${value('dayPeriod').toUpperCase()} ${value('timeZoneName')}`;
}

export function formatCaption(input: FormatCaptionInput): string {
  return `Sent by ${input.displayName} at ${formatTimestamp(input.timestampMs, input.timezone)}\nOriginal: ${input.originalUrl}`;
}
