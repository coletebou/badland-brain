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

const MAX_REASON_CHARS = 200;
const fieldsOf = (value: unknown): string => (value && typeof value === 'object' ? Object.keys(value).join(', ') : '');

/**
 * A short, single-line reason from any thrown value, safe to log. MongoDB duplicate-key errors and Mongoose validation
 * and cast errors quote the offending values (a slug, an import id, a title) in their messages, so for those only the
 * field names are kept.
 */
export function reasonOf(error: unknown): string {
  const known = error as { code?: unknown; name?: unknown; keyPattern?: unknown; errors?: unknown; path?: unknown } | null | undefined;
  let reason: string;
  if (known?.code === 11000) {
    const fields = fieldsOf(known.keyPattern);
    reason = fields ? `duplicate key on ${fields}` : 'duplicate key';
  } else if (known?.name === 'ValidationError') {
    const fields = fieldsOf(known.errors);
    reason = fields ? `validation failed on ${fields}` : 'validation failed';
  } else if (known?.name === 'CastError') {
    reason = typeof known.path === 'string' ? `cast failed on ${known.path}` : 'cast failed';
  } else {
    reason = String((error as Error | null | undefined)?.message ?? error);
  }
  return reason.replace(/\s+/gu, ' ').slice(0, MAX_REASON_CHARS);
}
