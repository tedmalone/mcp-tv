import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdbClient } from '../src/adb-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(ip = '192.168.1.100', port = 5555): AdbClient {
  return new AdbClient({ ip, port });
}

function makeClientNoIp(): AdbClient {
  return new AdbClient({ ip: undefined, port: 5555 });
}

// ---------------------------------------------------------------------------
// AdbClient constructor / serial
// ---------------------------------------------------------------------------

describe('AdbClient — serial', () => {
  it('builds serial from ip:port', () => {
    const client = makeClient('10.0.0.5', 5555);
    expect(client.configuredSerial).toBe('10.0.0.5:5555');
  });

  it('returns null when IP is not configured', () => {
    const client = makeClientNoIp();
    expect(client.configuredSerial).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AdbClient.listDevices — parsing
// ---------------------------------------------------------------------------

describe('AdbClient.listDevices', () => {
  let client: AdbClient;

  beforeEach(() => {
    client = makeClient();
  });

  it('returns empty array when no devices attached', async () => {
    vi.spyOn(client, 'runAdb').mockResolvedValueOnce('List of devices attached\n');
    expect(await client.listDevices()).toEqual([]);
  });

  it('parses a single ready device', async () => {
    const output = [
      'List of devices attached',
      '192.168.1.102:5555    device product:AFTMM model:AFTMM device:AFTMM transport_id:1',
    ].join('\n');
    vi.spyOn(client, 'runAdb').mockResolvedValueOnce(output);

    const devices = await client.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0].serial).toBe('192.168.1.102:5555');
    expect(devices[0].state).toBe('device');
    expect(devices[0].details.model).toBe('AFTMM');
    expect(devices[0].details.product).toBe('AFTMM');
  });

  it('parses an unauthorized device', async () => {
    const output = ['List of devices attached', '192.168.1.102:5555    unauthorized'].join('\n');
    vi.spyOn(client, 'runAdb').mockResolvedValueOnce(output);

    const devices = await client.listDevices();
    expect(devices[0].state).toBe('unauthorized');
  });

  it('parses multiple devices', async () => {
    const output = [
      'List of devices attached',
      '192.168.1.10:5555    device product:Fire model:Fire device:Fire transport_id:1',
      '192.168.1.11:5555    device product:Fire model:Fire2 device:Fire2 transport_id:2',
    ].join('\n');
    vi.spyOn(client, 'runAdb').mockResolvedValueOnce(output);

    const devices = await client.listDevices();
    expect(devices).toHaveLength(2);
    expect(devices[0].details.model).toBe('Fire');
    expect(devices[1].details.model).toBe('Fire2');
  });

  it('ignores blank lines', async () => {
    const output = 'List of devices attached\n\n192.168.1.5:5555    device\n\n';
    vi.spyOn(client, 'runAdb').mockResolvedValueOnce(output);

    const devices = await client.listDevices();
    expect(devices).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AdbClient.listMdnsServices — parsing
// ---------------------------------------------------------------------------

describe('AdbClient.listMdnsServices', () => {
  let client: AdbClient;

  beforeEach(() => {
    client = makeClient();
  });

  it('parses a service with IP and port', async () => {
    const line = 'fire-tv-12345    _adb-tls-connect._tcp    192.168.1.50:5555';
    vi.spyOn(client, 'runAdb').mockResolvedValueOnce(line);

    const services = await client.listMdnsServices();
    expect(services).toHaveLength(1);
    expect(services[0].instance).toBe('fire-tv-12345');
    expect(services[0].serviceType).toBe('_adb-tls-connect._tcp');
    expect(services[0].address).toBe('192.168.1.50');
    expect(services[0].port).toBe(5555);
  });

  it('handles service without IP address', async () => {
    const line = 'fire-tv-unknown    _adb._tcp    somehost:5555';
    vi.spyOn(client, 'runAdb').mockResolvedValueOnce(line);

    const services = await client.listMdnsServices();
    // address is only set when the part matches an IP pattern
    expect(services[0].address).toBeNull();
  });

  it('returns empty array for empty output', async () => {
    vi.spyOn(client, 'runAdb').mockResolvedValueOnce('');
    expect(await client.listMdnsServices()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AdbClient.getScreenXml — XML extraction
// ---------------------------------------------------------------------------

describe('AdbClient.getScreenXml', () => {
  let client: AdbClient;

  beforeEach(() => {
    client = makeClient();
    // shell delegates to ensureConnected + runAdb; mock at runAdb level
    vi.spyOn(client, 'runAdb').mockResolvedValue('');
    vi.spyOn(client as unknown as { connected: boolean }, 'connected', 'get').mockReturnValue(true);
  });

  it('extracts XML starting from <?xml', async () => {
    const xml = '<?xml version="1.0"?><hierarchy rotation="0"><node /></hierarchy>';
    vi.spyOn(client, 'shell').mockResolvedValueOnce(`UI dump\n${xml}`);

    const result = await client.getScreenXml();
    expect(result).toBe(xml);
  });

  it('throws when output contains no XML', async () => {
    vi.spyOn(client, 'shell').mockResolvedValueOnce('ERROR: no output');
    await expect(client.getScreenXml()).rejects.toThrow('uiautomator output did not contain XML');
  });
});

// ---------------------------------------------------------------------------
// AdbClient.ensureConnected — guards
// ---------------------------------------------------------------------------

describe('AdbClient.ensureConnected', () => {
  it('throws when IP is not configured', async () => {
    const client = makeClientNoIp();
    await expect(client.ensureConnected()).rejects.toThrow('FIRETV_IP is not configured');
  });
});
