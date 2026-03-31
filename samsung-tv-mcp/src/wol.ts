import dgram from 'dgram';

/**
 * Send a Wake-on-LAN magic packet to the given MAC address.
 * The TV must have "Network Standby" enabled in Settings.
 */
export function sendWakeOnLan(
  macAddress: string,
  broadcastAddr = '255.255.255.255',
): Promise<void> {
  const mac = macAddress.replace(/[:-]/g, '');
  if (mac.length !== 12 || !/^[0-9a-fA-F]+$/.test(mac)) {
    return Promise.reject(new Error(`Invalid MAC address: ${macAddress}`));
  }

  // Magic packet: 6 bytes of 0xFF followed by 16 repetitions of the MAC
  const magicPacket = Buffer.alloc(102);
  magicPacket.fill(0xff, 0, 6);
  const macBytes = Buffer.from(mac, 'hex');
  for (let i = 0; i < 16; i++) {
    macBytes.copy(magicPacket, 6 + i * 6);
  }

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');

    socket.once('error', (err) => {
      socket.close();
      reject(new Error(`WoL failed: ${err.message}`));
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(magicPacket, 0, magicPacket.length, 9, broadcastAddr, (err) => {
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
