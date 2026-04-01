# mcp-tv

A monorepo of Model Context Protocol (MCP) servers for controlling smart TVs via Claude AI. Supports Fire TV, Samsung TV, and Apple TV.

## Project Structure

```
mcp-tv/
├── fire-tv-mcp/       # TypeScript MCP server — Fire TV via ADB over Wi-Fi
├── samsung-tv-mcp/    # TypeScript MCP server — Samsung Tizen via WebSocket
├── apple-tv-mcp/      # Python MCP server — Apple TV via pyatv (mDNS)
├── device_learnings.md
└── README.md
```

## Tech Stack

| Platform    | Language   | Protocol              |
|-------------|------------|-----------------------|
| Fire TV     | TypeScript | ADB over Wi-Fi        |
| Samsung TV  | TypeScript | WebSocket + WoL       |
| Apple TV    | Python     | pyatv / mDNS / AirPlay |

## Setup

### TypeScript servers (fire-tv-mcp, samsung-tv-mcp)
- Package manager: `npm`
- Build: `tsc` (compiles `src/` → `dist/`)
- Each has its own `package.json` and `node_modules/`

### Python server (apple-tv-mcp)
- Package manager: `pip`
- Installed as editable package via `pip install -e .`
- Entry point: `apple-tv-mcp` CLI or `python -m apple_tv_mcp.server`

## Running MCP Servers

Each server uses stdio transport for MCP communication:

```sh
# Fire TV
node fire-tv-mcp/dist/index.js

# Samsung TV
node samsung-tv-mcp/dist/index.js

# Apple TV
python -m apple_tv_mcp.server
# or: apple-tv-mcp (if installed in PATH)
```

## Configuration

Copy `.env.example` to `.env` in each server directory and configure your device IPs:

```sh
cp fire-tv-mcp/.env.example fire-tv-mcp/.env    # set FIRETV_IP
cp samsung-tv-mcp/.env.example samsung-tv-mcp/.env  # set SAMSUNG_TV_IP, SAMSUNG_TV_MAC
cp apple-tv-mcp/.env.example apple-tv-mcp/.env  # set ATV_IP
```

## Development

```sh
# Build TypeScript servers
cd fire-tv-mcp && npm run build
cd samsung-tv-mcp && npm run build

# Run tests
cd fire-tv-mcp && npm test
cd samsung-tv-mcp && npm test
cd apple-tv-mcp && pytest
```

## Replit Environment

- Node.js 20 and Python 3.12 are both available via `.replit` modules config
- `.env` files created from examples (device IPs need to be filled in for real usage)
- The workflow builds both TypeScript projects to verify compilation
