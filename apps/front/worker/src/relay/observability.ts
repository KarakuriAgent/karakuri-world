export type RelayMetricKind = 'counter' | 'gauge';
export type RelayLogLevel = 'info' | 'warn' | 'error';

export interface RelayMetricRecord {
  name: string;
  kind: RelayMetricKind;
  value: number;
  tags?: Record<string, string>;
}

export interface RelayLogRecord {
  level: RelayLogLevel;
  message: string;
  context?: Record<string, unknown>;
}

export interface RelayObservability {
  counter(name: string, tags?: Record<string, string>, value?: number): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  log(level: RelayLogLevel, message: string, context?: Record<string, unknown>): void;
}

function emitConsoleRecord(level: RelayLogLevel, now: () => number, payload: Record<string, unknown>): void {
  const consoleMethod =
    level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;

  consoleMethod(
    JSON.stringify({
      component: 'ui-relay',
      timestamp: new Date(now()).toISOString(),
      ...payload,
    }),
  );
}

export function createConsoleRelayObservability(now: () => number = () => Date.now()): RelayObservability {
  return {
    counter(name, tags, value = 1) {
      emitConsoleRecord('info', now, {
        signal: 'metric',
        metric: {
          name,
          kind: 'counter',
          value,
          ...(tags ? { tags } : {}),
        } satisfies RelayMetricRecord,
      });
    },
    gauge(name, value, tags) {
      emitConsoleRecord('info', now, {
        signal: 'metric',
        metric: {
          name,
          kind: 'gauge',
          value,
          ...(tags ? { tags } : {}),
        } satisfies RelayMetricRecord,
      });
    },
    log(level, message, context) {
      emitConsoleRecord(level, now, {
        signal: 'log',
        log: {
          level,
          message,
          ...(context ? { context } : {}),
        } satisfies RelayLogRecord,
      });
    },
  };
}
