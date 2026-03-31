import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SamsungRestDevice, SamsungRestResponse } from './samsung-client.js';
import { SamsungTvClient } from './samsung-client.js';
import { sendWakeOnLan } from './wol.js';

/** Samsung key code mapping for input sources */
const INPUT_KEY_CODES: Record<string, string> = {
  hdmi1: 'KEY_HDMI1',
  hdmi2: 'KEY_HDMI2',
  hdmi3: 'KEY_HDMI3',
  hdmi4: 'KEY_HDMI4',
  hdmi: 'KEY_HDMI',
  dtv: 'KEY_DTV',
  tv: 'KEY_TV',
  component1: 'KEY_COMPONENT1',
  component2: 'KEY_COMPONENT2',
  av1: 'KEY_AV1',
  av2: 'KEY_AV2',
};

const VALID_INPUTS = Object.keys(INPUT_KEY_CODES);

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// Default /24 host scan range for common home networks.
const DEFAULT_DISCOVERY_SCAN_START = 1;
const DEFAULT_DISCOVERY_SCAN_END = 254;
// 24 concurrent probes balances speed and avoiding aggressive LAN bursts.
const DEFAULT_DISCOVERY_CONCURRENCY = 24;
// Keep per-host discovery probes short to keep overall scan time reasonable.
const DEFAULT_DISCOVERY_TIMEOUT_MS = 1200;
// Samsung REST metadata API default port.
const DEFAULT_DISCOVERY_REST_PORT = 8001;

const DISCOVERY_SCAN_START = envInt(
  'SAMSUNG_TV_DISCOVERY_SCAN_START',
  DEFAULT_DISCOVERY_SCAN_START,
);
const DISCOVERY_SCAN_END = envInt('SAMSUNG_TV_DISCOVERY_SCAN_END', DEFAULT_DISCOVERY_SCAN_END);
const DISCOVERY_CONCURRENCY = envInt(
  'SAMSUNG_TV_DISCOVERY_CONCURRENCY',
  DEFAULT_DISCOVERY_CONCURRENCY,
);
const DISCOVERY_TIMEOUT_MS = envInt(
  'SAMSUNG_TV_DISCOVERY_TIMEOUT_MS',
  DEFAULT_DISCOVERY_TIMEOUT_MS,
);
const DISCOVERY_REST_PORT = envInt('SAMSUNG_TV_REST_PORT', DEFAULT_DISCOVERY_REST_PORT);

interface SamsungDiscoverResult {
  id: string;
  brand: 'samsung_tv';
  ip: string;
  name: string;
  model: string | null;
  mac: string | null;
  status: 'ready' | 'reachable';
  confidence: 'high';
  next_step: string;
  raw: {
    device: SamsungRestDevice;
  };
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function withHints(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes('connect') ||
    lower.includes('timeout') ||
    lower.includes('websocket') ||
    lower.includes('not configured')
  ) {
    return `${message}\nHint: Confirm SAMSUNG_TV_IP is correct, TV is on the same LAN, and remote-control permission is accepted on TV.`;
  }
  return message;
}

export function registerTools(
  server: McpServer,
  client: SamsungTvClient,
  macAddress?: string,
): void {
  server.tool(
    'discover',
    'Discover Samsung TVs on the local subnet and return setup metadata (including MAC when available).',
    {
      ip: z.string().optional().describe('Optional single IP to verify (fast path)'),
      subnet: z.string().optional().describe('Optional subnet prefix like 192.168.1'),
      start: z
        .number()
        .int()
        .min(1)
        .max(254)
        .optional()
        .describe('Start host for subnet scan (default 1)'),
      end: z
        .number()
        .int()
        .min(1)
        .max(254)
        .optional()
        .describe('End host for subnet scan (default 254)'),
    },
    async ({ ip, subnet, start, end }) => {
      try {
        const scanStart = start ?? DISCOVERY_SCAN_START;
        const scanEnd = end ?? DISCOVERY_SCAN_END;
        const effectiveSubnet =
          subnet ?? (client.ip ? client.ip.split('.').slice(0, 3).join('.') : undefined);
        if (!ip && !effectiveSubnet) {
          return err(
            'No IP context provided. Pass ip=... or subnet=..., or configure SAMSUNG_TV_IP.',
          );
        }
        const targets = ip
          ? [ip]
          : Array.from(
              { length: scanEnd - scanStart + 1 },
              (_, i) => `${effectiveSubnet}.${scanStart + i}`,
            );

        const probe = async (targetIp: string) => {
          try {
            const res = await fetch(`http://${targetIp}:${DISCOVERY_REST_PORT}/api/v2/`, {
              signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
            });
            if (!res.ok) return null;
            const parsed: unknown = await res.json();
            const info =
              typeof parsed === 'object' && parsed !== null
                ? (parsed as SamsungRestResponse)
                : ({} as SamsungRestResponse);
            const device = (info.device ?? {}) as SamsungRestDevice;
            const name = String(device.name ?? device.friendlyName ?? `Samsung TV (${targetIp})`);
            const model = String(device.modelName ?? device.model ?? '');
            const mac = String(device.wifiMac ?? device.mac ?? '').trim() || null;
            return {
              id: `samsung_tv:${targetIp}`,
              brand: 'samsung_tv',
              ip: targetIp,
              name,
              model: model || null,
              mac,
              status: mac ? 'ready' : 'reachable',
              confidence: 'high',
              next_step: mac
                ? 'Run control tools directly. Wake-on-LAN is available.'
                : 'TV found but MAC missing in API response. Control works; WoL may require fallback lookup.',
              raw: {
                device,
              },
            };
          } catch {
            return null;
          }
        };

        const results: SamsungDiscoverResult[] = [];
        const concurrency = DISCOVERY_CONCURRENCY;
        for (let i = 0; i < targets.length; i += concurrency) {
          const batch = targets.slice(i, i + concurrency);
          const batchResults = await Promise.all(batch.map(probe));
          for (const found of batchResults) {
            if (found) results.push(found);
          }
        }

        return ok(JSON.stringify(results, null, 2));
      } catch (e) {
        return err(withHints(`Discover failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  // --- Power ---

  server.tool(
    'power',
    'Turn the Samsung TV on or off. Power on uses Wake-on-LAN; power off sends KEY_POWER via WebSocket.',
    {
      action: z.enum(['on', 'off']).describe("'on' to wake the TV, 'off' to turn it off"),
    },
    async ({ action }) => {
      try {
        if (action === 'on') {
          if (!macAddress) {
            return err(
              'SAMSUNG_TV_MAC is not configured. Run discover and save a MAC address before using power on.',
            );
          }
          await sendWakeOnLan(macAddress);
          return ok('Wake-on-LAN magic packet sent. TV should power on within a few seconds.');
        } else {
          await client.sendKey('KEY_POWER');
          return ok('Power off command sent.');
        }
      } catch (e) {
        return err(
          withHints(`Power ${action} failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    },
  );

  // --- Volume ---

  server.tool(
    'set_volume',
    'Set the TV volume by sending volume up/down key presses. Specify a direction and number of steps.',
    {
      direction: z.enum(['up', 'down']).describe('Volume direction'),
      steps: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Number of key presses (default 1)'),
    },
    async ({ direction, steps }) => {
      try {
        const count = steps ?? 1;
        const key = direction === 'up' ? 'KEY_VOLUP' : 'KEY_VOLDOWN';
        const keys = Array.from({ length: count }, () => key);
        await client.sendKeys(keys);
        return ok(`Volume ${direction} x${count} sent.`);
      } catch (e) {
        return err(withHints(`Set volume failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  server.tool(
    'get_volume',
    'Get Samsung TV device info including model and name. (Direct volume level query requires Samsung SmartThings API integration.)',
    {},
    async () => {
      try {
        const info = await client.getDeviceInfo();
        return ok(JSON.stringify(info, null, 2));
      } catch (e) {
        return err(
          withHints(`Get device info failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    },
  );

  server.tool(
    'mute',
    'Toggle mute on the Samsung TV',
    {
      mute: z.boolean().describe('true to mute, false to unmute (sends KEY_MUTE toggle)'),
    },
    async () => {
      try {
        await client.sendKey('KEY_MUTE');
        return ok('Mute toggle sent.');
      } catch (e) {
        return err(withHints(`Mute failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  // --- Input switching ---

  server.tool(
    'switch_input',
    `Switch the TV input source. Valid inputs: ${VALID_INPUTS.join(', ')}`,
    {
      input: z.string().describe(`Input source name: ${VALID_INPUTS.join(', ')}`),
    },
    async ({ input }) => {
      const key = INPUT_KEY_CODES[input.toLowerCase()];
      if (!key) {
        return err(`Unknown input '${input}'. Valid inputs: ${VALID_INPUTS.join(', ')}`);
      }
      try {
        await client.sendKey(key);
        return ok(`Switched to input: ${input}`);
      } catch (e) {
        return err(withHints(`Switch input failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  // --- Bonus: raw key for flexibility ---

  server.tool(
    'send_key',
    'Send a raw Samsung key code to the TV (e.g., KEY_MENU, KEY_ENTER, KEY_RETURN, KEY_UP, KEY_DOWN, KEY_LEFT, KEY_RIGHT)',
    {
      key: z.string().min(1).describe('Samsung key code (e.g., KEY_ENTER, KEY_MENU, KEY_RETURN)'),
    },
    async ({ key }) => {
      try {
        await client.sendKey(key);
        return ok(`Key ${key} sent.`);
      } catch (e) {
        return err(withHints(`Send key failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );
}
