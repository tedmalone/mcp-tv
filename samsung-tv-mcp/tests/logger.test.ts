import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from '../src/logger.js';

describe('createLogger', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('writes to stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = createLogger('test-scope');
    log.info('hello');
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('includes scope, level, and message in output', () => {
    let written = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written += chunk;
      return true;
    });

    const log = createLogger('samsung-client');
    log.warn('connection issue');

    expect(written).toContain('[samsung-client]');
    expect(written).toContain('WARN');
    expect(written).toContain('connection issue');

    vi.restoreAllMocks();
  });

  it('suppresses DEBUG messages when LOG_LEVEL=INFO', () => {
    vi.stubEnv('LOG_LEVEL', 'INFO');
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const log = createLogger('scope');
    log.debug('suppressed');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('emits DEBUG messages when LOG_LEVEL=DEBUG', () => {
    vi.stubEnv('LOG_LEVEL', 'DEBUG');
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const log = createLogger('scope');
    log.debug('visible');

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('always emits ERROR regardless of LOG_LEVEL', () => {
    vi.stubEnv('LOG_LEVEL', 'WARN');
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const log = createLogger('scope');
    log.error('critical');

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
