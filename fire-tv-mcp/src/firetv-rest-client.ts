import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Agent } from 'undici';
import { createLogger } from './logger.js';

// Reuse a single undici agent that bypasses self-signed TLS for the Fire TV.
// The connection is LAN-only — there is no external exposure.
const tlsAgent = new Agent({ connect: { rejectUnauthorized: false } });

/** Map friendly key names to Fire TV REST API action strings. */
const REST_KEY_MAP: Record<string, string> = {
  up: 'dpad_up',
  down: 'dpad_down',
  left: 'dpad_left',
  right: 'dpad_right',
  select: 'select',
  enter: 'select',
  back: 'back',
  home: 'home',
  menu: 'menu',
  sleep: 'sleep',
};

/** Map friendly media key names to REST /v1/media action + optional body. */
const REST_MEDIA_MAP: Record<string, { action: string; body?: object }> = {
  play: { action: 'play' },
  pause: { action: 'play' },
  play_pause: { action: 'play' },
  fast_forward: {
    action: 'scan',
    body: { direction: 'forward', keyAction: { keyActionType: 'keyDown' } },
  },
  rewind: {
    action: 'scan',
    body: { direction: 'back', keyAction: { keyActionType: 'keyDown' } },
  },
};

/** Returns the REST API action for a key, or null if the key needs ADB. */
export function toRestKey(
  key: string,
): { type: 'nav'; action: string } | { type: 'media'; action: string; body?: object } | null {
  const normalized = key.toLowerCase();
  const nav = REST_KEY_MAP[normalized];
  if (nav) return { type: 'nav', action: nav };
  const media = REST_MEDIA_MAP[normalized];
  if (media) return { type: 'media', action: media.action, body: media.body };
  return null;
}

export interface FireTvRestConfig {
  ip: string;
  port: number;
  apiKey: string;
  token?: string;
  envPath?: string;
}

/**
 * Client for the Fire TV companion REST API on port 8080.
 *
 * This is an undocumented Amazon API discovered by the Unfolded Circle team
 * (https://github.com/mase1981/uc-intg-firetv). It provides ~50ms latency
 * for navigation and launch commands without requiring the adb binary.
 *
 * Does NOT support: screenshot, UI tree dump, click_node — those require ADB.
 *
 * Pairing flow:
 *   1. Call displayPin()  → TV shows a 4-digit PIN
 *   2. Call verifyPin(pin) → receives and persists auth token
 *   All subsequent calls use the saved token automatically.
 *
 * Required env vars:
 *   FIRETV_REST_TOKEN     — auto-populated after first successful verifyPin()
 *
 * Optional env vars:
 *   FIRETV_REST_API_KEY   — client identifier sent as X-Api-Key; defaults to 'fire-tv-mcp'.
 *                           The TV accepts any non-empty string during pairing.
 *
 * Service lifecycle: the REST service (port 8080) shuts down after a few minutes of inactivity.
 * Every request automatically wakes it via DIAL (port 8009 → POST /apps/FireTVRemote) when
 * the idle threshold is exceeded, then waits 1.5s for startup before proceeding.
 *
 * Optional:
 *   FIRETV_REST_PORT      — default 8080
 */
// The REST service shuts down after a few minutes of inactivity. Re-wake if
// we haven't made a successful call within this window.
const REST_IDLE_WAKE_THRESHOLD_MS = 60 * 1000;

export class FireTvRestClient {
  private readonly logger = createLogger('fire-tv-mcp/rest');
  private ip: string;
  private readonly port: number;
  private apiKey: string;
  private token: string | undefined;
  private readonly envPath: string;
  private lastSuccessfulCallTime = 0;

  constructor(config: FireTvRestConfig) {
    this.ip = config.ip;
    this.port = config.port;
    this.apiKey = config.apiKey;
    this.token = config.token;
    this.envPath =
      config.envPath ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  }

  /** True only when both configured (IP set) and authenticated (token present). */
  get ready(): boolean {
    return !!(this.ip && this.token);
  }

  /** True when IP and API key are present (but token may not be set yet). */
  get configured(): boolean {
    return !!(this.ip && this.apiKey);
  }

  /** Update target IP at runtime (useful after discover auto-select). */
  setTargetIp(ip: string): void {
    const next = ip.trim();
    if (!next || next === this.ip) return;
    this.ip = next;
    this.logger.info(`REST target IP set to ${next}`);
  }

  /** Set API key at runtime if not provided from env. */
  setApiKey(apiKey: string): void {
    const next = apiKey.trim();
    if (!next || next === this.apiKey) return;
    this.apiKey = next;
    this.logger.info('REST API key initialized for this session.');
  }

  private get baseUrl(): string {
    return `https://${this.ip}:${this.port}`;
  }

  private buildHeaders(includeToken = true): Record<string, string> {
    const h: Record<string, string> = {
      'X-Api-Key': this.apiKey,
      'user-agent': 'okhttp/4.10.0',
      'Content-Type': 'application/json',
    };
    if (includeToken && this.token) {
      h['X-Client-Token'] = this.token;
    }
    return h;
  }

  private async request(
    url: string,
    opts: { body?: string; headers?: Record<string, string> } = {},
  ): Promise<void> {
    await this.ensureAwake();
    const res = await fetch(url, {
      method: 'POST',
      headers: opts.headers ?? this.buildHeaders(),
      body: opts.body,
      // @ts-expect-error undici dispatcher is not in the built-in fetch types
      dispatcher: tlsAgent,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Fire TV REST ${res.status} for ${url}: ${body || '(empty)'}`);
    }
    this.lastSuccessfulCallTime = Date.now();
  }

  /**
   * Ensure the Fire TV REST service is running before making a request.
   *
   * The service (port 8080) shuts down after a few minutes of inactivity and
   * must be restarted via DIAL (port 8009 → POST /apps/FireTVRemote).
   * This is called before every REST request but only incurs the 1.5s startup
   * wait when the service has been idle long enough to have gone to sleep.
   */
  private async ensureAwake(): Promise<void> {
    const idleMs = Date.now() - this.lastSuccessfulCallTime;
    if (idleMs <= REST_IDLE_WAKE_THRESHOLD_MS) return;

    const dialUrl = `http://${this.ip}:8009/apps/FireTVRemote`;
    try {
      await fetch(dialUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
        signal: AbortSignal.timeout(5000),
      });
      this.logger.info('DIAL wake sent to FireTVRemote — waiting for REST service to start.');
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      this.logger.warn(`DIAL wake failed (service may already be running): ${String(err)}`);
    }
  }

  /**
   * Step 1 of pairing: tell the TV to display a 4-digit PIN.
   * The PIN expires after ~60 seconds.
   */
  async displayPin(friendlyName = 'fire-tv-mcp'): Promise<void> {
    await this.ensureAwake();
    await this.request(`${this.baseUrl}/v1/FireTV/pin/display`, {
      headers: this.buildHeaders(false),
      body: JSON.stringify({ friendlyName }),
    });
    this.logger.info('PIN display requested — check TV screen.');
  }

  /**
   * Step 2 of pairing: submit the PIN shown on TV.
   * Saves the received token to .env for future sessions.
   *
   * @returns The auth token.
   */
  async verifyPin(pin: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/FireTV/pin/verify`, {
      method: 'POST',
      headers: this.buildHeaders(false),
      body: JSON.stringify({ pin }),
      // @ts-expect-error undici dispatcher
      dispatcher: tlsAgent,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`PIN verify failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as { description?: string };
    const token = data.description;
    if (!token) {
      throw new Error('PIN verify response did not contain a token (expected {"description":"..."})');
    }
    this.token = token;
    this.persistToken(token);
    this.lastSuccessfulCallTime = Date.now();
    this.logger.info('REST auth token saved.');
    return token;
  }

  /**
   * Send a navigation key (dpad_up, home, back, select, etc.).
   */
  async sendNavKey(action: string): Promise<void> {
    await this.request(`${this.baseUrl}/v1/FireTV?action=${encodeURIComponent(action)}`);
    this.logger.debug(`REST nav key: ${action}`);
  }

  /**
   * Send a media command (play, scan with direction).
   */
  async sendMediaCommand(action: string, body?: object): Promise<void> {
    await this.request(`${this.baseUrl}/v1/media?action=${encodeURIComponent(action)}`, {
      body: body ? JSON.stringify(body) : undefined,
    });
    this.logger.debug(`REST media: ${action}`);
  }

  /**
   * Launch an app by package name.
   * e.g. 'com.google.android.youtube.tv' for YouTube TV.
   */
  async launchApp(packageName: string): Promise<void> {
    await this.request(`${this.baseUrl}/v1/FireTV/app/${encodeURIComponent(packageName)}`);
    this.logger.info(`REST: launched ${packageName}`);
  }

  /** Persist the auth token to .env for future sessions. */
  private persistToken(token: string): void {
    try {
      let content = '';
      try {
        content = readFileSync(this.envPath, 'utf-8');
      } catch {
        // .env doesn't exist yet
      }
      if (content.includes('FIRETV_REST_TOKEN=')) {
        content = content.replace(/FIRETV_REST_TOKEN=.*/, `FIRETV_REST_TOKEN=${token}`);
      } else {
        content += `\nFIRETV_REST_TOKEN=${token}\n`;
      }
      writeFileSync(this.envPath, content);
    } catch (err) {
      this.logger.warn(`Could not persist REST token to .env: ${String(err)}`);
    }
  }
}
