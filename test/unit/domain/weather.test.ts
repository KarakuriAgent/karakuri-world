import { afterEach, describe, expect, it, vi } from 'vitest';

import { WeatherService, fetchWeather, mapOpenWeatherCondition } from '../../../src/domain/weather.js';

describe('weather domain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps OpenWeather conditions to internal categories', () => {
    expect(mapOpenWeatherCondition('Clear')).toBe('clear');
    expect(mapOpenWeatherCondition('Clouds')).toBe('clouds');
    expect(mapOpenWeatherCondition('Haze')).toBe('mist');
    expect(mapOpenWeatherCondition('Unknown')).toBe('unknown');
  });

  it('fetches and normalizes weather data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ weather: [{ main: 'Clouds' }], main: { temp: 17.6 } }),
    })));

    await expect(fetchWeather(35, 139, 'api-key')).resolves.toMatchObject({
      condition: 'clouds',
      condition_text: 'くもり',
      temperature_celsius: 18,
    });
  });

  it('keeps the previous value when a poll fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ weather: [{ main: 'Clear' }], main: { temp: 20 } }) })
      .mockRejectedValueOnce(new Error('network'));
    vi.stubGlobal('fetch', fetchMock);
    const service = new WeatherService({ location: { latitude: 35, longitude: 139 }, interval_ms: 1000 }, 'api-key');

    await service.start();
    const first = service.getState();
    expect(first?.condition).toBe('clear');

    await new Promise((resolve) => setTimeout(resolve, 0));
    await (fetchMock.mock.results[1]?.value ?? Promise.resolve()).catch(() => undefined);
    expect(service.getState()).toEqual(first);
    service.stop();
  });
});
