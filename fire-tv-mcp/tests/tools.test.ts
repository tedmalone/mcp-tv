import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AdbClient } from '../src/adb-client.js';
import { registerTools } from '../src/tools.js';

// ---------------------------------------------------------------------------
// Minimal mock server — captures registered tool handlers by name
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function createMockServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn((name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    }),
  };
  return { server: server as unknown as Parameters<typeof registerTools>[0], handlers };
}

// ---------------------------------------------------------------------------
// Minimal mock AdbClient
// ---------------------------------------------------------------------------

function createMockClient() {
  const shellCalls: string[] = [];
  const keyeventCalls: string[] = [];

  const client = {
    shell: vi.fn(async (cmd: string) => {
      shellCalls.push(cmd);
      return '';
    }),
    keyevent: vi.fn(async (key: string) => {
      keyeventCalls.push(key);
    }),
    tap: vi.fn(async () => {}),
    screenshotBase64: vi.fn(async () => 'base64data'),
    getScreenXml: vi.fn(async () => ''),
    listDevices: vi.fn(async () => []),
    listMdnsServices: vi.fn(async () => []),
    ensureConnected: vi.fn(async () => {}),
    configuredSerial: '192.168.1.100:5555',
  } as unknown as AdbClient;

  return { client, shellCalls, keyeventCalls };
}

// ---------------------------------------------------------------------------
// type_text — encodeInputText (security-critical escaping)
// ---------------------------------------------------------------------------

describe('type_text — shell escaping', () => {
  let handlers: Map<string, ToolHandler>;
  let shellCalls: string[];

  beforeEach(() => {
    const mock = createMockServer();
    const clientMock = createMockClient();
    handlers = mock.handlers;
    shellCalls = clientMock.shellCalls;
    registerTools(mock.server, clientMock.client);
  });

  async function typeText(text: string): Promise<string> {
    const handler = handlers.get('type_text')!;
    await handler({ text });
    return shellCalls.at(-1) ?? '';
  }

  it('encodes spaces as %s', async () => {
    const cmd = await typeText('hello world');
    expect(cmd).toBe('input text "hello%sworld"');
  });

  it('escapes double quotes', async () => {
    const cmd = await typeText('say"hi"');
    expect(cmd).toBe('input text "say\\"hi\\""');
  });

  it('escapes dollar signs', async () => {
    const cmd = await typeText('cost $100');
    expect(cmd).toBe('input text "cost%s\\$100"');
  });

  it('escapes backticks', async () => {
    const cmd = await typeText('press `back`');
    expect(cmd).toBe('input text "press%s\\`back\\`"');
  });

  it('escapes backslashes (first, before other replacements)', async () => {
    const cmd = await typeText('C:\\path');
    expect(cmd).toBe('input text "C:\\\\path"');
  });

  it('handles plain text with no special chars', async () => {
    const cmd = await typeText('Netflix');
    expect(cmd).toBe('input text "Netflix"');
  });

  it('handles empty string', async () => {
    const cmd = await typeText('');
    expect(cmd).toBe('input text ""');
  });
});

// ---------------------------------------------------------------------------
// press_key — normalizeKey
// ---------------------------------------------------------------------------

describe('press_key — key normalization', () => {
  let handlers: Map<string, ToolHandler>;
  let keyeventCalls: string[];

  beforeEach(() => {
    const mock = createMockServer();
    const clientMock = createMockClient();
    handlers = mock.handlers;
    keyeventCalls = clientMock.keyeventCalls;
    registerTools(mock.server, clientMock.client);
  });

  const friendlyKeyMap: Record<string, string> = {
    up: 'KEYCODE_DPAD_UP',
    down: 'KEYCODE_DPAD_DOWN',
    left: 'KEYCODE_DPAD_LEFT',
    right: 'KEYCODE_DPAD_RIGHT',
    select: 'KEYCODE_DPAD_CENTER',
    enter: 'KEYCODE_ENTER',
    back: 'KEYCODE_BACK',
    home: 'KEYCODE_HOME',
    menu: 'KEYCODE_MENU',
    play_pause: 'KEYCODE_MEDIA_PLAY_PAUSE',
  };

  for (const [friendly, keycode] of Object.entries(friendlyKeyMap)) {
    it(`maps "${friendly}" → "${keycode}"`, async () => {
      const handler = handlers.get('press_key')!;
      await handler({ key: friendly });
      expect(keyeventCalls.at(-1)).toBe(keycode);
    });
  }

  it('passes unknown key through unchanged', async () => {
    const handler = handlers.get('press_key')!;
    await handler({ key: 'KEYCODE_CUSTOM_KEY' });
    expect(keyeventCalls.at(-1)).toBe('KEYCODE_CUSTOM_KEY');
  });

  it('normalizes key to lowercase before lookup', async () => {
    const handler = handlers.get('press_key')!;
    await handler({ key: 'UP' });
    expect(keyeventCalls.at(-1)).toBe('KEYCODE_DPAD_UP');
  });
});

// ---------------------------------------------------------------------------
// click_node — parseBounds (tested indirectly via click_node tool)
// ---------------------------------------------------------------------------

describe('click_node — bounds parsing', () => {
  let handlers: Map<string, ToolHandler>;
  let client: ReturnType<typeof createMockClient>['client'];

  const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="Settings" content-desc="Settings button" resource-id="" class="android.widget.TextView" bounds="[100,200][300,400]" clickable="true" />
</hierarchy>`;

  beforeEach(() => {
    const mock = createMockServer();
    const clientMock = createMockClient();
    handlers = mock.handlers;
    client = clientMock.client;
    vi.mocked(client.getScreenXml).mockResolvedValue(sampleXml);
    registerTools(mock.server, clientMock.client);
  });

  it('taps the center of a node matched by text', async () => {
    const handler = handlers.get('click_node')!;
    const result = await handler({ query: 'Settings' });
    expect(result.isError).toBeFalsy();
    // bounds [100,200][300,400] → center (200, 300)
    expect(vi.mocked(client.tap)).toHaveBeenCalledWith(200, 300);
  });

  it('returns error when no node matches', async () => {
    const handler = handlers.get('click_node')!;
    const result = await handler({ query: 'NonExistentButton' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No matching node');
  });

  it("matches by content-desc when field is 'content-desc'", async () => {
    const handler = handlers.get('click_node')!;
    const result = await handler({ query: 'Settings button', field: 'content-desc' });
    expect(result.isError).toBeFalsy();
  });
});
