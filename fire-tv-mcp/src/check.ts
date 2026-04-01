#!/usr/bin/env node
import 'dotenv/config';
import { AdbClient } from './adb-client.js';
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
const logger = createLogger('fire-tv-mcp/check');

function fail(msg: string): never {
  logger.error(msg);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!Number.isFinite(FIRETV_PORT) || FIRETV_PORT <= 0) {
    fail('FIRETV_PORT must be a positive number.');
  }

  const client = new AdbClient({
    ip: FIRETV_IP,
    port: FIRETV_PORT,
  });

  try {
    logger.info('Check step 1/5: checking adb binary...');
    const version = await client.runAdb(['version']);
    const firstLine = version.split(/\r?\n/)[0] ?? version;
    logger.info(`adb check: ok (${firstLine})`);
  } catch {
    fail(adbInstallGuidance());
  }

  logger.info('Check step 2/5: starting adb server...');
  try {
    await client.runAdb(['start-server']);
  } catch (err) {
    fail(`Failed to start adb server: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!FIRETV_IP) {
    logger.info(
      'Check steps 3/5 and 4/5 skipped: FIRETV_IP is not set. Dependency check passed.',
    );
    logger.info('Check step 5/5: ready.');
    return;
  }

  const serial = `${FIRETV_IP}:${FIRETV_PORT}`;
  logger.info(`Check step 3/5: connecting to Fire TV (${serial})...`);
  try {
    const connectOut = await client.runAdb(['connect', serial]);
    logger.info(`adb connect: ${connectOut || 'ok'}`);
  } catch {
    fail(fireTvReachabilityGuidance(FIRETV_IP, FIRETV_PORT));
  }

  logger.info('Check step 4/5: verifying device via adb devices...');
  const devices = await client.listDevices();
  const target = devices.find((d) => d.serial === serial);
  if (!target) {
    fail(fireTvReachabilityGuidance(FIRETV_IP, FIRETV_PORT));
  }

  if (target.state === 'device') {
    logger.info(`device check: ready (${serial})`);
    logger.info('Check step 5/5: ready.');
    return;
  }

  if (target.state === 'unauthorized') {
    fail(fireTvUnauthorizedGuidance(FIRETV_IP, FIRETV_PORT));
  }

  fail(
    [
      `Device found but state is '${target.state}'.`,
      fireTvReachabilityGuidance(FIRETV_IP, FIRETV_PORT),
    ].join('\n\n'),
  );
}

main().catch((err) => {
  fail(`check-deps failed: ${err instanceof Error ? err.message : String(err)}`);
});
