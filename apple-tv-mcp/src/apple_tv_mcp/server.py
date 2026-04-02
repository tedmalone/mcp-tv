"""Apple TV MCP server — stdio transport, powered by pyatv."""

from __future__ import annotations

import json
import logging
import os
import sys

from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

from .atv_client import AtvClient

# Configure logging to stderr (stdout is the MCP transport)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("apple-tv-mcp")

load_dotenv()

# -- Config from environment --
ATV_IP = os.getenv("ATV_IP") or None
ATV_NAME = os.getenv("ATV_NAME") or None
CREDENTIALS_PATH = os.getenv("ATV_CREDENTIALS_PATH", "pyatv_credentials.json")


def _env_int(name: str, fallback: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return fallback
    try:
        value = int(raw)
        return value if value > 0 else fallback
    except ValueError:
        return fallback


DEFAULT_DISCOVERY_TIMEOUT_SECONDS = _env_int("ATV_DISCOVERY_TIMEOUT_SECONDS", 5)

client = AtvClient(ip=ATV_IP, name=ATV_NAME, credentials_path=CREDENTIALS_PATH)

mcp = FastMCP("apple-tv-mcp")


# ---- Discovery ----


@mcp.tool()
async def discover(timeout_seconds: int = DEFAULT_DISCOVERY_TIMEOUT_SECONDS) -> str:
    """Discover Apple TVs on the local network.

    Args:
        timeout_seconds: Discovery timeout in seconds (default 5)
    """
    try:
        devices = await client.discover(timeout=max(1, timeout_seconds))
        return json.dumps(devices, indent=2)
    except Exception as e:
        return f"Discover failed: {e}"


# ---- Power ----


@mcp.tool()
async def power(action: str) -> str:
    """Turn the Apple TV on or off.

    Powering on sends an HDMI CEC 'Active Source' signal via pyatv, which causes
    the Samsung TV to automatically switch to the Apple TV input — no manual
    input switching needed if CEC is enabled on both devices.

    Args:
        action: 'on' to wake the Apple TV, 'off' to put it to sleep
    """
    if action not in ("on", "off"):
        return f"Invalid action '{action}'. Use 'on' or 'off'."
    try:
        if action == "on":
            await client.power_on()
            return (
                "Apple TV powering on.\n"
                "HDMI CEC Active Source sent — Samsung TV should switch to Apple TV input automatically."
            )
        else:
            await client.power_off()
            return "Apple TV powering off."
    except Exception as e:
        return f"Power {action} failed: {e}"


# ---- Volume ----


@mcp.tool()
async def set_volume(level: float) -> str:
    """Set the Apple TV volume to a specific level (0-100).

    Args:
        level: Volume level from 0.0 to 100.0
    """
    try:
        await client.set_volume(level)
        return f"Volume set to {level}."
    except Exception as e:
        return f"Set volume failed: {e}"


@mcp.tool()
async def get_volume() -> str:
    """Get the current volume level."""
    try:
        vol = await client.get_volume()
        return json.dumps({"volume": vol})
    except Exception as e:
        return f"Get volume failed: {e}"


@mcp.tool()
async def volume_step(direction: str) -> str:
    """Step the volume up or down by one increment via CEC.

    Args:
        direction: 'up' for volume up, 'down' for volume down
    """
    try:
        if direction == "up":
            await client.volume_up()
            return "Volume up."
        elif direction == "down":
            await client.volume_down()
            return "Volume down."
        else:
            return f"Invalid direction '{direction}'. Use 'up' or 'down'."
    except Exception as e:
        return f"Volume step failed: {e}"


# ---- Navigation / Remote ----


@mcp.tool()
async def press_key(key: str) -> str:
    """Simulate a remote button press on the Apple TV.

    Args:
        key: Button name — up, down, left, right, select, enter, menu, back, home, play, pause, play_pause, stop, next, previous, top_menu, screensaver, volume_up, volume_down
    """
    try:
        await client.press_key(key)
        return f"Key '{key}' pressed."
    except ValueError as e:
        return str(e)
    except Exception as e:
        return f"Press key failed: {e}"


@mcp.tool()
async def press_keys(keys: str, delay_ms: int = 200) -> str:
    """Send a sequence of key presses with a delay between each.

    Args:
        keys: Comma-separated list of key names (e.g., "down,down,select")
        delay_ms: Delay between keys in milliseconds (default 200)
    """
    import asyncio

    key_list = [k.strip() for k in keys.split(",") if k.strip()]
    results = []
    try:
        for key in key_list:
            await client.press_key(key)
            results.append(key)
            if delay_ms > 0:
                await asyncio.sleep(delay_ms / 1000.0)
        return f"Keys pressed: {', '.join(results)}"
    except Exception as e:
        return f"Failed after pressing {results}: {e}"


# ---- Navigation shortcuts ----


@mcp.tool()
async def go_home() -> str:
    """Navigate to the Apple TV home screen."""
    try:
        await client.press_key("home")
        return "Home button pressed."
    except Exception as e:
        return f"Go home failed: {e}"


@mcp.tool()
async def go_back() -> str:
    """Press the Back/Menu button on the Apple TV."""
    try:
        await client.press_key("menu")
        return "Menu/Back button pressed."
    except Exception as e:
        return f"Go back failed: {e}"


# ---- Apps ----


@mcp.tool()
async def launch_app(app: str) -> str:
    """Launch an app by bundle ID or URL on the Apple TV.

    Args:
        app: App bundle ID (e.g., 'com.netflix.Netflix') or URL scheme
    """
    try:
        await client.launch_app(app)
        return f"Launched '{app}'."
    except Exception as e:
        return f"Launch app failed: {e}"


@mcp.tool()
async def list_apps() -> str:
    """List all installed apps on the Apple TV."""
    try:
        apps = await client.list_apps()
        return json.dumps(apps, indent=2)
    except Exception as e:
        return f"List apps failed: {e}"


@mcp.tool()
async def get_current_app() -> str:
    """Get the currently running foreground app."""
    try:
        app = await client.get_current_app()
        return json.dumps(app)
    except Exception as e:
        return f"Get current app failed: {e}"


# ---- Deep linking ----


@mcp.tool()
async def deep_link(uri: str) -> str:
    """Open a deep link URL on the Apple TV.

    Args:
        uri: URL to open (e.g., 'https://tv.apple.com/show/...')
    """
    try:
        await client.launch_app(uri)
        return f"Opened '{uri}'."
    except Exception as e:
        return f"Deep link failed: {e}"


# ---- Text input ----


@mcp.tool()
async def type_text(text: str, append: bool = False) -> str:
    """Type text into the currently focused input field on the Apple TV.

    Args:
        text: Text to type
        append: If true, append to existing text instead of replacing (default false)
    """
    try:
        await client.type_text(text, append=append)
        return f"Text {'appended' if append else 'set'}: '{text}'"
    except Exception as e:
        return f"Type text failed: {e}"


# ---- Now playing (bonus — Apple TV exclusive) ----


@mcp.tool()
async def get_now_playing() -> str:
    """Get metadata about what's currently playing (title, artist, position, etc.)."""
    try:
        info = await client.get_now_playing()
        return json.dumps(info, indent=2)
    except Exception as e:
        return f"Get now playing failed: {e}"


# ---- Pairing (setup tool) ----


@mcp.tool()
async def pair_apple_tv(pin: int, protocol: str = "AirPlay") -> str:
    """Complete pairing with the Apple TV using the PIN shown on screen.

    Args:
        pin: 4-digit PIN displayed on the Apple TV
        protocol: Protocol to pair — 'AirPlay' or 'Companion' (default 'AirPlay')
    """
    from pyatv.const import Protocol as P

    proto_map = {"airplay": P.AirPlay, "companion": P.Companion}
    proto = proto_map.get(protocol.lower())
    if proto is None:
        return f"Unknown protocol '{protocol}'. Use 'AirPlay' or 'Companion'."
    try:
        creds = await client.finish_pairing(proto, pin)
        return f"Paired successfully via {protocol}. Credentials saved."
    except Exception as e:
        return f"Pairing failed: {e}"


@mcp.tool()
async def start_pairing(protocol: str = "AirPlay") -> str:
    """Start the pairing process. The Apple TV will display a PIN.

    Args:
        protocol: Protocol to pair — 'AirPlay' or 'Companion' (default 'AirPlay')
    """
    from pyatv.const import Protocol as P

    proto_map = {"airplay": P.AirPlay, "companion": P.Companion}
    proto = proto_map.get(protocol.lower())
    if proto is None:
        return f"Unknown protocol '{protocol}'. Use 'AirPlay' or 'Companion'."
    try:
        await client.pair(proto)
        return (
            f"Pairing started for {protocol}. "
            "A PIN should appear on your Apple TV. "
            "Use the pair_apple_tv tool with that PIN to complete pairing."
        )
    except Exception as e:
        return f"Start pairing failed: {e}"


def main() -> None:
    """Entry point for the apple-tv-mcp CLI."""
    logger.info("Starting Apple TV MCP server (stdio)")
    if ATV_IP:
        logger.info("  Apple TV IP: %s", ATV_IP)
    else:
        logger.info("  Apple TV IP: auto-discover")
    if ATV_NAME:
        logger.info("  Apple TV name filter: %s", ATV_NAME)
    logger.info("  Credentials: %s", CREDENTIALS_PATH)

    try:
        mcp.run(transport="stdio")
    except Exception as e:  # noqa: BLE001
        logger.error("Startup failure: %s", e)
        raise


if __name__ == "__main__":
    main()
