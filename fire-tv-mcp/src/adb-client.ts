import { execa } from 'execa';
import { createLogger } from './logger.js';

export interface FireTvConfig {
  ip?: string;
  port: number;
}

export interface DeviceInfo {
  serial: string;
  state: string;
  details: Record<string, string>;
}

export interface AdbMdnsService {
  instance: string;
  serviceType: string;
  address: string | null;
  port: number | null;
  raw: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// 30s covers slower ADB commands on first connect while staying bounded.
const DEFAULT_ADB_COMMAND_TIMEOUT_MS = 30000;
const DEFAULT_ADB_CONNECT_RETRIES = 3;
const DEFAULT_ADB_RETRY_BASE_DELAY_MS = 500;
// Retry shell once after reconnect for transient link drops.
const DEFAULT_ADB_SHELL_ATTEMPTS = 2;

const ADB_COMMAND_TIMEOUT_MS = envInt(
  'FIRETV_ADB_COMMAND_TIMEOUT_MS',
  DEFAULT_ADB_COMMAND_TIMEOUT_MS,
);
const ADB_CONNECT_RETRIES = envInt('FIRETV_ADB_CONNECT_RETRIES', DEFAULT_ADB_CONNECT_RETRIES);
const ADB_RETRY_BASE_DELAY_MS = envInt(
  'FIRETV_ADB_RETRY_BASE_DELAY_MS',
  DEFAULT_ADB_RETRY_BASE_DELAY_MS,
);
const ADB_SHELL_ATTEMPTS = envInt('FIRETV_ADB_SHELL_ATTEMPTS', DEFAULT_ADB_SHELL_ATTEMPTS);

export class AdbClient {
  private readonly configuredDeviceSerial: string;
  private activeDeviceSerial: string;
  private connected = false;
  private readonly logger = createLogger('fire-tv-mcp/adb');

  constructor(private readonly config: FireTvConfig) {
    this.configuredDeviceSerial = config.ip ? `${config.ip}:${config.port}` : '';
    this.activeDeviceSerial = this.configuredDeviceSerial;
  }

  get configuredSerial(): string | null {
    return this.configuredDeviceSerial || null;
  }

  get activeSerial(): string | null {
    return this.activeDeviceSerial || null;
  }

  setActiveSerial(serial: string): void {
    const next = serial.trim();
    if (!next) {
      throw new Error('Active device serial cannot be empty.');
    }
    if (this.activeDeviceSerial !== next) {
      this.activeDeviceSerial = next;
      this.connected = false;
      this.logger.info(`Using discovered device target: ${next}`);
    }
  }

  async ensureConnected(): Promise<void> {
    if (!this.activeDeviceSerial) {
      throw new Error(
        'No Fire TV target is configured. Run discover first, or set FIRETV_IP/FIRETV_PORT.',
      );
    }
    if (this.connected) return;
    await this.connectWithRetry();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.activeDeviceSerial) {
      return;
    }
    try {
      await this.runAdb(['disconnect', this.activeDeviceSerial]);
    } finally {
      this.connected = false;
    }
  }

  async shell(command: string): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= ADB_SHELL_ATTEMPTS; attempt++) {
      await this.ensureConnected();
      try {
        return await this.runAdb(['-s', this.activeDeviceSerial, 'shell', command]);
      } catch (err) {
        lastError = err;
        if (attempt < ADB_SHELL_ATTEMPTS) {
          this.logger.warn(
            `Shell command failed (attempt ${attempt}/${ADB_SHELL_ATTEMPTS}), reconnecting: ${command}`,
          );
          this.connected = false;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const out = await this.runAdb(['devices', '-l']);
    const lines = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('List of devices attached'));

    return lines.map((line) => {
      const parts = line.split(/\s+/);
      const serial = parts[0] ?? '';
      const state = parts[1] ?? 'unknown';
      const details: Record<string, string> = {};

      for (const part of parts.slice(2)) {
        const [key, value] = part.split(':');
        if (key && value) details[key] = value;
      }

      return { serial, state, details };
    });
  }

  async screenshotBase64(): Promise<string> {
    await this.ensureConnected();
    const { stdout } = await execa(
      'adb',
      ['-s', this.activeDeviceSerial, 'exec-out', 'screencap', '-p'],
      {
      encoding: 'buffer',
      stdout: 'pipe',
      stderr: 'pipe',
      reject: true,
      },
    );
    return Buffer.from(stdout).toString('base64');
  }

  async getScreenXml(): Promise<string> {
    const out = await this.shell('uiautomator dump /dev/tty');
    const start = out.indexOf('<?xml');
    if (start === -1) {
      throw new Error('uiautomator output did not contain XML');
    }
    return out.slice(start).trim();
  }

  async tap(x: number, y: number): Promise<void> {
    await this.shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
  }

  async keyevent(key: string): Promise<void> {
    await this.shell(`input keyevent ${key}`);
  }

  async runAdb(args: string[]): Promise<string> {
    const { stdout } = await execa('adb', args, {
      reject: true,
      timeout: ADB_COMMAND_TIMEOUT_MS,
    });
    return stdout.trim();
  }

  private async connectWithRetry(): Promise<void> {
    let lastError: unknown;
    const attempts = ADB_CONNECT_RETRIES;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.runAdb(['connect', this.serial]);
        if (attempt > 1) {
          this.logger.info(`ADB reconnect succeeded on attempt ${attempt}.`);
        }
        return;
      } catch (err) {
        lastError = err;
        this.logger.warn(`ADB connect attempt ${attempt}/${attempts} failed.`);
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, attempt * ADB_RETRY_BASE_DELAY_MS));
        }
      }
    }
    throw new Error(
      `Failed to connect to Fire TV at ${this.serial}. ` +
        `Ensure ADB debugging is enabled and accept the trust prompt on TV. ` +
        `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  async listMdnsServices(): Promise<AdbMdnsService[]> {
    const out = await this.runAdb(['mdns', 'services']);
    const lines = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return lines.map((line) => {
      const parts = line.split(/\s+/);
      const addressPart = parts.find((p) => /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(p)) ?? null;
      const serviceType = parts.find((p) => p.includes('._tcp')) ?? 'unknown';
      const instance = parts[0] ?? 'unknown';
      let address: string | null = null;
      let port: number | null = null;
      if (addressPart) {
        const [ip, p] = addressPart.split(':');
        address = ip ?? null;
        port = p ? Number(p) : null;
      }
      return {
        instance,
        serviceType,
        address,
        port,
        raw: line,
      };
    });
  }

  private get serial(): string {
    return this.activeDeviceSerial;
  }
}
