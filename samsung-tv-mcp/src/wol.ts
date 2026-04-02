import dgram from 'dgram';

function buildMagicPacket(macAddress: string): Buffer {
  const mac = macAddress.replace(/[:-]/g, '');
  if (mac.length !== 12 || !/^[0-9a-fA-F]+$/.test(mac)) {
    throw new Error(`Invalid MAC address: ${macAddress}`);
  }
  const magicPacket = Buffer.alloc(102);
  magicPacket.fill(0xff, 0, 6);
  const macBytes = Buffer.from(mac, 'hex');
  for (let i = 0; i < 16; i++) {
    macBytes.copy(magicPacket, 6 + i * 6);
  }
  return magicPacket;
}

function sendOnce(
  magicPacket: Buffer,
  broadcastAddr: string,
  port = 9,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', (err) => {
      socket.close();
      reject(new Error(`WoL failed: ${err.message}`));
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(magicPacket, 0, magicPacket.length, port, broadcastAddr, (err) => {
        socket.close();
        if (err) {
          reject(new Error(`WoL send failed: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  });
}

/**
 * Send a single Wake-on-LAN magic packet.
 *
 * NOTE: A single packet is often unreliable over WiFi because Samsung TVs
 * power down their network interface in deep standby. Prefer sendWakeOnLanBurst().
 */
export function sendWakeOnLan(
  macAddress: string,
  broadcastAddr = '255.255.255.255',
): Promise<void> {
  return Promise.resolve().then(() => sendOnce(buildMagicPacket(macAddress), broadcastAddr));
}

/**
 * Send a burst of Wake-on-LAN magic packets with small inter-packet delays.
 *
 * 16 packets at ~100ms spacing is the community-recommended approach.
 * On TVs with a built-in SmartThings hub (e.g. QN55S95FAFXZA), the hub keeps
 * the WiFi interface active in standby so WoL works reliably over WiFi.
 *
 * The TV must have "Power On with Mobile" enabled:
 *   Settings → General → Network → Expert Settings → Power On with Mobile
 */
export async function sendWakeOnLanBurst(
  macAddress: string,
  broadcastAddr = '255.255.255.255',
  { count = 16, delayMs = 100 }: { count?: number; delayMs?: number } = {},
): Promise<void> {
  const packet = buildMagicPacket(macAddress);
  for (let i = 0; i < count; i++) {
    await sendOnce(packet, broadcastAddr);
    if (i < count - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
