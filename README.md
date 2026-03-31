# mcp-tv

Model Context Protocol (MCP) servers for controlling TVs via Claude. Supports Fire TV, Samsung TV, and Apple TV from a single repo.

## Platforms

| Platform | Language | Transport | Directory |
|----------|----------|-----------|-----------|
| Fire TV | TypeScript | ADB over Wi-Fi | [`fire-tv-mcp/`](./fire-tv-mcp/) |
| Samsung TV | TypeScript | WebSocket + REST | [`samsung-tv-mcp/`](./samsung-tv-mcp/) |
| Apple TV | Python | pyatv (mDNS) | [`apple-tv-mcp/`](./apple-tv-mcp/) |

## Quick Start

Each platform is a self-contained MCP server. See the setup guide for the platform you want to use:

- **Fire TV** — [Setup Guide](./fire-tv-mcp/README.md)
- **Samsung TV** — [Setup Guide](./samsung-tv-mcp/README.md)
- **Apple TV** — [Setup Guide](./apple-tv-mcp/README.md)

## Requirements

- **Fire TV / Samsung TV:** Node.js >= 20
- **Apple TV:** Python >= 3.10
- **Fire TV only:** ADB (Android Debug Bridge) installed and in PATH

## License

MIT
