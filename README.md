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

## Mac Setup

### 1. Install system dependencies

Install [Homebrew](https://brew.sh) if you don't have it, then:

```sh
# Node.js (for Fire TV and Samsung TV servers)
brew install node

# Python (for Apple TV server)
brew install python@3.12

# ADB (for Fire TV server only)
brew install --cask android-platform-tools
```

Verify versions:

```sh
node --version   # should be >= 20
python3 --version  # should be >= 3.10
adb version      # if using Fire TV
```

### 2. Clone and install each server

```sh
git clone https://github.com/tedmalone/mcp-tv.git
cd mcp-tv

# Fire TV
cd fire-tv-mcp && npm install && npm run build && npm run check-deps && cd ..

# Samsung TV
cd samsung-tv-mcp && npm install && npm run build && cd ..

# Apple TV (use a virtual environment)
cd apple-tv-mcp
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
cd ..
```

### 3. Configure each server

Copy `.env.example` to `.env` in each server directory and fill in your device IPs:

```sh
cp fire-tv-mcp/.env.example fire-tv-mcp/.env
cp samsung-tv-mcp/.env.example samsung-tv-mcp/.env
cp apple-tv-mcp/.env.example apple-tv-mcp/.env
```

### 4. Register MCP servers with Claude

#### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "fire-tv": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-tv/fire-tv-mcp/dist/index.js"],
      "env": {
        "FIRETV_IP": "192.168.1.102"
      }
    },
    "samsung-tv": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-tv/samsung-tv-mcp/dist/index.js"],
      "env": {
        "SAMSUNG_TV_IP": "192.168.1.100",
        "SAMSUNG_TV_MAC": "AA:BB:CC:DD:EE:FF"
      }
    },
    "apple-tv": {
      "command": "/absolute/path/to/mcp-tv/apple-tv-mcp/.venv/bin/apple-tv-mcp",
      "env": {
        "ATV_IP": "192.168.1.101"
      }
    }
  }
}
```

#### Claude Code

Add a `.mcp.json` file to the project root (or your home directory for global access).
If you place it in your home directory, use absolute paths for all commands:

```json
{
  "mcpServers": {
    "fire-tv": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-tv/fire-tv-mcp/dist/index.js"],
      "env": {
        "FIRETV_IP": "192.168.1.102"
      }
    },
    "samsung-tv": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-tv/samsung-tv-mcp/dist/index.js"],
      "env": {
        "SAMSUNG_TV_IP": "192.168.1.100",
        "SAMSUNG_TV_MAC": "AA:BB:CC:DD:EE:FF"
      }
    },
    "apple-tv": {
      "command": "/absolute/path/to/mcp-tv/apple-tv-mcp/.venv/bin/apple-tv-mcp",
      "env": {
        "ATV_IP": "192.168.1.101"
      }
    }
  }
}
```

### macOS-Specific Notes

- **Firewall:** If Apple TV discovery fails, check System Settings > Network > Firewall. mDNS discovery requires UDP multicast on port 5353 to be allowed.
- **Python:** Use `python3` and `pip3` (or activate the venv first). macOS ships an old system Python at `/usr/bin/python3` — prefer the Homebrew version.
- **ADB authorization:** When connecting to Fire TV, the "Allow USB debugging?" prompt only appears when the TV is awake. Wake it first if you don't see the dialog.
- **Network:** All devices must be on the same subnet. If you use VLANs or a mesh network with client isolation, mDNS and ADB will not work across boundaries.
- **npm `EPERM` cache errors:** If `npm install`/`npm ci` fails with permission errors under `~/.npm`, fix ownership:
  ```sh
  sudo chown -R $(id -u):$(id -g) ~/.npm
  ```

## Windows Setup

Install each platform's prerequisites (see individual READMEs), then follow the same steps above. Key differences:

- Use `%APPDATA%\Claude\claude_desktop_config.json` for Claude Desktop config
- Use `.venv\Scripts\activate` for the Python virtual environment
- Download ADB from [Android SDK Platform Tools](https://developer.android.com/tools/releases/platform-tools) and add to PATH

## License

MIT
