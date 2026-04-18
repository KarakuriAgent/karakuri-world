import type { WorldCalendarSnapshot } from '../types/snapshot.js';

function getLocalDateParts(timestamp: number, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: string;
  minute: string;
  second: string;
} {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const values = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

export function buildWorldCalendarSnapshot(timestamp: number, timezone: string): WorldCalendarSnapshot {
  const parts = getLocalDateParts(timestamp, timezone);
  const local_date = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  const local_time = `${parts.hour}:${parts.minute}:${parts.second}`;

  return {
    timezone,
    local_date,
    local_time,
    display_label: `${local_date} ${parts.hour}:${parts.minute} (${timezone})`,
  };
}
