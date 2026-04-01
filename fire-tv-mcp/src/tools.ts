import { z } from 'zod';
import { XMLParser } from 'fast-xml-parser';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AdbClient } from './adb-client.js';
import { FireTvRestClient, toRestKey } from './firetv-rest-client.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  allowBooleanAttributes: true,
});

const KEYCODES: Record<string, string> = {
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT',
  select: 'KEYCODE_DPAD_CENTER',
  enter: 'KEYCODE_ENTER',
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  menu: 'KEYCODE_MENU',
  play: 'KEYCODE_MEDIA_PLAY',
  pause: 'KEYCODE_MEDIA_PAUSE',
  play_pause: 'KEYCODE_MEDIA_PLAY_PAUSE',
  rewind: 'KEYCODE_MEDIA_REWIND',
  fast_forward: 'KEYCODE_MEDIA_FAST_FORWARD',
  sleep: 'KEYCODE_SLEEP',
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
  mute: 'KEYCODE_MUTE',
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

const DEFAULT_PRESS_KEYS_DELAY_MAX_MS = 5000;
const PRESS_KEYS_DELAY_MAX_MS = envInt(
  'FIRETV_PRESS_KEYS_DELAY_MAX_MS',
  DEFAULT_PRESS_KEYS_DELAY_MAX_MS,
);

type UiNode = {
  text?: string;
  'content-desc'?: string;
  'resource-id'?: string;
  class?: string;
  bounds?: string;
  clickable?: string;
  node?: UiNode[] | UiNode;
};

function isLikelyFireTvDevice(device: {
  serial: string;
  details: Record<string, string>;
}): boolean {
  const fields = [
    device.serial,
    device.details.model ?? '',
    device.details.product ?? '',
    device.details.device ?? '',
  ]
    .join(' ')
    .toLowerCase();

  // Fire TV devices commonly expose AFT* model/product/device identifiers.
  if (/\baft[a-z0-9_-]*\b/.test(fields)) return true;
  if (fields.includes('fire tv')) return true;
  if (fields.includes('amazon')) return true;
  return false;
}

function isLikelyFireTvMdns(service: { instance: string; serviceType: string }): boolean {
  const text = `${service.instance} ${service.serviceType}`.toLowerCase();
  return text.includes('fire-tv') || /\baft[a-z0-9_-]*\b/.test(text) || text.includes('amazon');
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
    lower.includes('failed to connect') ||
    lower.includes('unauthorized') ||
    lower.includes('no devices') ||
    lower.includes('not configured')
  ) {
    return (
      `${message}\nHint: If FIRETV_IP is not set, run discover first to find your device IP. ` +
      'Then set FIRETV_IP/FIRETV_PORT, ensure ADB debugging is enabled, and accept the trust prompt on TV.'
    );
  }
  return message;
}

function normalizeKey(key: string): string {
  const normalized = key.toLowerCase();
  return KEYCODES[normalized] ?? key;
}

function encodeInputText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/ /g, '%s');
}

function extractNodes(root: UiNode | UiNode[] | undefined, out: UiNode[] = []): UiNode[] {
  if (!root) return out;
  if (Array.isArray(root)) {
    for (const node of root) extractNodes(node, out);
    return out;
  }
  out.push(root);
  if (root.node) extractNodes(root.node, out);
  return out;
}

function parseBounds(bounds: string): { x: number; y: number } {
  const match = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) {
    throw new Error(`Invalid bounds: ${bounds}`);
  }
  const x1 = Number(match[1]);
  const y1 = Number(match[2]);
  const x2 = Number(match[3]);
  const y2 = Number(match[4]);
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

async function getScreenNodes(client: AdbClient): Promise<UiNode[]> {
  const xml = await client.getScreenXml();
  const parsed = parser.parse(xml) as { hierarchy?: { node?: UiNode[] | UiNode } };
  return extractNodes(parsed.hierarchy?.node);
}

/**
 * Try a REST key press; if REST is not ready or fails, fall back to ADB.
 * Returns a string describing which path was used.
 */
async function pressKeyHybrid(
  key: string,
  rest: FireTvRestClient,
  adb: AdbClient,
): Promise<string> {
  if (rest.ready) {
    const mapped = toRestKey(key);
    if (mapped) {
      try {
        if (mapped.type === 'nav') {
          await rest.sendNavKey(mapped.action);
        } else {
          await rest.sendMediaCommand(mapped.action, mapped.body);
        }
        return 'rest';
      } catch {
        // fall through to ADB
      }
    }
  }
  await adb.keyevent(normalizeKey(key));
  return 'adb';
}

export function registerTools(server: McpServer, adb: AdbClient, rest: FireTvRestClient): void {
  // --- Discovery ---

  server.tool(
    'discover',
    'Discover Fire TV / Android TV devices using adb mDNS and attached device list.',
    {},
    async () => {
      try {
        const mdns = await adb.listMdnsServices().catch(() => []);

        // Proactively attempt adb connect for mDNS-advertised targets so discovery
        // works even when the user hasn't manually run `adb connect` yet.
        const mdnsTargets = Array.from(
          new Set(
            mdns
              .filter((service) => service.address && service.port)
              .map((service) => `${service.address}:${service.port}`),
          ),
        );
        for (const serial of mdnsTargets) {
          await adb.runAdb(['connect', serial]).catch(() => undefined);
        }

        const devices = await adb.listDevices().catch(() => []);

        const fireMdns = mdns.filter(isLikelyFireTvMdns);
        const fireDevices = devices.filter(isLikelyFireTvDevice);
        const nonFireDevices = devices.filter((device) => !isLikelyFireTvDevice(device));

        let autoSelectedSerial: string | null = null;
        if (!adb.configuredSerial) {
          const readyDevice = fireDevices.find((device) => device.state === 'device');
          if (readyDevice) {
            adb.setActiveSerial(readyDevice.serial);
            autoSelectedSerial = readyDevice.serial;
          }
        }

        const mappedMdns = fireMdns.map((service) => ({
          id: `fire_tv:${service.address ?? service.instance}`,
          brand: 'fire_tv',
          ip: service.address,
          name: service.instance,
          model: null,
          mac: null,
          status: 'discovered',
          confidence: 'medium',
          next_step:
            'If this is your Fire TV, set FIRETV_IP and run get_device_info (accept ADB trust prompt on TV if shown).',
          raw: { serviceType: service.serviceType, port: service.port, line: service.raw },
        }));

        const mappedDevices = fireDevices.map((device) => {
          const [ipPart] = device.serial.split(':');
          const isIpSerial = /^\d{1,3}(\.\d{1,3}){3}$/.test(ipPart);
          return {
            id: `fire_tv:${device.serial}`,
            brand: 'fire_tv',
            ip: isIpSerial ? ipPart : null,
            name: device.details.model ?? device.details.device ?? 'ADB Device',
            model: device.details.model ?? null,
            mac: null,
            status: device.state === 'device' ? 'ready' : 'needs_auth',
            confidence: 'high',
            next_step:
              device.state === 'device'
                ? 'Device is ready for control.'
                : 'Authorize ADB on the TV, then retry.',
            raw: device,
          };
        });

        const payload = JSON.stringify([...mappedMdns, ...mappedDevices], null, 2);
        const notes: string[] = [];
        if (nonFireDevices.length > 0) {
          notes.push(
            `Ignored ${nonFireDevices.length} non-Fire ADB device(s) for fire-tv-mcp targeting.`,
          );
        }
        if (mappedMdns.length === 0 && mappedDevices.length === 0 && nonFireDevices.length > 0) {
          notes.push(
            'No likely Fire TV devices found. If those are Google TV / Android TV devices, use the dedicated Google TV connector.',
          );
        }

        if (autoSelectedSerial) {
          return ok(
            [
              `Auto-selected discovered device for this session: ${autoSelectedSerial}`,
              ...notes,
              payload,
            ].join('\n\n'),
          );
        }

        if (notes.length > 0) {
          return ok([...notes, payload].join('\n\n'));
        }
        return ok(payload);
      } catch (e) {
        return err(withHints(`discover failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  // --- Friendly pairing flow ---

  server.tool(
    'pair',
    [
      'User-friendly pairing flow for Fire TV.',
      'Use action="start" to discover and connect via ADB, then optionally begin REST PIN pairing.',
      'Use action="verify_pin" with pin="<4-digit>" to finish REST pairing.',
      'Use action="status" to see current ADB/REST pairing state.',
    ].join(' '),
    {
      action: z.enum(['start', 'verify_pin', 'status']).optional(),
      pin: z.string().optional(),
      friendly_name: z.string().optional(),
    },
    async ({ action, pin, friendly_name }) => {
      const step = action ?? 'start';
      try {
        if (step === 'status') {
          const lines = [
            `ADB configured target: ${adb.configuredSerial ?? 'none (discovery mode)'}`,
            `ADB active target: ${adb.activeSerial ?? 'none selected'}`,
            `REST configured: ${rest.configured ? 'yes' : 'no (set FIRETV_REST_API_KEY)'}`,
            `REST paired: ${rest.ready ? 'yes' : 'no'}`,
          ];
          return ok(lines.join('\n'));
        }

        if (step === 'verify_pin') {
          if (!pin) return err('pair verify_pin requires a 4-digit pin.');
          if (!rest.configured) {
            return err(
              'REST pairing is not configured. Set FIRETV_REST_API_KEY in .env and restart the MCP server, then run pair start.',
            );
          }
          const token = await rest.verifyPin(pin);
          return ok(
            [
              'REST pairing complete.',
              'Fast REST path is now enabled for supported navigation/media tools.',
              `Saved token: ${token}`,
            ].join('\n'),
          );
        }

        const mdns = await adb.listMdnsServices().catch(() => []);
        const mdnsTargets = Array.from(
          new Set(
            mdns
              .filter((service) => service.address && service.port)
              .map((service) => `${service.address}:${service.port}`),
          ),
        );
        for (const serial of mdnsTargets) {
          await adb.runAdb(['connect', serial]).catch(() => undefined);
        }

        const devices = await adb.listDevices().catch(() => []);
        const fireDevices = devices.filter(isLikelyFireTvDevice);
        const ready = fireDevices.find((d) => d.state === 'device') ?? null;
        const fallback = fireDevices[0] ?? null;
        const target = ready ?? fallback;

        if (!target) {
          return err(
            [
              'No likely Fire TV devices found yet.',
              'Make sure ADB debugging is enabled on Fire TV and the TV is on the same network.',
              'Then run pair start again.',
            ].join('\n'),
          );
        }

        if (target.state === 'device') {
          adb.setActiveSerial(target.serial);
        }

        const lines = [
          `Found Fire TV candidate: ${target.serial} (${target.details.model ?? 'unknown model'})`,
          target.state === 'device'
            ? 'ADB pairing is ready.'
            : `ADB state is "${target.state}". Accept the USB debugging trust prompt on TV, then run pair start again.`,
        ];

        if (rest.configured) {
          if (rest.ready) {
            lines.push('REST pairing is already ready.');
          } else if (target.state === 'device') {
            await rest.displayPin(friendly_name ?? 'fire-tv-mcp');
            lines.push(
              'REST PIN displayed on TV. Run pair with action="verify_pin" and pin="<4-digit-PIN>" to complete fast pairing.',
            );
          } else {
            lines.push('REST pairing will be available after ADB trust is completed.');
          }
        } else {
          lines.push(
            'Optional: set FIRETV_REST_API_KEY in .env and restart if you want faster REST control after ADB pairing.',
          );
        }

        return ok(lines.join('\n'));
      } catch (e) {
        return err(withHints(`pair failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  // --- REST pairing ---

  server.tool(
    'setup_rest',
    [
      'Set up the Fire TV REST API (port 8080) for fast, ADB-free control.',
      'Step 1: call with action="display_pin" — a 4-digit PIN appears on the TV screen.',
      'Step 2: call with action="verify_pin" and pin="<PIN>" — authenticates and saves the token.',
      'After setup, navigation commands automatically use the REST API (~50ms) instead of ADB (~100-500ms).',
      'Requires FIRETV_REST_API_KEY in .env (any non-empty string works as the initial API key).',
    ].join(' '),
    {
      action: z.enum(['display_pin', 'verify_pin']).describe('Pairing step to perform'),
      pin: z.string().optional().describe('4-digit PIN from TV screen (required for verify_pin)'),
      friendly_name: z
        .string()
        .optional()
        .describe('Name shown on TV during pairing (default: fire-tv-mcp)'),
    },
    async ({ action, pin, friendly_name }) => {
      if (!rest.configured) {
        return err(
          'FIRETV_REST_API_KEY is not set. Add it to .env (any non-empty string works as the initial key).',
        );
      }
      try {
        if (action === 'display_pin') {
          await rest.displayPin(friendly_name ?? 'fire-tv-mcp');
          return ok(
            'PIN displayed on TV. You have ~60 seconds to call setup_rest with action="verify_pin" and pin="<4-digit-PIN>".',
          );
        } else {
          if (!pin) return err('pin is required for verify_pin action.');
          const token = await rest.verifyPin(pin);
          return ok(
            `REST API authenticated. Token saved to .env as FIRETV_REST_TOKEN.\n` +
              `Token: ${token}\n` +
              `Navigation commands will now use the REST API automatically.`,
          );
        }
      } catch (e) {
        return err(`setup_rest failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // --- Navigation (hybrid: REST fast path, ADB fallback) ---

  server.tool(
    'press_key',
    [
      'Press a single Fire TV key (friendly names like up/down/home/back or raw KEYCODE_*).',
      'Uses REST API (~50ms) when configured, falls back to ADB (~100-500ms).',
    ].join(' '),
    { key: z.string().min(1) },
    async ({ key }) => {
      try {
        const path = await pressKeyHybrid(key, rest, adb);
        return ok(`Pressed key: ${key} (via ${path})`);
      } catch (e) {
        return err(withHints(`press_key failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  server.tool(
    'press_keys',
    [
      'Press multiple keys in sequence with an optional delay.',
      'Uses REST API when configured, falls back to ADB.',
    ].join(' '),
    {
      keys: z.array(z.string().min(1)).min(1),
      delayMs: z.number().int().min(0).max(PRESS_KEYS_DELAY_MAX_MS).optional(),
    },
    async ({ keys, delayMs }) => {
      try {
        for (const key of keys) {
          await pressKeyHybrid(key, rest, adb);
          if ((delayMs ?? 0) > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
        return ok(`Pressed ${keys.length} key(s).`);
      } catch (e) {
        return err(withHints(`press_keys failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  server.tool(
    'go_home',
    'Go to the Fire TV home screen. Uses REST API when configured, falls back to ADB.',
    {},
    async () => {
      try {
        const path = await pressKeyHybrid('home', rest, adb);
        return ok(`Sent home (via ${path}).`);
      } catch (e) {
        return err(withHints(`go_home failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  server.tool(
    'go_back',
    'Go back on the Fire TV. Uses REST API when configured, falls back to ADB.',
    {},
    async () => {
      try {
        const path = await pressKeyHybrid('back', rest, adb);
        return ok(`Sent back (via ${path}).`);
      } catch (e) {
        return err(withHints(`go_back failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  // --- Text input (ADB only) ---

  server.tool(
    'type_text',
    'Type text into the currently focused input. Requires ADB.',
    { text: z.string() },
    async ({ text }) => {
      try {
        await adb.shell(`input text "${encodeInputText(text)}"`);
        return ok('Typed text.');
      } catch (e) {
        return err(withHints(`type_text failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  // --- App launch (hybrid) ---

  server.tool(
    'launch_app',
    [
      'Launch app by package name.',
      'Uses REST API when configured (faster, no adb binary needed), falls back to ADB.',
    ].join(' '),
    { package: z.string().min(1) },
    async ({ package: pkg }) => {
      try {
        if (rest.ready) {
          try {
            await rest.launchApp(pkg);
            return ok(`Launched ${pkg} (via REST)`);
          } catch {
            // fall through to ADB
          }
        }
        await adb.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
        return ok(`Launch command sent for package: ${pkg} (via ADB)`);
      } catch (e) {
        return err(withHints(`launch_app failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  // --- ADB-only tools ---

  server.tool('list_apps', 'List installed third-party apps (requires ADB).', {}, async () => {
    try {
      const out = await adb.shell('pm list packages -3');
      return ok(out);
    } catch (e) {
      return err(withHints(`list_apps failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  });

  server.tool(
    'get_current_app',
    'Get current foreground activity/app (requires ADB).',
    {},
    async () => {
      try {
        const out = await adb.shell('dumpsys activity activities | grep mResumedActivity');
        return ok(out);
      } catch (e) {
        return err(
          withHints(`get_current_app failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    },
  );

  server.tool(
    'deep_link',
    'Open a deep link URI on the Fire TV (requires ADB).',
    { uri: z.string().url() },
    async ({ uri }) => {
      try {
        await adb.shell(`am start -a android.intent.action.VIEW -d "${uri}"`);
        return ok(`Opened URI: ${uri}`);
      } catch (e) {
        return err(withHints(`deep_link failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  server.tool(
    'screenshot',
    'Capture a screenshot and return base64 PNG (requires ADB).',
    {},
    async () => {
      try {
        const pngBase64 = await adb.screenshotBase64();
        return ok(pngBase64);
      } catch (e) {
        return err(withHints(`screenshot failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  server.tool(
    'list_devices',
    'List ADB devices currently visible to host.',
    {},
    async () => {
      try {
        const devices = await adb.listDevices();
        return ok(JSON.stringify(devices, null, 2));
      } catch (e) {
        return err(
          withHints(`list_devices failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    },
  );

  server.tool(
    'get_device_info',
    'Get basic Fire TV properties via getprop (requires ADB).',
    {},
    async () => {
      try {
        const [model, release, sdk, serial] = await Promise.all([
          adb.shell('getprop ro.product.model'),
          adb.shell('getprop ro.build.version.release'),
          adb.shell('getprop ro.build.version.sdk'),
          adb.shell('getprop ro.serialno'),
        ]);
        return ok(JSON.stringify({ model, androidVersion: release, sdk, serial }, null, 2));
      } catch (e) {
        return err(
          withHints(`get_device_info failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    },
  );

  server.tool(
    'sleep',
    'Put Fire TV to sleep. Uses REST API when configured, falls back to ADB.',
    {},
    async () => {
      try {
        const path = await pressKeyHybrid('sleep', rest, adb);
        return ok(`Sent sleep (via ${path}).`);
      } catch (e) {
        return err(withHints(`sleep failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  server.tool(
    'set_volume',
    'Set media volume (stream 3) to a level between 0 and 25 (requires ADB).',
    { level: z.number().int().min(0).max(25) },
    async ({ level }) => {
      try {
        await adb.shell(`media volume --set ${level} --stream 3`);
        return ok(`Set media volume to ${level}.`);
      } catch (e) {
        return err(withHints(`set_volume failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  server.tool('get_volume', 'Read current media volume (stream 3, requires ADB).', {}, async () => {
    try {
      const out = await adb.shell('media volume --get --stream 3');
      return ok(out);
    } catch (e) {
      return err(withHints(`get_volume failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  });

  server.tool(
    'seek',
    [
      'Seek forward or backward by seconds (positive = forward, negative = backward). Each press = 15s.',
      'Always resumes playback after seeking.',
      'Uses REST API media scan when configured, falls back to ADB keyevents.',
    ].join(' '),
    { seconds: z.number().int() },
    async ({ seconds }) => {
      try {
        const presses = Math.max(1, Math.round(Math.abs(seconds) / 15));
        const keyName = seconds >= 0 ? 'fast_forward' : 'rewind';
        await adb.keyevent('KEYCODE_MEDIA_PAUSE');
        for (let i = 0; i < presses; i++) {
          await pressKeyHybrid(keyName, rest, adb);
        }
        await adb.keyevent('KEYCODE_MEDIA_PLAY');
        const direction = seconds >= 0 ? 'forward' : 'backward';
        return ok(
          `Seeked ${direction} ~${presses * 15}s (${presses} presses) and resumed playback.`,
        );
      } catch (e) {
        return err(withHints(`seek failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  server.tool(
    'mute',
    'Toggle mute. Uses REST API when configured, falls back to ADB.',
    {},
    async () => {
      try {
        const path = await pressKeyHybrid('mute', rest, adb);
        return ok(`Sent mute (via ${path}).`);
      } catch (e) {
        return err(withHints(`mute failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  server.tool(
    'get_screen_content',
    'Dump Android UI hierarchy and return flattened JSON nodes (requires ADB).',
    {},
    async () => {
      try {
        const nodes = await getScreenNodes(adb);
        const formatted = nodes.map((node) => ({
          text: node.text ?? '',
          contentDesc: node['content-desc'] ?? '',
          resourceId: node['resource-id'] ?? '',
          className: node.class ?? '',
          bounds: node.bounds ?? '',
          clickable: node.clickable === 'true',
        }));
        return ok(JSON.stringify(formatted, null, 2));
      } catch (e) {
        return err(
          withHints(`get_screen_content failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    },
  );

  server.tool(
    'click_node',
    'Find a node by text/content description and tap its center coordinates (requires ADB).',
    {
      query: z.string().min(1),
      field: z.enum(['text', 'content-desc', 'either']).optional(),
      exact: z.boolean().optional(),
    },
    async ({ query, field, exact }) => {
      try {
        const nodes = await getScreenNodes(adb);
        const mode = field ?? 'either';
        const queryNormalized = query.toLowerCase();

        const match = nodes.find((node) => {
          const values = [
            mode === 'text' ? (node.text ?? '') : '',
            mode === 'content-desc' ? (node['content-desc'] ?? '') : '',
            mode === 'either' ? (node.text ?? '') : '',
            mode === 'either' ? (node['content-desc'] ?? '') : '',
          ]
            .filter(Boolean)
            .map((v) => v.toLowerCase());

          if (values.length === 0) return false;
          if (exact) return values.includes(queryNormalized);
          return values.some((v) => v.includes(queryNormalized));
        });

        if (!match?.bounds) {
          return err(`No matching node found for query: ${query}`);
        }

        const { x, y } = parseBounds(match.bounds);
        await adb.tap(x, y);
        return ok(`Tapped node at (${Math.round(x)}, ${Math.round(y)}) for query: ${query}`);
      } catch (e) {
        return err(withHints(`click_node failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );
}
