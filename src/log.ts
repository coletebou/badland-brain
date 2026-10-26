/**
 * One JSON object per line on stderr. Callers pass names, counts, durations and short reasons; never a key, a body,
 * a query or any other caller-supplied text.
 */
const LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LEVELS)[number];

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export function parseLogLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(value ?? '') ? (value as LogLevel) : 'info';
}

export function createLogger(level: LogLevel = 'info', write: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): Logger {
  const threshold = LEVELS.indexOf(level);
  const emit = (at: Exclude<LogLevel, 'silent'>) => (message: string, meta: Record<string, unknown> = {}): void => {
    if (LEVELS.indexOf(at) < threshold) {
      return;
    }
    write(JSON.stringify({ t: new Date().toISOString(), level: at, msg: message, ...meta }));
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** A logger that drops everything, for tests and library use. */
export const silentLogger: Logger = createLogger('silent');

/** A short, single-line reason from any thrown value. */
export const reasonOf = (error: unknown): string => String((error as Error)?.message ?? error).replace(/\s+/gu, ' ').slice(0, 200);
