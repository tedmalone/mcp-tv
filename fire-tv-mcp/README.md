# fire-tv-mcp

MCP server for controlling Fire TV devices via ADB over Wi-Fi.

## Prerequisites

- Node.js >= 20
- ADB (Android Debug Bridge) installed and in PATH
- Fire TV and your computer on the same local network

### Install ADB

**macOS:**

```sh
brew install --cask android-platform-tools
```

**Windows:**
Download [Android SDK Platform Tools](https://developer.android.com/tools/releases/platform-tools), extract, and add the `platform-tools` folder to your PATH.

**Linux (Debian/Ubuntu):**

```sh
sudo apt-get install android-sdk-platform-tools
```

**Linux (Arch):**

```sh
sudo pacman -S android-tools
```

## Fire TV Setup

You need to enable ADB over the network on your Fire TV. Do this once.

1. **Enable Developer Options**
   - Go to **Settings → My Fire TV → About**
   - Click **Fire TV Stick** (or your device name) **7 times** rapidly
   - You'll see "No need, you are already a developer!" or "You are now a developer"

2. **Enable ADB Debugging**
   - Go to **Settings → My Fire TV → Developer Options**
   - Turn on **ADB debugging**

3. **Find your Fire TV's IP address**
   - Go to **Settings → My Fire TV → About → Network**
   - Note the IP address (e.g. `192.168.1.102`)

4. **Connect from your computer**

   ```sh
   adb connect <your-fire-tv-ip>:5555
   ```

   - A prompt will appear on your TV: **"Allow USB debugging?"**
   - Select **Always allow from this computer**, then **OK**

5. **Verify the connection**
   ```sh
   adb devices
   # Should show: 192.168.x.x:5555    device
   ```

## Installation

```sh
cd fire-tv-mcp
npm install
npm run build
```

## Configuration

```sh
cp .env.example .env
```

Edit `.env`:

```
FIRETV_IP=192.168.1.102   # your Fire TV's IP address
FIRETV_PORT=5555           # default, change only if needed
```

## Verify Setup

```sh
npm run check-deps
```

This checks that ADB is installed, can reach the Fire TV, and the device is authorized. It prints actionable guidance if anything is wrong.

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
    "fire-tv": {
      "command": "node",
      "args": ["/absolute/path/to/fire-tv-mcp/dist/index.js"],
      "env": {
        "FIRETV_IP": "192.168.1.102",
        "FIRETV_PORT": "5555"
      }
    }
  }
}
```

## Tools

| Tool                 | Description                                            |
| -------------------- | ------------------------------------------------------ |
| `discover`           | Find Fire TV devices via ADB/mDNS                      |
| `press_key`          | Press a key (up/down/left/right/home/back/select/etc.) |
| `press_keys`         | Press multiple keys in sequence                        |
| `go_home`            | Go to the home screen                                  |
| `go_back`            | Go back                                                |
| `type_text`          | Type text into the focused input                       |
| `launch_app`         | Launch an app by package name                          |
| `list_apps`          | List installed third-party apps                        |
| `get_current_app`    | Get the current foreground app                         |
| `deep_link`          | Open a URI / deep link                                 |
| `screenshot`         | Capture a screenshot (base64 PNG)                      |
| `get_screen_content` | Dump UI hierarchy as JSON                              |
| `click_node`         | Tap a UI element by text or content description        |
| `set_volume`         | Set media volume (0–25)                                |
| `get_volume`         | Read current media volume                              |
| `mute`               | Toggle mute                                            |
| `sleep`              | Put the Fire TV to sleep                               |
| `list_devices`       | List ADB devices visible to host                       |
| `get_device_info`    | Read device model, OS version, serial                  |

## Troubleshooting

**`adb: command not found`** — ADB is not installed or not in PATH. Run `npm run check-deps` for platform-specific install instructions.

**`Connection refused` / device not showing in `adb devices`** — ADB debugging may not be enabled, or the TV is on a different subnet. Check Developer Options and verify the IP.

**Device shows as `unauthorized`** — Accept the "Allow USB debugging?" dialog on the TV screen. If no dialog appears, toggle ADB debugging off then back on.

**`adb connect` keeps disconnecting** — Some Fire TV models drop the ADB connection when the screen turns off. Wake the TV first, or disable the screensaver.
