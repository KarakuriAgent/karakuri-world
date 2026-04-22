export function formatHistoryTimestamp(occurredAt: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    }).format(new Date(occurredAt));
  } catch {
    return new Date(occurredAt).toLocaleString('ja-JP');
  }
}
