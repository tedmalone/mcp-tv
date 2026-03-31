import { describe, it, expect, vi, beforeEach } from 'vitest';
import dgram from 'dgram';
import { sendWakeOnLan } from '../src/wol.js';

// ---------------------------------------------------------------------------
// Mock dgram so no real UDP socket is created
// ---------------------------------------------------------------------------

vi.mock('dgram');

function makeMockSocket(sendErr: Error | null = null) {
  let capturedPacket: Buffer | null = null;

  const socket = {
    once: vi.fn(),
    setBroadcast: vi.fn(),
    close: vi.fn(),
    bind: vi.fn().mockImplementation((cb: () => void) => cb()),
    send: vi
      .fn()
      .mockImplementation(
        (
          packet: Buffer,
          _offset: number,
          _length: number,
          _port: number,
          _addr: string,
          cb: (err: Error | null) => void,
        ) => {
          capturedPacket = Buffer.from(packet);
          cb(sendErr);
        },
      ),
    getPacket: () => capturedPacket,
  };

  vi.mocked(dgram.createSocket).mockReturnValue(socket as unknown as dgram.Socket);
  return socket;
}

// ---------------------------------------------------------------------------
// MAC address validation
// ---------------------------------------------------------------------------

describe('sendWakeOnLan — MAC validation', () => {
  it('rejects a MAC that is too short', async () => {
    await expect(sendWakeOnLan('AA:BB:CC:DD:EE')).rejects.toThrow('Invalid MAC address');
  });

  it('rejects a MAC with non-hex characters', async () => {
    await expect(sendWakeOnLan('GG:HH:II:JJ:KK:LL')).rejects.toThrow('Invalid MAC address');
  });

  it('rejects an empty string', async () => {
    await expect(sendWakeOnLan('')).rejects.toThrow('Invalid MAC address');
  });

  it('rejects a MAC that is too long (extra octet)', async () => {
    await expect(sendWakeOnLan('AA:BB:CC:DD:EE:FF:00')).rejects.toThrow('Invalid MAC address');
  });
});

// ---------------------------------------------------------------------------
// Magic packet structure
// ---------------------------------------------------------------------------

describe('sendWakeOnLan — packet structure', () => {
  beforeEach(() => {
    makeMockSocket();
  });

  it('accepts colon-separated MAC and sends a 102-byte packet', async () => {
    const socket = makeMockSocket();
    await sendWakeOnLan('AA:BB:CC:DD:EE:FF');

    const packet = socket.getPacket()!;
    expect(packet).not.toBeNull();
    expect(packet.length).toBe(102);
  });

  it('accepts hyphen-separated MAC', async () => {
    const socket = makeMockSocket();
    await sendWakeOnLan('AA-BB-CC-DD-EE-FF');
    expect(socket.getPacket()!.length).toBe(102);
  });

  it('accepts bare MAC (no separators)', async () => {
    const socket = makeMockSocket();
    await sendWakeOnLan('AABBCCDDEEFF');
    expect(socket.getPacket()!.length).toBe(102);
  });

  it('first 6 bytes are 0xFF (sync header)', async () => {
    const socket = makeMockSocket();
    await sendWakeOnLan('AA:BB:CC:DD:EE:FF');

    const packet = socket.getPacket()!;
    for (let i = 0; i < 6; i++) {
      expect(packet[i]).toBe(0xff);
    }
  });

  it('contains MAC address repeated 16 times after the sync header', async () => {
    const socket = makeMockSocket();
    await sendWakeOnLan('AA:BB:CC:DD:EE:FF');

    const packet = socket.getPacket()!;
    const expectedMac = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);

    for (let i = 0; i < 16; i++) {
      const slice = packet.slice(6 + i * 6, 6 + i * 6 + 6);
      expect(slice).toEqual(expectedMac);
    }
  });

  it('sends to port 9 by default', async () => {
    const socket = makeMockSocket();
    await sendWakeOnLan('AA:BB:CC:DD:EE:FF');

    const [, , , port] = vi.mocked(socket.send).mock.calls[0];
    expect(port).toBe(9);
  });

  it('sends to the provided broadcast address', async () => {
    const socket = makeMockSocket();
    await sendWakeOnLan('AA:BB:CC:DD:EE:FF', '192.168.1.255');

    const [, , , , addr] = vi.mocked(socket.send).mock.calls[0];
    expect(addr).toBe('192.168.1.255');
  });

  it('rejects when send fails', async () => {
    makeMockSocket(new Error('network unreachable'));
    await expect(sendWakeOnLan('AA:BB:CC:DD:EE:FF')).rejects.toThrow('WoL send failed');
  });
});
