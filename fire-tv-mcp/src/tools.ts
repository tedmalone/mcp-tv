import { z } from 'zod';
import { XMLParser } from 'fast-xml-parser';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AdbClient } from './adb-client.js';

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

// Upper bound for press_keys delay to avoid accidental very slow macro execution.
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
  // Escape characters that are special inside a double-quoted Android shell string,
  // then encode spaces as %s which is what `input text` expects.
  return text
    .replace(/\\/g, '\\\\') // backslash must come first
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

export function registerTools(server: McpServer, client: AdbClient): void {
  server.tool(
    'discover',
    'Discover Fire TV / Android TV devices using adb mDNS and attached device list.',
    {},
    async () => {
      try {
        const mdns = await client.listMdnsServices().catch(() => []);

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
          await client.runAdb(['connect', serial]).catch(() => undefined);
        }

        const devices = await client.listDevices().catch(() => []);

        const fireMdns = mdns.filter(isLikelyFireTvMdns);
        const fireDevices = devices.filter(isLikelyFireTvDevice);
        const nonFireDevices = devices.filter((device) => !isLikelyFireTvDevice(device));

        let autoSelectedSerial: string | null = null;
        if (!client.configuredSerial) {
          const readyDevice = fireDevices.find((device) => device.state === 'device');
          if (readyDevice) {
            client.setActiveSerial(readyDevice.serial);
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
          raw: {
            serviceType: service.serviceType,
            port: service.port,
            line: service.raw,
          },
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

  server.tool(
    'press_key',
    'Press a single Fire TV key (friendly names like up/down/home/back or raw KEYCODE_*).',
    { key: z.string().min(1) },
    async ({ key }) => {
      try {
        await client.keyevent(normalizeKey(key));
        return ok(`Pressed key: ${key}`);
      } catch (e) {
        return err(withHints(`press_key failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  server.tool(
    'press_keys',
    'Press multiple keys in sequence with an optional delay.',
    {
      keys: z.array(z.string().min(1)).min(1),
      delayMs: z.number().int().min(0).max(PRESS_KEYS_DELAY_MAX_MS).optional(),
    },
    async ({ keys, delayMs }) => {
      try {
        for (const key of keys) {
          await client.keyevent(normalizeKey(key));
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

  server.tool('go_home', 'Go to the Fire TV home screen.', {}, async () => {
    try {
      await client.keyevent('KEYCODE_HOME');
      return ok('Sent KEYCODE_HOME.');
    } catch (e) {
      return err(withHints(`go_home failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  });

  server.tool('go_back', 'Go back on the Fire TV.', {}, async () => {
    try {
      await client.keyevent('KEYCODE_BACK');
      return ok('Sent KEYCODE_BACK.');
    } catch (e) {
      return err(withHints(`go_back failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  });

  server.tool(
    'type_text',
    'Type text into the currently focused input.',
    { text: z.string() },
    async ({ text }) => {
      try {
        await client.shell(`input text "${encodeInputText(text)}"`);
        return ok('Typed text.');
      } catch (e) {
        return err(withHints(`type_text failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  server.tool(
    'launch_app',
    'Launch app by package name (or full component for am start).',
    { package: z.string().min(1) },
    async ({ package: pkg }) => {
      try {
        await client.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
        return ok(`Launch command sent for package: ${pkg}`);
      } catch (e) {
        return err(withHints(`launch_app failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  server.tool('list_apps', 'List installed third-party apps.', {}, async () => {
    try {
      const out = await client.shell('pm list packages -3');
      return ok(out);
    } catch (e) {
      return err(withHints(`list_apps failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  });

  server.tool('get_current_app', 'Get current foreground activity/app.', {}, async () => {
    try {
      const out = await client.shell('dumpsys activity activities | grep mResumedActivity');
      return ok(out);
    } catch (e) {
      return err(
        withHints(`get_current_app failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  });

  server.tool(
    'deep_link',
    'Open a deep link URI on the Fire TV.',
    { uri: z.string().url() },
    async ({ uri }) => {
      try {
        await client.shell(`am start -a android.intent.action.VIEW -d "${uri}"`);
        return ok(`Opened URI: ${uri}`);
      } catch (e) {
        return err(withHints(`deep_link failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  server.tool('screenshot', 'Capture a screenshot and return base64 PNG.', {}, async () => {
    try {
      const pngBase64 = await client.screenshotBase64();
      return ok(pngBase64);
    } catch (e) {
      return err(withHints(`screenshot failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  });

  server.tool('list_devices', 'List ADB devices currently visible to host.', {}, async () => {
    try {
      const devices = await client.listDevices();
      return ok(JSON.stringify(devices, null, 2));
    } catch (e) {
      return err(withHints(`list_devices failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  });

  server.tool('get_device_info', 'Get basic Fire TV properties via getprop.', {}, async () => {
    try {
      const [model, release, sdk, serial] = await Promise.all([
        client.shell('getprop ro.product.model'),
        client.shell('getprop ro.build.version.release'),
        client.shell('getprop ro.build.version.sdk'),
        client.shell('getprop ro.serialno'),
      ]);
      return ok(
        JSON.stringify(
          {
            model,
            androidVersion: release,
            sdk,
            serial,
          },
          null,
          2,
        ),
      );
    } catch (e) {
      return err(
        withHints(`get_device_info failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  });

  server.tool('sleep', 'Put Fire TV to sleep.', {}, async () => {
    try {
      await client.keyevent('KEYCODE_SLEEP');
      return ok('Sent KEYCODE_SLEEP.');
    } catch (e) {
      return err(withHints(`sleep failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  });

  server.tool(
    'set_volume',
    'Set media volume (stream 3) to a level between 0 and 25.',
    { level: z.number().int().min(0).max(25) },
    async ({ level }) => {
      try {
        await client.shell(`media volume --set ${level} --stream 3`);
        return ok(`Set media volume to ${level}.`);
      } catch (e) {
        return err(withHints(`set_volume failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  server.tool('get_volume', 'Read current media volume (stream 3).', {}, async () => {
    try {
      const out = await client.shell('media volume --get --stream 3');
      return ok(out);
    } catch (e) {
      return err(withHints(`get_volume failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  });

  server.tool(
    'seek',
    'Seek forward or backward by seconds (positive = forward, negative = backward). Each press = 15s. Always resumes playback after seeking.',
    { seconds: z.number().int() },
    async ({ seconds }) => {
      try {
        const presses = Math.max(1, Math.round(Math.abs(seconds) / 15));
        const key = seconds >= 0 ? 'KEYCODE_MEDIA_FAST_FORWARD' : 'KEYCODE_MEDIA_REWIND';
        await client.keyevent('KEYCODE_MEDIA_PAUSE');
        for (let i = 0; i < presses; i++) {
          await client.keyevent(key);
        }
        await client.keyevent('KEYCODE_MEDIA_PLAY');
        const direction = seconds >= 0 ? 'forward' : 'backward';
        return ok(`Seeked ${direction} ~${presses * 15}s (${presses} presses) and resumed playback.`);
      } catch (e) {
        return err(withHints(`seek failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );

  server.tool('mute', 'Toggle mute.', {}, async () => {
    try {
      await client.keyevent('KEYCODE_MUTE');
      return ok('Sent KEYCODE_MUTE.');
    } catch (e) {
      return err(withHints(`mute failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  });

  server.tool(
    'get_screen_content',
    'Dump Android UI hierarchy and return flattened JSON nodes.',
    {},
    async () => {
      try {
        const nodes = await getScreenNodes(client);
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
    'Find a node by text/content description and tap its center coordinates.',
    {
      query: z.string().min(1),
      field: z.enum(['text', 'content-desc', 'either']).optional(),
      exact: z.boolean().optional(),
    },
    async ({ query, field, exact }) => {
      try {
        const nodes = await getScreenNodes(client);
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
        await client.tap(x, y);
        return ok(`Tapped node at (${Math.round(x)}, ${Math.round(y)}) for query: ${query}`);
      } catch (e) {
        return err(withHints(`click_node failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  );
}
