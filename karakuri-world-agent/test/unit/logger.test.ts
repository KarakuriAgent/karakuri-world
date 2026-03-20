import { afterEach, describe, expect, it, vi } from 'vitest';

async function importLoggerModule(logLevel?: string) {
  vi.resetModules();
  vi.unstubAllEnvs();

  if (logLevel === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    vi.stubEnv('LOG_LEVEL', logLevel);
  }

  return import('../../src/logger.js');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('logger', () => {
  it('parses valid log levels and falls back to info for invalid values', async () => {
    const { parseLogLevel } = await importLoggerModule();

    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('error')).toBe('error');
    expect(parseLogLevel(' WARN ')).toBe('warn');
    expect(parseLogLevel('Info')).toBe('info');
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel('verbose')).toBe('info');
  });

  it('defaults to info and suppresses debug logs', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { createLogger } = await importLoggerModule();
    const logger = createLogger('test');

    logger.debug('debug message');
    logger.info('info message');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[[0-9T:.\-Z]+\] \[INFO\] \[test\] info message$/),
    );
  });

  it('suppresses lower-priority messages below the configured log level', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createLogger } = await importLoggerModule('warn');
    const logger = createLogger('test');

    logger.debug('debug message');
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message', { operation: 'demo' });

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[[0-9T:.\-Z]+\] \[WARN\] \[test\] warn message$/),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[[0-9T:.\-Z]+\] \[ERROR\] \[test\] error message$/),
      { operation: 'demo' },
    );
  });
});
