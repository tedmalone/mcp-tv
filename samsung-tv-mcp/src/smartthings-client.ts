import { createLogger } from './logger.js';

/**
 * Minimal SmartThings Cloud API client.
 *
 * Required env vars:
 *   SAMSUNG_SMARTTHINGS_TOKEN      — personal access token (valid 24h; regenerate at account.smartthings.com/tokens)
 *   SAMSUNG_SMARTTHINGS_DEVICE_ID  — device UUID (find via GET /v1/devices)
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

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(`SmartThings GET error ${res.status} for ${path}`);
    }
    return res.json();
  }

  /** Power the TV on via SmartThings. */
  async powerOn(): Promise<void> {
    await this.sendCommand([{ component: 'main', capability: 'switch', command: 'on' }]);
    this.logger.info('SmartThings: power on sent.');
  }

  /**
   * Switch to an input source directly.
   * Pass the exact input ID from list_inputs (e.g. "HDMI2", "dtv").
   */
  async setInputSource(source: string): Promise<void> {
    await this.sendCommand([
      {
        component: 'main',
        capability: 'samsungvd.mediaInputSource',
        command: 'setInputSource',
        arguments: [source],
      },
    ]);
    this.logger.info(`SmartThings: input switched to ${source}.`);
  }

  /**
   * List available input sources from the TV.
   * Uses samsungvd.mediaInputSource — the standard mediaInputSource returns
   * empty values on Tizen TVs.
   */
  async getSupportedInputSources(): Promise<{ id: string; name: string }[]> {
    const data = (await this.get(
      `/devices/${this.deviceId}/components/main/capabilities/samsungvd.mediaInputSource/status`,
    )) as { supportedInputSourcesMap?: { value?: { id: string; name: string }[] } };
    return data.supportedInputSourcesMap?.value ?? [];
  }

  /** Get the current active input source ID. */
  async getCurrentInputSource(): Promise<string | null> {
    const data = (await this.get(
      `/devices/${this.deviceId}/components/main/capabilities/samsungvd.mediaInputSource/status`,
    )) as { inputSource?: { value?: string } };
    return data.inputSource?.value ?? null;
  }
}
