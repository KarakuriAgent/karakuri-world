import type { WorldCalendarSnapshot } from '../types/snapshot.js';

const SEASONS = {
  spring: { label: '春', startMonth: 3 },
  summer: { label: '夏', startMonth: 6 },
  autumn: { label: '秋', startMonth: 9 },
  winter: { label: '冬', startMonth: 12 },
} as const;

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

function getSeason(year: number, month: number): {
  season: WorldCalendarSnapshot['season'];
  season_label: WorldCalendarSnapshot['season_label'];
  season_start_year: number;
  season_start_month: number;
} {
  if (month >= 3 && month <= 5) {
    return {
      season: 'spring',
      season_label: SEASONS.spring.label,
      season_start_year: year,
      season_start_month: SEASONS.spring.startMonth,
    };
  }

  if (month >= 6 && month <= 8) {
    return {
      season: 'summer',
      season_label: SEASONS.summer.label,
      season_start_year: year,
      season_start_month: SEASONS.summer.startMonth,
    };
  }

  if (month >= 9 && month <= 11) {
    return {
      season: 'autumn',
      season_label: SEASONS.autumn.label,
      season_start_year: year,
      season_start_month: SEASONS.autumn.startMonth,
    };
  }

  return {
    season: 'winter',
    season_label: SEASONS.winter.label,
    season_start_year: month === 12 ? year : year - 1,
    season_start_month: SEASONS.winter.startMonth,
  };
}

export function buildWorldCalendarSnapshot(timestamp: number, timezone: string): WorldCalendarSnapshot {
  const parts = getLocalDateParts(timestamp, timezone);
  const { season, season_label, season_start_year, season_start_month } = getSeason(parts.year, parts.month);
  const currentDateUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  const seasonStartUtc = Date.UTC(season_start_year, season_start_month - 1, 1);
  const day_in_season = Math.floor((currentDateUtc - seasonStartUtc) / 86_400_000) + 1;

  return {
    timezone,
    local_date: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
    local_time: `${parts.hour}:${parts.minute}:${parts.second}`,
    season,
    season_label,
    day_in_season,
    display_label: `${season_label}・${day_in_season}日目`,
  };
}
