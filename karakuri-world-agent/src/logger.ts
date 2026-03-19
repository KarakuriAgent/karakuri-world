export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

const DEFAULT_LOG_LEVEL: LogLevel = 'info';
const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};
const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
  debug: 'DEBUG',
};

function normalizeLogLevel(value: string): LogLevel | undefined {
  const normalized = value.trim().toLowerCase();

  switch (normalized) {
    case 'error':
    case 'warn':
    case 'info':
    case 'debug':
      return normalized;
    default:
      return undefined;
  }
}

export function parseLogLevel(value: string | undefined): LogLevel {
  if (!value) {
    return DEFAULT_LOG_LEVEL;
  }

  return normalizeLogLevel(value) ?? DEFAULT_LOG_LEVEL;
}

const configuredLogLevel = parseLogLevel(process.env.LOG_LEVEL);
const configuredLogLevelValue = LOG_LEVEL_VALUES[configuredLogLevel];

function emit(level: LogLevel, category: string, message: string, args: unknown[]): void {
  if (LOG_LEVEL_VALUES[level] > configuredLogLevelValue) {
    return;
  }

  const formattedMessage = `[${new Date().toISOString()}] [${LOG_LEVEL_LABELS[level]}] [${category}] ${message}`;

  switch (level) {
    case 'error':
      console.error(formattedMessage, ...args);
      return;
    case 'warn':
      console.warn(formattedMessage, ...args);
      return;
    case 'info':
      console.info(formattedMessage, ...args);
      return;
    case 'debug':
      console.debug(formattedMessage, ...args);
  }
}

export function createLogger(category: string): Logger {
  return {
    error(message, ...args) {
      emit('error', category, message, args);
    },
    warn(message, ...args) {
      emit('warn', category, message, args);
    },
    info(message, ...args) {
      emit('info', category, message, args);
    },
    debug(message, ...args) {
      emit('debug', category, message, args);
    },
  };
}
