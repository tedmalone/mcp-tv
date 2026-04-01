#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AdbClient } from './adb-client.js';
import { registerTools } from './tools.js';
import { createLogger } from './logger.js';
import {
  adbInstallGuidance,
  fireTvReachabilityGuidance,
  fireTvUnauthorizedGuidance,
} from './setup.js';

const FIRETV_IP = process.env.FIRETV_IP;
// Standard ADB-over-network port for Android/Fire TV.
const DEFAULT_FIRETV_ADB_PORT = 5555;
const FIRETV_PORT = Number(process.env.FIRETV_PORT ?? String(DEFAULT_FIRETV_ADB_PORT));
const logger = createLogger('fire-tv-mcp');

if (!Number.isFinite(FIRETV_PORT) || FIRETV_PORT <= 0) {
  logger.error('Startup config error: FIRETV_PORT must be a positive number.');
  process.exit(1);
}

const client = new AdbClient({
  ip: FIRETV_IP,
  port: FIRETV_PORT,
});

const server = new McpServer({
  name: 'fire-tv-mcp',
  version: '0.1.0',
});

registerTools(server, client);

async function main(): Promise<void> {
  try {
    logger.info('Startup step 1/5: checking adb binary...');
    await client.runAdb(['version']);
  } catch {
    logger.error(`Startup dependency error:\n${adbInstallGuidance()}`);
    process.exit(1);
  }

  logger.info('Startup step 2/5: starting adb server...');
  try {
    await client.runAdb(['start-server']);
  } catch (err) {
    logger.error(`Failed to start adb server: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (FIRETV_IP) {
    const serial = `${FIRETV_IP}:${FIRETV_PORT}`;
    logger.info(`Startup step 3/5: connecting to Fire TV (${serial})...`);
    try {
      await client.runAdb(['connect', serial]);
    } catch {
      logger.error(fireTvReachabilityGuidance(FIRETV_IP, FIRETV_PORT));
      process.exit(1);
    }

    logger.info('Startup step 4/5: verifying device via adb devices...');
    const devices = await client.listDevices();
    const target = devices.find((d) => d.serial === serial);
    if (!target) {
      logger.error(fireTvReachabilityGuidance(FIRETV_IP, FIRETV_PORT));
      process.exit(1);
    }
    if (target.state === 'unauthorized') {
      logger.error(fireTvUnauthorizedGuidance(FIRETV_IP, FIRETV_PORT));
      process.exit(1);
    }
    if (target.state !== 'device') {
      logger.error(`Fire TV device state is '${target.state}', expected 'device'.`);
      process.exit(1);
    }
  } else {
    logger.info('Startup steps 3/5 and 4/5 skipped: FIRETV_IP is not configured.');
    logger.info(
      'Discovery mode: run the discover tool to find Fire TV IPs, then set FIRETV_IP and restart for full control.',
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Startup step 5/5: ready.');
  logger.info('Server running (stdio).');
  logger.info(
    `Device: ${FIRETV_IP ? `${FIRETV_IP}:${FIRETV_PORT}` : 'not configured (use discover first)'}`,
  );
}

main().catch((err) => {
  logger.error(`Startup failure: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

process.on('SIGINT', async () => {
  await client.disconnect().catch(() => undefined);
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await client.disconnect().catch(() => undefined);
  process.exit(0);
});
