import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SamsungTvClient } from '../src/samsung-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempEnvPath(): string {
  return join(tmpdir(), `test-samsung-${Date.now()}.env`);
}

function makeClient(ip = '192.168.1.100', envPath?: string): SamsungTvClient {
  return new SamsungTvClient({ ip, name: 'TestClient' }, envPath);
}

// ---------------------------------------------------------------------------
// Token persistence — persistToken (accessed via any cast for private method)
// ---------------------------------------------------------------------------

describe('SamsungTvClient — persistToken', () => {
  let envPath: string;

  beforeEach(() => {
    envPath = makeTempEnvPath();
  });

  afterEach(() => {
    if (existsSync(envPath)) unlinkSync(envPath);
  });

  it('creates .env with token when file does not exist', () => {
    const client = makeClient('1.2.3.4', envPath);
    (client as unknown as { persistToken: (t: string) => void }).persistToken('abc123');

    const content = readFileSync(envPath, 'utf-8');
    expect(content).toContain('SAMSUNG_TV_TOKEN=abc123');
  });

  it('appends token to existing .env that has no token line', () => {
    writeFileSync(envPath, 'SAMSUNG_TV_IP=192.168.1.100\n');

    const client = makeClient('1.2.3.4', envPath);
    (client as unknown as { persistToken: (t: string) => void }).persistToken('mytoken');

    const content = readFileSync(envPath, 'utf-8');
    expect(content).toContain('SAMSUNG_TV_IP=192.168.1.100');
    expect(content).toContain('SAMSUNG_TV_TOKEN=mytoken');
  });

  it('replaces an existing token in .env', () => {
    writeFileSync(envPath, 'SAMSUNG_TV_IP=192.168.1.100\nSAMSUNG_TV_TOKEN=oldtoken\n');

    const client = makeClient('1.2.3.4', envPath);
    (client as unknown as { persistToken: (t: string) => void }).persistToken('newtoken');

    const content = readFileSync(envPath, 'utf-8');
    expect(content).toContain('SAMSUNG_TV_TOKEN=newtoken');
    expect(content).not.toContain('oldtoken');
  });

  it('does not duplicate SAMSUNG_TV_IP when updating token', () => {
    writeFileSync(envPath, 'SAMSUNG_TV_IP=192.168.1.100\nSAMSUNG_TV_TOKEN=old\n');

    const client = makeClient('1.2.3.4', envPath);
    (client as unknown as { persistToken: (t: string) => void }).persistToken('new');

    const content = readFileSync(envPath, 'utf-8');
    const ipLines = content.split('\n').filter((l) => l.startsWith('SAMSUNG_TV_IP='));
    expect(ipLines).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getDeviceInfo — requires IP to be configured
// ---------------------------------------------------------------------------

describe('SamsungTvClient — getDeviceInfo', () => {
  it('throws when IP is not configured', async () => {
    const client = new SamsungTvClient({ ip: undefined, name: 'test' });
    await expect(client.getDeviceInfo()).rejects.toThrow('SAMSUNG_TV_IP is not configured');
  });
});

// ---------------------------------------------------------------------------
// ip getter
// ---------------------------------------------------------------------------

describe('SamsungTvClient — ip getter', () => {
  it('returns configured IP', () => {
    const client = makeClient('10.0.0.5');
    expect(client.ip).toBe('10.0.0.5');
  });

  it('returns undefined when not configured', () => {
    const client = new SamsungTvClient({ ip: undefined, name: 'test' });
    expect(client.ip).toBeUndefined();
  });
});
