#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AdbClient } from './adb-client.js';
import { FireTvRestClient } from './firetv-rest-client.js';
import { registerTools } from './tools.js';
import { createLogger } from './logger.js';
import {
  adbInstallGuidance,
  fireTvReachabilityGuidance,
  fireTvUnauthorizedGuidance,
} from './setup.js';

const FIRETV_IP = process.env.FIRETV_IP;
const DEFAULT_FIRETV_ADB_PORT = 5555;
const FIRETV_PORT = Number(process.env.FIRETV_PORT ?? String(DEFAULT_FIRETV_ADB_PORT));

const DEFAULT_FIRETV_REST_PORT = 8080;
const FIRETV_REST_PORT = Number(process.env.FIRETV_REST_PORT ?? String(DEFAULT_FIRETV_REST_PORT));
const FIRETV_REST_API_KEY = process.env.FIRETV_REST_API_KEY ?? '';
const FIRETV_REST_TOKEN = process.env.FIRETV_REST_TOKEN ?? '';

const logger = createLogger('fire-tv-mcp');

if (!Number.isFinite(FIRETV_PORT) || FIRETV_PORT <= 0) {
  logger.error('Startup config error: FIRETV_PORT must be a positive number.');
  process.exit(1);
}

const adb = new AdbClient({
  ip: FIRETV_IP,
  port: FIRETV_PORT,
});

const rest = new FireTvRestClient({
  ip: FIRETV_IP ?? '',
  port: FIRETV_REST_PORT,
  apiKey: FIRETV_REST_API_KEY,
  token: FIRETV_REST_TOKEN || undefined,
});

const server = new McpServer({
  name: 'fire-tv-mcp',
  version: '0.1.0',
});

registerTools(server, adb, rest);

async function main(): Promise<void> {
  // Ensure the ADB server daemon is running before any adb commands.
  // This is a no-op if already running; without it, the first connect
  // attempt can fail if the daemon was never started.
  try {
    await adb.runAdb(['start-server']);
  } catch {
    // Non-fatal: the binary check below will catch a missing adb
  }

  try {
    await adb.runAdb(['version']);
  } catch {
    logger.error(`Startup dependency error:\n${adbInstallGuidance()}`);
    process.exit(1);
  }

  if (FIRETV_IP) {
    const serial = `${FIRETV_IP}:${FIRETV_PORT}`;
    try {
      await adb.runAdb(['connect', serial]);
      const devices = await adb.listDevices();
      const target = devices.find((d) => d.serial === serial);
      if (!target) {
        logger.warn(fireTvReachabilityGuidance(FIRETV_IP, FIRETV_PORT));
      } else if (target.state === 'unauthorized') {
        logger.warn(fireTvUnauthorizedGuidance(FIRETV_IP, FIRETV_PORT));
      } else if (target.state !== 'device') {
        logger.warn(
          `Fire TV device state is '${target.state}'. Some commands may fail until the device is ready.`,
        );
      }
    } catch {
      logger.warn(fireTvReachabilityGuidance(FIRETV_IP, FIRETV_PORT));
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Server running (stdio).');
  logger.info(
    `ADB device: ${FIRETV_IP ? `${FIRETV_IP}:${FIRETV_PORT}` : 'not configured (use discover first)'}`,
  );
  logger.info(
    `REST API: ${rest.ready ? `ready (${FIRETV_IP}:${FIRETV_REST_PORT})` : rest.configured ? 'configured but not authenticated (run setup_rest tool)' : 'not configured (set FIRETV_REST_API_KEY to enable fast REST path)'}`,
  );
}

main().catch((err) => {
  logger.error(`Startup failure: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

process.on('SIGINT', async () => {
  await adb.disconnect().catch(() => undefined);
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await adb.disconnect().catch(() => undefined);
  process.exit(0);
});
