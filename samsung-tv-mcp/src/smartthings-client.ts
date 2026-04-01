import { createLogger } from './logger.js';

const INPUT_SOURCE_MAP: Record<string, string> = {
  hdmi1: 'HDMI1',
  hdmi2: 'HDMI2',
  hdmi3: 'HDMI3',
  hdmi4: 'HDMI4',
  hdmi: 'HDMI1',
  dtv: 'digitalTv',
  tv: 'digitalTv',
  component1: 'Component',
  component2: 'Component2',
  av1: 'AV',
  av2: 'AV2',
};

/** Map a tool input name (hdmi2, dtv, etc.) to a SmartThings setInputSource argument. */
export function toSmartThingsInput(input: string): string | null {
  return INPUT_SOURCE_MAP[input.toLowerCase()] ?? null;
}

/**
 * Minimal SmartThings Cloud API client.
 *
 * Required env vars:
 *   SAMSUNG_SMARTTHINGS_TOKEN  — personal access token from https://account.smartthings.com/tokens
 *   SAMSUNG_SMARTTHINGS_DEVICE_ID — device UUID (find via GET /v1/devices)
 *
 * Optional:
 *   SAMSUNG_SMARTTHINGS_API_URL — override base URL (default: https://api.smartthings.com/v1)
 */
export class SmartThingsClient {
  private readonly baseUrl: string;
  private readonly logger = createLogger('samsung-tv-mcp/smartthings');

  constructor(
    private readonly token: string,
    private readonly deviceId: string,
    baseUrl = 'https://api.smartthings.com/v1',
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /** Returns true if both token and deviceId are present. */
  get configured(): boolean {
    return !!(this.token && this.deviceId);
  }

  private async sendCommand(commands: object[]): Promise<void> {
    const url = `${this.baseUrl}/devices/${this.deviceId}/commands`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ commands }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `SmartThings API error ${res.status} for device ${this.deviceId}: ${body || '(empty body)'}`,
      );
    }
    this.logger.debug(`SmartThings command OK: ${JSON.stringify(commands)}`);
  }

  /** Power the TV on via SmartThings. */
  async powerOn(): Promise<void> {
    await this.sendCommand([{ component: 'main', capability: 'switch', command: 'on' }]);
    this.logger.info('SmartThings: power on sent.');
  }

  /** Power the TV off via SmartThings. */
  async powerOff(): Promise<void> {
    await this.sendCommand([{ component: 'main', capability: 'switch', command: 'off' }]);
    this.logger.info('SmartThings: power off sent.');
  }

  /**
   * Switch to an input source directly.
   *
   * @param source SmartThings input source value (e.g. "HDMI2", "digitalTv").
   *               Use toSmartThingsInput() to convert tool input names.
   */
  async setInputSource(source: string): Promise<void> {
    await this.sendCommand([
      {
        component: 'main',
        capability: 'mediaInputSource',
        command: 'setInputSource',
        arguments: [source],
      },
    ]);
    this.logger.info(`SmartThings: input switched to ${source}.`);
  }

  /**
   * List available input sources from the TV via SmartThings.
   * Useful for discovering the exact source names your TV supports.
   */
  async getSupportedInputSources(): Promise<string[]> {
    const url = `${this.baseUrl}/devices/${this.deviceId}/components/main/capabilities/mediaInputSource/status`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(`SmartThings status error ${res.status}`);
    }
    const data = (await res.json()) as {
      supportedInputSources?: { value?: string[] };
    };
    return data.supportedInputSources?.value ?? [];
  }
}
