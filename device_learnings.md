# Device Learnings

Accumulated notes from real device testing. Updated over time as new devices are added and quirks are discovered. Nuances are everything in TV control.

---

## General MCP Setup (Windows)

- **MCP servers load at session start.** Adding a new server mid-session requires restarting Claude Code before its tools appear.
- **Code changes also require a restart.** The server process is long-running; edited Python/JS files aren't picked up until the process restarts.
- **`claude mcp add` must run from the project directory.** It scopes config to the current working directory. Running from a subdirectory creates a scoped config that only applies there.
- **Long commands wrap in the Claude Code prompt.** Paste multi-flag `mcp add` commands by running `! claude mcp add ...` from the terminal instead of typing them in chat — line wrapping corrupts the command.
- **Python scripts installed by pip aren't in PATH on Windows.** After `pip install pyatv`, `atvremote.exe` lands in `%LOCALAPPDATA%\Packages\PythonSoftwareFoundation.Python.3.12_*\LocalCache\local-packages\Python312\Scripts\`. Use the full path or add that directory to PATH.
- **Env vars must be passed explicitly with `-e`.** If the MCP server is launched without a working directory set, `.env` files in the project won't load. Pass critical env vars inline: `claude mcp add ... -e FIRETV_IP=x.x.x.x`.

---

## Network Topology

| Device | Subnet | Notes |
|--------|--------|-------|
| Fire TV | 192.168.4.x | ADB port 5555 |
| Apple TV ("Family Room") | 192.168.4.x | Same subnet as Fire TV |
| Samsung TV (QN55S95FAFXZA) | 192.168.6.x | WebSocket port 8002 |
| AMBEO Soundbar | 192.168.6.x | AirPlay target for Samsung |

- Mesh network with multiple subnets. Cross-subnet directed broadcasts (`192.168.x.255`) may be blocked by the mesh router even if intra-subnet broadcast works.
- WoL magic packets must target the device's own subnet broadcast — `255.255.255.255` won't cross subnets on most mesh systems.

---

## Fire TV

### ADB & Connectivity
- ADB over TCP on port 5555. Enable via: **Settings → My Fire TV → Developer Options → ADB Debugging + Network Debugging**.
- ADB must connect before any shell command will work. First connect can take several seconds; retry logic in the client handles transient failures.

### Key Presses
- `KEYCODE_MEDIA_PAUSE` and `KEYCODE_MEDIA_PLAY` are separate keys from `KEYCODE_MEDIA_PLAY_PAUSE`. All three must be in the keymap; different apps respond to different codes.
- `KEYCODE_MEDIA_REWIND` and `KEYCODE_MEDIA_FAST_FORWARD` each skip **15 seconds** on YouTube (not 30). Confirmed by on-screen skip icon during testing.
- Always end a rewind/fast-forward sequence with a `PLAY` keypress. Seeking leaves playback paused on YouTube; it does not auto-resume.

### Screenshots
- The MCP `screenshot` tool returns ~1.8 MB base64, which exceeds context limits. Don't use it for AI analysis.
- **Working pattern:** `adb exec-out screencap -p > D:/tmp_screen.png` then read the file with the `Read` tool.
- On Windows Git Bash, use `exec-out` not `adb shell screencap /sdcard/... && adb pull ...` — the exec-out pattern is one step and avoids filesystem permission issues.

### UI Introspection
- `uiautomator dump` works for native Fire TV apps but **fails silently on Cobalt-based apps** (YouTube, Netflix). These apps don't expose UI hierarchy. Use screenshots + d-pad navigation instead.

### Volume
- Fire TV volume control via ADB keycodes (`KEYCODE_VOLUME_UP/DOWN`) **does not work** when audio routes through HDMI to an external receiver. Fire TV uses `HdmiControlManager` for CEC volume, which requires system-level permissions not available to ADB shell. Volume control is a known limitation unless the Fire TV app is installed on the device itself.

---

## Samsung TV (Tizen / QN55S95FAFXZA, 2025 QLED OLED)

### API Architecture
- **Control:** WebSocket on port 8002 (WSS). Samsung requires token auth; first connect triggers an on-screen permission prompt. Token is valid for subsequent sessions and should be persisted in `.env`.
- **Discovery:** REST on port 8001. Returns device name, model, IP, `wifiMac`, `networkType`, capabilities.
- The REST endpoint is only reachable when the TV is **on**. It doesn't respond in standby.

### Token Persistence
- On first WebSocket connect, Samsung shows "Allow Remote Access?" on screen. User must accept on the TV (not a PIN — just OK).
- Accepted token must be saved in `.env` as `SAMSUNG_TV_TOKEN`. Without it, every session re-prompts.
- Auto-persist pattern: write token to `.env` on successful auth, read it on startup.

### Input Switching (Newer Tizen Models)
- `KEY_HDMI1`, `KEY_HDMI2`, `KEY_HDMI3`, `KEY_HDMI4` **do not work** on 2025 Tizen models. Direct HDMI keycodes are no longer supported.
- **Working approach:** `KEY_SOURCE` → `KEY_RIGHT` → `KEY_UP` → `KEY_ENTER` — always switches to the most recently used other input.
- Grid layout (2-column, **dynamic** — changes based on connected devices and last-used source):
  - Row 0: TV | [most recently used non-current input]
  - Row 1: [**current active input** — always focused on open] | Help
  - Row 2: External Devices | Setup Universal Remote
- The current input is **always focused** when the grid opens. The last-used other input is always at (0,1) — one RIGHT, one UP.
- `switch_input` effectively **toggles** between the two most recently used inputs. It cannot target an arbitrary input without manual `send_key` navigation.
- For reliable arbitrary input switching, use SmartThings `setInputSource` with the exact input ID (`dtv`, `HDMI2`, `HDMI3`) when a valid token is available.
- For input switching without SmartThings, use HDMI CEC: waking the Fire TV (`KEYCODE_WAKEUP`) or Apple TV (`power on`) sends CEC "Active Source" which switches the Samsung TV to that device's input automatically. Requires **Anynet+ (HDMI-CEC)** enabled on the Samsung: Settings → General & Privacy → External Device Manager → Anynet+.
- **Do not try to reset to top-left** (UP×N + LEFT×N). Samsung's grid **wraps at the edges** — overshooting lands in unexpected positions.
- **Pressing RIGHT from the rightmost column flips to page 2** — easy to overshoot if navigating beyond col 1.
- The grid times out after ~3 seconds of inactivity. Continuous key presses keep it open.
- **Samsung TV has no screenshot API.** Navigation is completely blind. Without visual feedback, complex multi-step grid navigation is unreliable — stick to the confirmed 3-key toggle sequence.

### Wake-on-LAN
- This model has a **built-in SmartThings hub** that keeps the WiFi interface active in standby. WoL works over WiFi on this TV despite the `networkType: wireless` REST field.
- Send a **burst of 16 magic packets at ~100ms spacing** — the community-recommended approach for reliability.
- "Power On with Mobile" must be enabled: **Settings → General → Network → Expert Settings → Power On with Mobile**.
- Power **off** works fine via WebSocket `KEY_POWER`.

### IP Remote / Port 55000
- The TV shows a setting called "IP Remote" (off by default). Turning it on does **not** open port 55000 locally. This is for Samsung SmartThings cloud connectivity, not direct LAN TCP access.

### Volume
- Direct volume control via WebSocket keycodes is unreliable on this model.
- The AMBEO Soundbar (192.168.6.210) handles audio output. The TV passes volume CEC to the soundbar.

### SmartThings Integration
- The TV registers as two SmartThings devices: **"55" OLED"** (the controllable TV device) and **"Hub - 55" OLED"** (the built-in SmartThings hub, always connected).
- The controllable TV device (`55" OLED`) can go offline in SmartThings even while physically on. Fix: **Settings → All Settings → Connection → SmartThings** → sign out and back in.
- SmartThings Personal Access Tokens (PATs) from `account.smartthings.com/tokens` **expire after 24 hours** as of December 2024. OAuth is required for long-lived access but Samsung's developer portal does not support personal-use OAuth app registration without a full production app submission. The SmartThings CLI `apps:create` command has a bug (`Invalid URL`) on the current version.
- **Standard `mediaInputSource` capability returns empty values** on this TV. Use `samsungvd.mediaInputSource` instead — it returns `supportedInputSourcesMap` with real input IDs (`dtv`, `HDMI2`, `HDMI3`) and the current `inputSource`.
- SmartThings `setInputSource` sends to `samsungvd.mediaInputSource` capability and is instant and reliable when the TV is online and the token is valid.
- Input switching via SmartThings returns `409 ConflictError: invalid device state` if the TV is offline in SmartThings (even if physically on) or if the PAT has expired.
- This TV's inputs: `dtv` (TV tuner/home screen), `HDMI2` (HDMI 2), `HDMI3` (labeled "SB02M" — the AMBEO soundbar).

---

## Apple TV (4K Gen 3, tvOS 26.3, "Family Room")

### Protocol & Pairing
- Uses **pyatv** (Python library) via the Companion protocol. Not ADB.
- Companion protocol requires **mandatory pairing** before any commands work.
- Two-step pairing flow:
  1. `start_pairing(protocol="Companion")` → triggers a 4-digit PIN on the Apple TV screen.
  2. `pair_apple_tv(pin=XXXX, protocol="Companion")` → completes pairing, saves credentials.
- Must also pair **AirPlay** separately to unlock: `list_apps`, `launch_app`, `get_current_app`, `get_now_playing`.
- After pairing a second protocol, the server must **reconnect** to pick up both credential sets. Without reconnect, app/metadata interfaces remain blocked. Fixed by calling `disconnect()` after `finish_pairing()` so the next command reconnects with all credentials.

### Credentials
- Stored in `pyatv_credentials.json` in the working directory (or `ATV_CREDENTIALS_PATH`).
- Credentials persist across sessions — no re-pairing needed unless the Apple TV is reset.
- The JSON file stores credentials keyed by protocol name (`AirPlay`, `Companion`).

### Volume
- `volume_up()` / `volume_down()` **work via HDMI-CEC** — the Apple TV sends CEC volume events that propagate through the Samsung TV to the AMBEO Soundbar. The volume indicator appears on the Samsung TV screen.
- `set_volume(level)` sets an internal pyatv level and does **not** send a CEC event. No audible change. Use step-based volume for real control.
- Multiple volume steps sent as separate tool calls have 200–500ms round-trip latency each. Use `press_keys("volume_down,volume_down,...")` once `volume_up`/`volume_down` are in the key map — all fire with 200ms spacing in a single call.
- pyatv has no discrete mute command. The `Audio` interface only exposes `volume_up`, `volume_down`, `set_volume`, and `volume`.

### App Control
- `list_apps()` returns bundle IDs and names for all installed apps.
- `launch_app(bundle_id)` works reliably (e.g., `com.amazon.aiv.AIVApp` for Prime Video).
- `get_current_app()` can be **stale** — may report the previously used app for a few seconds after switching.

### Metadata
- `get_now_playing()` returns title, device state (Playing/Paused/Idle), position, and total time when media is active.
- Returns nulls at the home screen or during app browsing (not an error — state is `DeviceState.Idle`).

### tvOS 26 Compatibility
- Apple switched to calendar-year tvOS versioning (tvOS 26 = 2026). pyatv 0.17.0 (latest as of testing) handles Companion and AirPlay pairing correctly.
- Some interfaces that report "blocked" may be tvOS version restrictions rather than missing pyatv support.

### Navigation Notes
- Blind navigation (repeated arrow keys without visual feedback) is unreliable — content placement in streaming apps is personalized and changes.
- Best approach: use `get_now_playing` or a screenshot (via AirPlay screen mirroring, not yet implemented) to get context before navigating.

---

## Round 1 Testing Summary (2026-03-31)

| Capability | Fire TV | Samsung TV | Apple TV |
|------------|---------|------------|----------|
| Discovery | ✅ ADB mDNS | ✅ REST scan | ✅ pyatv mDNS |
| Navigation | ✅ | ✅ | ✅ |
| Play/Pause | ✅ | ✅ | ✅ |
| Seek | ✅ 15s/press | N/A | ✅ via next/previous |
| Volume | ❌ CEC blocked | ⚠️ via soundbar CEC | ✅ via CEC |
| Launch App | ✅ by package | N/A | ✅ by bundle ID |
| List Apps | ✅ | N/A | ✅ |
| Now Playing | ✅ partial | N/A | ✅ full metadata |
| Input Switch | N/A | ⚠️ grid nav only | N/A |
| Power Off | ✅ sleep keycode | ✅ KEY_POWER | ✅ turn_off |
| Power On (WoL) | ✅ via ADB connect | ❌ WiFi only | ✅ via CEC from Samsung |
| Screenshots | ✅ via exec-out | ❌ not supported | ❌ not yet |
