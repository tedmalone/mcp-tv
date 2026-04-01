# mcp-tv

A monorepo of Model Context Protocol (MCP) servers for controlling smart TVs via Claude AI. Supports Fire TV, Samsung TV, and Apple TV.

## Project Structure

```
mcp-tv/
├── fire-tv-mcp/       # TypeScript MCP server — Fire TV via REST API (fast) + ADB fallback
├── samsung-tv-mcp/    # TypeScript MCP server — Samsung Tizen via SmartThings + WebSocket + WoL
├── apple-tv-mcp/      # Python MCP server — Apple TV via pyatv (mDNS)
├── device_learnings.md
└── README.md
```

## Tech Stack

| Platform    | Language   | Primary Protocol                   | Fallback              |
|-------------|------------|------------------------------------|-----------------------|
| Fire TV     | TypeScript | REST API port 8080 (PIN-paired)    | ADB over Wi-Fi        |
| Samsung TV  | TypeScript | SmartThings Cloud API              | WebSocket + WoL burst |
| Apple TV    | Python     | pyatv / mDNS / AirPlay             | —                     |

## Key Design Decisions

### Samsung TV — SmartThings + WoL burst
- **Problem**: `KEY_HDMIx` keycodes are silently ignored on 2024+ Tizen models. Single WoL packets unreliable over Wi-Fi (TV NIC powers down in deep standby).
- **Solution**: SmartThings Cloud API (`setInputSource` capability) for reliable input switching. WoL burst (16 packets, 100ms spacing) for power-on when SmartThings is not configured.
- **Priority**: SmartThings → WebSocket (power/input). WoL burst → SmartThings (power-on only).
- **Required env vars**: `SAMSUNG_SMARTTHINGS_TOKEN` + `SAMSUNG_SMARTTHINGS_DEVICE_ID`

### Fire TV — REST API + ADB hybrid routing
- **Problem**: ADB is impossible from iOS (sandboxed, no child processes). REST path is 10× faster.
- **Solution**: Fire TV exposes an undocumented HTTPS REST API on port 8080 (discovered via uc-intg-firetv). PIN pairing via `/v1/FireTV/pin/display` + `/v1/FireTV/pin/verify`. Navigation via `POST /v1/FireTV?action=<action>`, media via `/v1/media`, apps via `/v1/FireTV/app/<package>`.
- **Routing**: REST API → any supported key/app launch. ADB → screenshot, UI tree, click_node, text input, volume, arbitrary shell.
- **ADB daemon**: `adb start-server` runs at startup to prime the daemon before any commands.
- **TLS**: Uses `undici` Agent with `rejectUnauthorized: false` (self-signed cert, LAN-only).

## Setup

### TypeScript servers (fire-tv-mcp, samsung-tv-mcp)
- Package manager: `npm`
- Build: `tsc` (compiles `src/` → `dist/`)
- Each has its own `package.json` and `node_modules/`
- `fire-tv-mcp` has `undici` as a runtime dependency (for TLS bypass)

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

Copy `.env.example` to `.env` in each server directory:

```sh
cp fire-tv-mcp/.env.example fire-tv-mcp/.env
cp samsung-tv-mcp/.env.example samsung-tv-mcp/.env
cp apple-tv-mcp/.env.example apple-tv-mcp/.env
```

### Samsung TV key env vars
| Variable | Required | Purpose |
|---|---|---|
| `SAMSUNG_TV_IP` | Yes | TV IP address |
| `SAMSUNG_TV_MAC` | For WoL | Auto-saved by `discover` tool |
| `SAMSUNG_SMARTTHINGS_TOKEN` | Recommended | Personal access token from account.smartthings.com/tokens |
| `SAMSUNG_SMARTTHINGS_DEVICE_ID` | Recommended | UUID from GET /v1/devices |

### Fire TV key env vars
| Variable | Required | Purpose |
|---|---|---|
| `FIRETV_IP` | Yes | Fire TV IP address |
| `FIRETV_REST_API_KEY` | For REST | Any non-empty string (client identifier) |
| `FIRETV_REST_TOKEN` | Auto-set | Saved by `setup_rest` tool after PIN pairing |

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
- `undici` installed as runtime dependency in `fire-tv-mcp` for REST TLS bypass
