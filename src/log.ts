const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

let threshold: number = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;

export function setLevel(level: Level): void {
  threshold = LEVELS[level] ?? LEVELS.info;
}

const COLOR: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level: Level, scope: string, args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const head = `\x1b[90m${stamp()}\x1b[0m ${COLOR[level]}${level.toUpperCase().padEnd(5)}\x1b[0m \x1b[95m${scope}\x1b[0m`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  stream(head, ...args);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(scope: string): Logger;
}

export function logger(scope: string): Logger {
  return {
    debug: (...a) => emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
    child: (sub) => logger(`${scope}:${sub}`),
  };
}
