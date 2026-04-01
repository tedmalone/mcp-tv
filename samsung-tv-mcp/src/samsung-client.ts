import WebSocket from 'ws';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';

export interface SamsungTvConfig {
  ip?: string;
  mac?: string;
  name: string;
  token?: string;
}

interface SamsungKeyPayload {
  method: 'ms.remote.control';
  params: {
    Cmd: 'Click';
    DataOfCmd: string;
    Option: 'false';
    TypeOfRemote: 'SendRemoteKey';
  };
}

interface SamsungWsMessage {
  event?: string;
  data?: {
    token?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SamsungRestDevice {
  name?: string;
  friendlyName?: string;
  modelName?: string;
  model?: string;
  wifiMac?: string;
  mac?: string;
  [key: string]: unknown;
}

export interface SamsungRestResponse {
  device?: SamsungRestDevice;
  [key: string]: unknown;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// Default WS port exposed by Samsung TVs for remote control API.
const DEFAULT_WS_PORT = 8002;
// Default REST API port exposed by Samsung TVs for device metadata.
const DEFAULT_REST_PORT = 8001;
// 5s gives LAN devices time to wake from light sleep without delaying tool UX too much.
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
// 150ms avoids dropped or merged key presses on many Samsung models.
const DEFAULT_COMMAND_SETTLE_MS = 150;
// Short retry loop for transient Wi-Fi jitter or TV wake-up race.
const DEFAULT_CONNECT_RETRIES = 3;
// Linear backoff base for connect retries.
const DEFAULT_CONNECT_RETRY_BASE_DELAY_MS = 500;
// REST device-info requests should fail fast to keep discovery responsive.
const DEFAULT_DEVICE_INFO_TIMEOUT_MS = 3000;
const DEFAULT_DEVICE_INFO_RETRIES = 2;
const DEFAULT_DEVICE_INFO_RETRY_DELAY_MS = 400;

const WS_PORT = envInt('SAMSUNG_TV_WS_PORT', DEFAULT_WS_PORT);
const REST_PORT = envInt('SAMSUNG_TV_REST_PORT', DEFAULT_REST_PORT);
const CONNECT_TIMEOUT_MS = envInt('SAMSUNG_TV_CONNECT_TIMEOUT_MS', DEFAULT_CONNECT_TIMEOUT_MS);
const COMMAND_SETTLE_MS = envInt('SAMSUNG_TV_COMMAND_SETTLE_MS', DEFAULT_COMMAND_SETTLE_MS);
const CONNECT_RETRIES = envInt('SAMSUNG_TV_CONNECT_RETRIES', DEFAULT_CONNECT_RETRIES);
const CONNECT_RETRY_BASE_DELAY_MS = envInt(
  'SAMSUNG_TV_CONNECT_RETRY_BASE_DELAY_MS',
  DEFAULT_CONNECT_RETRY_BASE_DELAY_MS,
);
const DEVICE_INFO_TIMEOUT_MS = envInt(
  'SAMSUNG_TV_DEVICE_INFO_TIMEOUT_MS',
  DEFAULT_DEVICE_INFO_TIMEOUT_MS,
);
const DEVICE_INFO_RETRIES = envInt('SAMSUNG_TV_DEVICE_INFO_RETRIES', DEFAULT_DEVICE_INFO_RETRIES);
const DEVICE_INFO_RETRY_DELAY_MS = envInt(
  'SAMSUNG_TV_DEVICE_INFO_RETRY_DELAY_MS',
  DEFAULT_DEVICE_INFO_RETRY_DELAY_MS,
);

export class SamsungTvClient {
  private ws: WebSocket | null = null;
  private config: SamsungTvConfig;
  private envPath: string;
  private readonly logger = createLogger('samsung-tv-mcp/client');

  constructor(config: SamsungTvConfig, envPath?: string) {
    this.config = config;
    this.envPath = envPath ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  }

  get ip(): string | undefined {
    return this.config.ip;
  }

  get mac(): string | undefined {
    return this.config.mac;
  }

  /** Persist discovered IP and MAC to .env so they survive restarts */
  persistDiscovery(ip: string, mac: string): void {
    try {
      let envContent = '';
      try {
        envContent = readFileSync(this.envPath, 'utf-8');
      } catch {
        // .env doesn't exist yet — that's fine
      }

      if (envContent.includes('SAMSUNG_TV_IP=')) {
        envContent = envContent.replace(/SAMSUNG_TV_IP=.*/, `SAMSUNG_TV_IP=${ip}`);
      } else {
        envContent += `\nSAMSUNG_TV_IP=${ip}\n`;
      }

      if (envContent.includes('SAMSUNG_TV_MAC=')) {
        envContent = envContent.replace(/SAMSUNG_TV_MAC=.*/, `SAMSUNG_TV_MAC=${mac}`);
      } else {
        envContent += `SAMSUNG_TV_MAC=${mac}\n`;
      }

      writeFileSync(this.envPath, envContent);
      this.config.ip = ip;
      this.config.mac = mac;
      this.logger.info(`Persisted TV IP (${ip}) and MAC (${mac}) to .env.`);
    } catch (err) {
      this.logger.warn(`Could not persist discovery to .env: ${String(err)}`);
    }
  }

  /** Build the Samsung WebSocket URL with optional auth token */
  private buildUrl(): string {
    if (!this.config.ip) {
      throw new Error('SAMSUNG_TV_IP is not configured.');
    }
    const encodedName = Buffer.from(this.config.name).toString('base64');
    let url = `wss://${this.config.ip}:${WS_PORT}/api/v2/channels/samsung.remote.control?name=${encodedName}`;
    if (this.config.token) {
      url += `&token=${this.config.token}`;
    }
    return url;
  }

  /** Connect to the TV's WebSocket API */
  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return; // already connected
    }

    let lastError: unknown;
    const attempts = CONNECT_RETRIES;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const url = this.buildUrl();
        await this.connectOnce(url);
        if (attempt > 1) {
          this.logger.info(`WebSocket reconnect succeeded on attempt ${attempt}.`);
        }
        return;
      } catch (err) {
        lastError = err;
        this.logger.warn(`WebSocket connect attempt ${attempt}/${attempts} failed.`);
        if (attempt < attempts) {
          await new Promise((resolve) =>
            setTimeout(resolve, attempt * CONNECT_RETRY_BASE_DELAY_MS),
          );
        }
      }
    }

    throw new Error(
      `Could not connect to Samsung TV at ${this.config.ip}. ` +
        `Check TV power/network and ensure remote-control permission is allowed on TV. ` +
        `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  private asObject(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  }

  private async connectOnce(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(
          new Error(
            `Connection to Samsung TV at ${this.config.ip} timed out after ${CONNECT_TIMEOUT_MS}ms`,
          ),
        );
      }, CONNECT_TIMEOUT_MS);

      // Samsung TVs use self-signed TLS certificates that cannot be validated
      // against a public CA. Certificate pinning is impractical here because the
      // cert is unique per TV and rotates with firmware updates. This connection
      // runs on the local network only — there is no external exposure.
      const ws = new WebSocket(url, { rejectUnauthorized: false });

      ws.on('open', () => {
        // TV sends a welcome message with connection data (and possibly a token)
      });

      ws.on('message', (data) => {
        try {
          const parsed: unknown = JSON.parse(data.toString());
          const msg = this.asObject(parsed) as SamsungWsMessage | null;
          if (!msg) {
            this.logger.debug('Ignored WS payload that was not an object.');
            return;
          }
          // On first connection the TV returns a token we can reuse
          if (msg.data?.token && !this.config.token) {
            this.config.token = msg.data.token;
            this.persistToken(msg.data.token);
            this.logger.info('Auth token saved for future connections.');
          }
          if (msg.event === 'ms.channel.connect') {
            clearTimeout(timer);
            this.ws = ws;
            resolve();
            return;
          }
          if (msg.event) {
            this.logger.debug(`Unhandled WS event: ${msg.event}`);
          }
        } catch {
          this.logger.debug('Ignored non-JSON WebSocket message.');
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Samsung TV WebSocket error: ${err.message}`));
      });

      ws.on('close', () => {
        this.ws = null;
      });
    });
  }

  /** Disconnect from the TV */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Check if connected */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Send a single key press to the TV */
  async sendKey(keyCode: string): Promise<void> {
    await this.ensureConnected();

    const payload: SamsungKeyPayload = {
      method: 'ms.remote.control',
      params: {
        Cmd: 'Click',
        DataOfCmd: keyCode,
        Option: 'false',
        TypeOfRemote: 'SendRemoteKey',
      },
    };

    this.ws!.send(JSON.stringify(payload));

    // Brief settle time — TV needs a moment between rapid key presses
    await new Promise((r) => setTimeout(r, COMMAND_SETTLE_MS));
  }

  /** Send multiple key presses in sequence */
  async sendKeys(keyCodes: string[], delayMs = COMMAND_SETTLE_MS): Promise<void> {
    for (const key of keyCodes) {
      await this.sendKey(key);
      if (delayMs > COMMAND_SETTLE_MS) {
        await new Promise((r) => setTimeout(r, delayMs - COMMAND_SETTLE_MS));
      }
    }
  }

  /** Query TV info via REST API */
  async getDeviceInfo(): Promise<SamsungRestResponse> {
    if (!this.config.ip) {
      throw new Error('SAMSUNG_TV_IP is not configured.');
    }
    const url = `http://${this.config.ip}:${REST_PORT}/api/v2/`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= DEVICE_INFO_RETRIES; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(DEVICE_INFO_TIMEOUT_MS) });
        if (!res.ok) {
          throw new Error(`Samsung TV REST API returned ${res.status}`);
        }
        const parsed: unknown = await res.json();
        const obj = this.asObject(parsed);
        if (!obj) {
          throw new Error('Samsung TV REST API returned invalid JSON shape.');
        }
        return obj as SamsungRestResponse;
      } catch (err) {
        lastError = err;
        if (attempt < DEVICE_INFO_RETRIES) {
          this.logger.warn('Device info request failed, retrying once.');
          await new Promise((resolve) => setTimeout(resolve, DEVICE_INFO_RETRY_DELAY_MS));
        }
      }
    }
    throw new Error(
      `Failed to query Samsung device info at ${this.config.ip}. ` +
        `Ensure the TV is awake and reachable on LAN. ` +
        `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  /** Ensure we're connected, reconnecting if needed */
  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  /** Persist the auth token to .env so it survives restarts */
  private persistToken(token: string): void {
    try {
      let envContent = '';
      try {
        envContent = readFileSync(this.envPath, 'utf-8');
      } catch {
        // .env doesn't exist yet — that's fine
      }

      if (envContent.includes('SAMSUNG_TV_TOKEN=')) {
        envContent = envContent.replace(/SAMSUNG_TV_TOKEN=.*/, `SAMSUNG_TV_TOKEN=${token}`);
      } else {
        envContent += `\nSAMSUNG_TV_TOKEN=${token}\n`;
      }

      writeFileSync(this.envPath, envContent);
    } catch (err) {
      // Non-fatal — token is still in memory for this session
      this.logger.warn(`Could not persist auth token to .env: ${String(err)}`);
    }
  }
}
