import { z } from 'zod';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SamsungRestDevice, SamsungRestResponse } from './samsung-client.js';
import { SamsungTvClient } from './samsung-client.js';
import { SmartThingsClient } from './smartthings-client.js';
import { sendWakeOnLanBurst } from './wol.js';

const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');

/** Samsung key code mapping for input sources (WebSocket fallback only) */
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

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Switch input via Samsung source picker grid (WebSocket fallback).
 *
 * On newer Tizen models (2024+) KEY_HDMIx keycodes are ignored. The source grid
 * is the only reliable WebSocket path. When opened via KEY_SOURCE, the grid always
 * focuses the current active input. The most recently used other input is always
 * one step RIGHT and one step UP from there (confirmed on QN55S95FAFXZA, 2025).
 *
 * Prefer SmartThings setInputSource when available — it is instant and reliable.
 */
async function switchViaSourceGrid(client: SamsungTvClient): Promise<void> {
  const NAV_DELAY = 350;
  await client.sendKey('KEY_SOURCE');
  await delay(700);
  await client.sendKey('KEY_RIGHT');
  await delay(NAV_DELAY);
  await client.sendKey('KEY_UP');
  await delay(NAV_DELAY);
  await client.sendKey('KEY_ENTER');
}

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
  st: SmartThingsClient,
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
        if (scanStart > scanEnd) {
          return err(`Invalid scan range: start (${scanStart}) must be <= end (${scanEnd}).`);
        }
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
            if (mac && (!client.ip || !client.mac)) {
              client.persistDiscovery(targetIp, mac);
            }
            return {
              id: `samsung_tv:${targetIp}`,
              brand: 'samsung_tv' as const,
              ip: targetIp,
              name,
              model: model || null,
              mac,
              status: (mac ? 'ready' : 'reachable') as 'ready' | 'reachable',
              confidence: 'high' as const,
              next_step: mac
                ? 'TV IP and MAC auto-saved. Run control tools directly. Wake-on-LAN is available.'
                : 'TV found but MAC missing in API response. Control works; WoL may require manual MAC config.',
              raw: { device },
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
    [
      'Turn the Samsung TV on or off.',
      'Power ON: (1) Wake-on-LAN burst (16 packets) — works over WiFi on this model because the built-in',
      'SmartThings hub keeps the network interface active in standby. Requires SAMSUNG_TV_MAC and',
      '"Power On with Mobile" enabled (Settings → General → Network → Expert Settings).',
      '(2) SmartThings API fallback if WoL MAC is not configured (requires SAMSUNG_SMARTTHINGS_TOKEN + SAMSUNG_SMARTTHINGS_DEVICE_ID).',
      'Power OFF: KEY_POWER via WebSocket.',
    ].join(' '),
    {
      action: z.enum(['on', 'off']).describe("'on' to wake the TV, 'off' to turn it off"),
    },
    async ({ action }) => {
      try {
        if (action === 'on') {
          if (client.mac) {
            const broadcast =
              process.env.SAMSUNG_TV_WOL_BROADCAST ??
              (client.ip
                ? client.ip.split('.').slice(0, 3).join('.') + '.255'
                : '255.255.255.255');
            await sendWakeOnLanBurst(client.mac, broadcast);
            return ok('Wake-on-LAN burst sent (16 packets). TV should power on within a few seconds.');
          }
          if (st.configured) {
            await st.powerOn();
            return ok('Power on sent via SmartThings API.');
          }
          return err(
            'No power-on method available. Configure SAMSUNG_TV_MAC (run discover) or ' +
              'SAMSUNG_SMARTTHINGS_TOKEN + SAMSUNG_SMARTTHINGS_DEVICE_ID.',
          );
        } else {
          await client.sendKey('KEY_POWER');
          return ok('Power off command sent via WebSocket.');
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
    'Toggle mute on the Samsung TV. Sends KEY_MUTE regardless of current state — the TV toggles on each call. There is no way to read current mute state via this API.',
    {},
    async () => {
      try {
        await client.sendKey('KEY_MUTE');
        return ok('Mute toggled.');
      } catch (e) {
        return err(withHints(`Mute failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  // --- Input switching ---

  server.tool(
    'switch_input',
    [
      `Switch the TV input source.`,
      `Priority: (1) SmartThings setInputSource — direct, instant (requires SAMSUNG_SMARTTHINGS_TOKEN + SAMSUNG_SMARTTHINGS_DEVICE_ID).`,
      `Pass the exact input ID from list_inputs (e.g. "HDMI2", "dtv"). Input IDs are device-specific.`,
      `(2) Source picker grid fallback — KEY_SOURCE → RIGHT → UP → ENTER, selects the previously active input. Note: KEY_HDMIx keycodes are ignored on 2024+ models.`,
    ].join(' '),
    {
      input: z.string().describe('Input source ID from list_inputs (e.g. "HDMI2", "dtv")'),
    },
    async ({ input }) => {
      try {
        if (st.configured) {
          await st.setInputSource(input);
          return ok(`Switched to ${input} via SmartThings API.`);
        }
        // WebSocket fallback: source grid navigation
        await switchViaSourceGrid(client);
        return ok(
          `Switched input via source grid (KEY_SOURCE → RIGHT → UP → ENTER).\n` +
            `Note: This selects the previously active input. For direct input selection, configure SmartThings.`,
        );
      } catch (e) {
        return err(withHints(`Switch input failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  // --- SmartThings info tool ---

  server.tool(
    'list_inputs',
    'List available input sources from SmartThings API. Requires SAMSUNG_SMARTTHINGS_TOKEN and SAMSUNG_SMARTTHINGS_DEVICE_ID.',
    {},
    async () => {
      if (!st.configured) {
        return err(
          'SmartThings not configured. Set SAMSUNG_SMARTTHINGS_TOKEN and SAMSUNG_SMARTTHINGS_DEVICE_ID to use this tool.',
        );
      }
      try {
        const sources = await st.getSupportedInputSources();
        return ok(
          sources.length > 0
            ? `Supported input sources:\n${sources.map((s) => `  ${s.id} — ${s.name}`).join('\n')}`
            : 'No input sources returned (TV may be off or SmartThings integration not linked).',
        );
      } catch (e) {
        return err(`list_inputs failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'get_input',
    'Get the current active input source. Requires SAMSUNG_SMARTTHINGS_TOKEN and SAMSUNG_SMARTTHINGS_DEVICE_ID.',
    {},
    async () => {
      if (!st.configured) {
        return err(
          'SmartThings not configured. Set SAMSUNG_SMARTTHINGS_TOKEN and SAMSUNG_SMARTTHINGS_DEVICE_ID to use this tool.',
        );
      }
      try {
        const current = await st.getCurrentInputSource();
        return ok(current ? `Current input: ${current}` : 'Current input unknown (TV may be off).');
      } catch (e) {
        return err(`get_input failed: ${e instanceof Error ? e.message : String(e)}`);
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
