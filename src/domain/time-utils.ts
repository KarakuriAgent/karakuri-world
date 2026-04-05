import type { Hours } from '../types/data-model.js';

function getTimezoneParts(now: Date, timezone: string): { date: string; hour: string; minute: string } {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const values = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: values.hour,
    minute: values.minute,
  };
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function isWithinHours(hours: Hours | undefined, now: Date, timezone: string): boolean {
  if (!hours) {
    return true;
  }

  const { hour, minute } = getTimezoneParts(now, timezone);
  const currentMinutes = Number(hour) * 60 + Number(minute);
  const openMinutes = toMinutes(hours.open);
  const closeMinutes = toMinutes(hours.close);

  if (openMinutes === closeMinutes) {
    return true;
  }

  if (openMinutes < closeMinutes) {
    return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
  }

  return currentMinutes >= openMinutes || currentMinutes < closeMinutes;
}

export function formatWorldTime(now: Date, timezone: string): string {
  const { date, hour, minute } = getTimezoneParts(now, timezone);
  return `${date} ${hour}:${minute} (${timezone})`;
}
