#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SamsungTvClient } from './samsung-client.js';
import { registerTools } from './tools.js';
import { createLogger } from './logger.js';

const TV_IP = process.env.SAMSUNG_TV_IP;
const TV_MAC = process.env.SAMSUNG_TV_MAC;
const TV_NAME = process.env.SAMSUNG_TV_NAME || 'Claude MCP';
const TV_TOKEN = process.env.SAMSUNG_TV_TOKEN || undefined;
const logger = createLogger('samsung-tv-mcp');

const client = new SamsungTvClient({
  ip: TV_IP,
  mac: TV_MAC || undefined,
  name: TV_NAME,
  token: TV_TOKEN,
});

const server = new McpServer({
  name: 'samsung-tv-mcp',
  version: '0.1.0',
});

registerTools(server, client);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Server running (stdio).');
  logger.info(`TV: ${TV_IP ?? 'not configured (use discover first)'} (${TV_NAME})`);
  logger.info(`MAC: ${TV_MAC ?? 'not configured (discover first)'}`);
  logger.info(`Token: ${TV_TOKEN ? 'configured' : 'awaiting first connection'}`);
}

main().catch((err) => {
  logger.error(`Startup failure: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  client.disconnect();
  process.exit(0);
});
process.on('SIGTERM', () => {
  client.disconnect();
  process.exit(0);
});
