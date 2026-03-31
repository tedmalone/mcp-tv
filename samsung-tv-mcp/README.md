# samsung-tv-mcp

MCP server for controlling Samsung Tizen TVs via the built-in WebSocket API — power (Wake-on-LAN), volume, input switching, and raw key codes.

## Prerequisites

- Node.js >= 20
- Samsung smart TV (Tizen OS, 2016 or later recommended)
- TV and your computer on the same local network

## TV Setup

No developer mode or special TV settings are required. The TV's built-in remote-control API is always available.

1. **Find your TV's IP address**
   - Go to **Settings → General → Network → Network Status → IP Settings**
   - Or check your router's DHCP client list

2. **Find your TV's MAC address** (needed for Wake-on-LAN / power on)
   - Go to **Settings → General → Network → Network Status**
   - Note the **MAC Address** (format: `AA:BB:CC:DD:EE:FF`)
   - Alternatively, the `discover` tool will attempt to retrieve it automatically

3. **Enable Wake-on-LAN** (for power on support)
   - Go to **Settings → General → Network**
   - Enable **Power On with Mobile** (or **Remote Device Wake Up** depending on model)

## Installation

```sh
cd samsung-tv-mcp
npm install
npm run build
```

## Configuration

```sh
cp .env.example .env
```

Edit `.env`:

```
SAMSUNG_TV_IP=192.168.1.100      # your TV's IP address
SAMSUNG_TV_MAC=AA:BB:CC:DD:EE:FF # your TV's MAC address (for power on)
SAMSUNG_TV_NAME=Claude MCP        # name shown on the TV's permission prompt
SAMSUNG_TV_TOKEN=                 # leave blank — auto-populated on first connection
```

### Auth Token

On first connection, the TV will display a permission prompt asking if you want to allow the connection from "Claude MCP" (or whatever name you set). Accept it. The server automatically saves the token to your `.env` so you won't be prompted again.

## Running

**Development (auto-reload):**

```sh
npm run dev
```

**Production:**

```sh
npm start
```

## Linting and Formatting

```sh
npm run lint
npm run format
```

Auto-fix:

```sh
npm run lint:fix
npm run format:fix
```

## Claude Desktop Integration

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "samsung-tv": {
      "command": "node",
      "args": ["/absolute/path/to/samsung-tv-mcp/dist/index.js"],
      "env": {
        "SAMSUNG_TV_IP": "192.168.1.100",
        "SAMSUNG_TV_MAC": "AA:BB:CC:DD:EE:FF",
        "SAMSUNG_TV_NAME": "Claude MCP"
      }
    }
  }
}
```

## Tools

| Tool           | Description                                           |
| -------------- | ----------------------------------------------------- |
| `discover`     | Scan local subnet for Samsung TVs                     |
| `power`        | Power on (Wake-on-LAN) or off                         |
| `set_volume`   | Set volume to a target level (sends key presses)      |
| `get_volume`   | Read current volume from device info                  |
| `mute`         | Toggle mute                                           |
| `switch_input` | Switch input source (HDMI1–4, DTV, TV, Component, AV) |
| `send_key`     | Send a raw Samsung key code (e.g. `KEY_MENU`)         |

## Troubleshooting

**TV shows a permission prompt on every connection** — The auth token isn't being saved. Check that your `.env` file is writable and `SAMSUNG_TV_TOKEN` is not set to an expired value. Delete the token line and reconnect.

**`power on` doesn't work** — Wake-on-LAN requires the correct MAC address and the TV's WoL setting to be enabled. Verify both, and that your router allows LAN broadcasts.

**Connection times out** — The TV may be off or unreachable. Confirm the IP address is correct and the TV is on the same subnet.

**SSL/TLS note** — Samsung TVs use self-signed certificates. The WebSocket connection disables certificate validation, which is safe for local network use. See the code comment in `src/samsung-client.ts` for details.
