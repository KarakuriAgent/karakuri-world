import type { WeatherConfig } from '../types/data-model.js';

export type WeatherCondition = 'clear' | 'clouds' | 'rain' | 'snow' | 'thunderstorm' | 'drizzle' | 'mist' | 'unknown';

export interface WeatherState {
  condition: WeatherCondition;
  condition_text: string;
  temperature_celsius: number;
  fetched_at: number;
}

const WEATHER_TEXT: Record<WeatherCondition, string> = {
  clear: '晴れ',
  clouds: 'くもり',
  rain: '雨',
  snow: '雪',
  thunderstorm: '雷',
  drizzle: '霧雨',
  mist: '霧',
  unknown: '不明',
};

export function mapOpenWeatherCondition(main: string): WeatherCondition {
  switch (main.toLowerCase()) {
    case 'clear':
      return 'clear';
    case 'clouds':
      return 'clouds';
    case 'rain':
      return 'rain';
    case 'snow':
      return 'snow';
    case 'thunderstorm':
      return 'thunderstorm';
    case 'drizzle':
      return 'drizzle';
    case 'mist':
    case 'fog':
    case 'haze':
    case 'smoke':
      return 'mist';
    default:
      return 'unknown';
  }
}

export async function fetchWeather(lat: number, lon: number, apiKey: string): Promise<WeatherState> {
  const url = new URL('https://api.openweathermap.org/data/2.5/weather');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('appid', apiKey);
  url.searchParams.set('units', 'metric');
  url.searchParams.set('lang', 'ja');

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`OpenWeatherMap request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    weather?: Array<{ main?: string }>;
    main?: { temp?: number };
  };
  const condition = mapOpenWeatherCondition(payload.weather?.[0]?.main ?? 'unknown');
  return {
    condition,
    condition_text: WEATHER_TEXT[condition],
    temperature_celsius: Math.round(payload.main?.temp ?? 0),
    fetched_at: Date.now(),
  };
}

export class WeatherService {
  private state: WeatherState | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: WeatherConfig,
    private readonly apiKey: string,
    private readonly onError?: (message: string) => void,
  ) {}

  async start(): Promise<void> {
    await this.poll();
    this.intervalId = setInterval(() => {
      void this.poll();
    }, this.config.interval_ms);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getState(): WeatherState | null {
    return this.state;
  }

  private async poll(): Promise<void> {
    try {
      this.state = await fetchWeather(this.config.location.latitude, this.config.location.longitude, this.apiKey);
    } catch (error) {
      console.error('Failed to fetch weather data.', error);
      this.onError?.(`天気データの取得に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
