# apple-tv-mcp

MCP server for controlling Apple TV via [pyatv](https://pyatv.dev) — power, volume, navigation, app control, text input, and now-playing metadata.

## Prerequisites

- Python >= 3.10
- Apple TV (4th generation or later, tvOS 14+)
- Apple TV and your computer on the same local network

## Installation

```sh
cd apple-tv-mcp
pip install -e .
```

Or with a virtual environment (recommended):

```sh
cd apple-tv-mcp
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e .
```

## Configuration

```sh
cp .env.example .env
```

Edit `.env`:
```
ATV_IP=192.168.1.101   # your Apple TV's IP address (optional — auto-discovered if omitted)
ATV_NAME=              # filter by name if you have multiple Apple TVs (optional)
ATV_CREDENTIALS_PATH=pyatv_credentials.json  # credentials file path (auto-created after pairing)
```

**Finding your Apple TV's IP address:**
- On Apple TV: **Settings → Network → Wi-Fi** (or Ethernet) → note the IP address

## Pairing

Apple TV requires a one-time pairing before you can control it. Do this after starting the server for the first time.

1. **Start the server:**
   ```sh
   apple-tv-mcp
   ```

2. **In Claude, call `start_pairing`:**
   ```
   start_pairing(protocol="companion")
   ```
   Your Apple TV will display a 4-digit PIN on screen.

3. **Call `pair_apple_tv` with the PIN:**
   ```
   pair_apple_tv(pin="1234", protocol="companion")
   ```

4. **Done.** Credentials are saved automatically to `pyatv_credentials.json` and reused on every future connection. You won't need to pair again unless you reset the Apple TV.

> **Note:** The `companion` protocol gives the best feature coverage. If you have issues, try `airplay` as the protocol.

## Running

**Direct:**
```sh
apple-tv-mcp
```

**As a module:**
```sh
python -m apple_tv_mcp.server
```

## Linting and Type Checking

Install dev tools:

```sh
pip install -e ".[dev]"
```

Run checks:

```sh
ruff check src
ruff format --check src
mypy src
```

## Claude Desktop Integration

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "apple-tv": {
      "command": "/absolute/path/to/.venv/bin/apple-tv-mcp",
      "env": {
        "ATV_IP": "192.168.1.101"
      }
    }
  }
}
```

Replace the command path with the output of `which apple-tv-mcp` (after activating your venv).

## Tools

| Tool | Description |
|------|-------------|
| `discover` | Scan the network for Apple TVs |
| `power` | Power on or off (`on` / `off`) |
| `set_volume` | Set volume level (0–100) |
| `get_volume` | Read current volume |
| `press_key` | Press a key (up/down/left/right/select/menu/home/play/pause/etc.) |
| `press_keys` | Press multiple keys in sequence with optional delay |
| `go_home` | Go to the home screen |
| `go_back` | Go back |
| `launch_app` | Launch an app by name or bundle ID |
| `list_apps` | List installed apps |
| `get_current_app` | Get the currently running app |
| `deep_link` | Open a URI / deep link |
| `type_text` | Type text into the focused input |
| `get_now_playing` | Get current playback metadata (title, artist, position) |
| `start_pairing` | Start the pairing flow (displays PIN on TV) |
| `pair_apple_tv` | Complete pairing with the PIN shown on TV |

## Troubleshooting

**Discovery finds no devices** — Ensure the Apple TV is on, awake, and on the same subnet. mDNS discovery requires no firewall blocking UDP multicast.

**Pairing fails** — Make sure you call `pair_apple_tv` promptly after `start_pairing` — the PIN expires quickly. Try the `airplay` protocol if `companion` doesn't work.

**`credentials not found` after restart** — Check that `pyatv_credentials.json` exists in the working directory and is not gitignored from that location. Re-pair if the file was deleted.

**Volume / app control not working** — Some features require the `companion` protocol. Re-pair with `protocol="companion"` if you initially paired with `airplay`.
