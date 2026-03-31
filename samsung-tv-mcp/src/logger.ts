type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_RANK: Record<Level, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

function currentLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? 'INFO').toUpperCase();
  if (raw === 'DEBUG' || raw === 'INFO' || raw === 'WARN' || raw === 'ERROR') {
    return raw;
  }
  return 'INFO';
}

function shouldLog(level: Level): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[currentLevel()];
}

function format(scope: string, level: Level, message: string): string {
  return `${new Date().toISOString()} [${scope}] ${level}: ${message}`;
}

function write(scope: string, level: Level, message: string): void {
  if (!shouldLog(level)) return;
  process.stderr.write(`${format(scope, level, message)}\n`);
}

export function createLogger(scope: string) {
  return {
    debug: (message: string) => write(scope, 'DEBUG', message),
    info: (message: string) => write(scope, 'INFO', message),
    warn: (message: string) => write(scope, 'WARN', message),
    error: (message: string) => write(scope, 'ERROR', message),
  };
}
