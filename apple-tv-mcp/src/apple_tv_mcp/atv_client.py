"""Wrapper around pyatv for Apple TV control."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import TYPE_CHECKING, Awaitable, Callable, Protocol as TypingProtocol, TypeVar

import pyatv
from pyatv.const import Protocol

logger = logging.getLogger(__name__)

CREDENTIALS_FILE = "pyatv_credentials.json"
T = TypeVar("T")


def _env_int(name: str, fallback: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return fallback
    try:
        value = int(raw)
        return value if value > 0 else fallback
    except ValueError:
        return fallback


def _env_float(name: str, fallback: float) -> float:
    raw = os.getenv(name)
    if not raw:
        return fallback
    try:
        value = float(raw)
        return value if value > 0 else fallback
    except ValueError:
        return fallback


# 5s is a good default for mDNS discovery on home LANs.
DEFAULT_DISCOVERY_TIMEOUT_SECONDS = 5
# Small retry count for transient wake/network blips.
DEFAULT_CONNECT_RETRIES = 3
DEFAULT_PAIR_RETRIES = 2
DEFAULT_DISCOVERY_RETRIES = 2
# Linear retry backoff base.
DEFAULT_RETRY_BASE_DELAY_SECONDS = 0.5

DISCOVERY_TIMEOUT_SECONDS = _env_int(
    "ATV_DISCOVERY_TIMEOUT_SECONDS", DEFAULT_DISCOVERY_TIMEOUT_SECONDS
)
CONNECT_RETRIES = _env_int("ATV_CONNECT_RETRIES", DEFAULT_CONNECT_RETRIES)
PAIR_RETRIES = _env_int("ATV_PAIR_RETRIES", DEFAULT_PAIR_RETRIES)
DISCOVERY_RETRIES = _env_int("ATV_DISCOVERY_RETRIES", DEFAULT_DISCOVERY_RETRIES)
RETRY_BASE_DELAY_SECONDS = _env_float(
    "ATV_RETRY_BASE_DELAY_SECONDS", DEFAULT_RETRY_BASE_DELAY_SECONDS
)

if TYPE_CHECKING:
    from pyatv.interface import AppleTV, BaseConfig
else:
    AppleTV = object
    BaseConfig = object


class PairingServiceProtocol(TypingProtocol):
    credentials: str | None


class PairingSessionProtocol(TypingProtocol):
    has_paired: bool
    service: PairingServiceProtocol

    async def begin(self) -> None: ...
    def pin(self, pin: int) -> None: ...
    async def finish(self) -> None: ...
    async def close(self) -> None: ...


class RemoteControlCallable(TypingProtocol):
    async def __call__(self) -> object: ...


class AtvClient:
    """Manages connection and commands to a single Apple TV."""

    def __init__(
        self,
        ip: str | None = None,
        name: str | None = None,
        credentials_path: str | None = None,
    ) -> None:
        self._ip = ip
        self._name = name
        self._credentials_path = Path(credentials_path or CREDENTIALS_FILE)
        self._atv: AppleTV | None = None
        self._active_pairing: PairingSessionProtocol | None = None
        self._stored_credentials: dict[str, str] = {}
        self._load_credentials()

    # -- Connection lifecycle --

    async def _with_retries(
        self, op_name: str, fn: Callable[[], Awaitable[T]], attempts: int = 3
    ) -> T:
        last_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                return await fn()
            except Exception as err:  # noqa: BLE001
                last_error = err
                if attempt < attempts:
                    logger.warning(
                        "%s failed (attempt %d/%d): %s",
                        op_name,
                        attempt,
                        attempts,
                        err,
                    )
                    await asyncio.sleep(RETRY_BASE_DELAY_SECONDS * attempt)
        assert last_error is not None
        raise last_error

    async def connect(self) -> None:
        """Discover and connect to the Apple TV."""
        if self._atv is not None:
            return

        async def _connect_once() -> None:
            loop = asyncio.get_event_loop()
            configs = await self._discover(loop)
            if not configs:
                raise ConnectionError(
                    "No Apple TV found on the network. Ensure it is awake and on the same subnet."
                )

            conf = configs[0]
            self._apply_credentials(conf)

            self._atv = await pyatv.connect(conf, loop)
            logger.info("Connected to %s (%s)", conf.name, conf.address)

        await self._with_retries("connect", _connect_once, attempts=CONNECT_RETRIES)

    async def disconnect(self) -> None:
        """Close the connection."""
        if self._atv is not None:
            self._atv.close()
            self._atv = None

    async def ensure_connected(self) -> AppleTV:
        """Return the connected AppleTV instance, connecting if needed."""
        if self._atv is None:
            await self.connect()
        assert self._atv is not None
        return self._atv

    # -- Pairing (interactive, for initial setup) --

    async def pair(self, protocol: Protocol = Protocol.AirPlay) -> str:
        """Start the pairing flow for a given protocol.

        Stores the pairing handler so finish_pairing() can reuse it.
        The caller must prompt the user for the PIN shown on the TV.
        """
        if self._active_pairing is not None:
            await self._active_pairing.close()
            self._active_pairing = None

        async def _pair_once() -> None:
            loop = asyncio.get_event_loop()
            configs = await self._discover(loop)
            if not configs:
                raise ConnectionError(
                    "No Apple TV found for pairing. Ensure the device is on and on the same subnet."
                )

            conf = configs[0]
            pairing = await pyatv.pair(conf, protocol, loop)
            await pairing.begin()
            self._active_pairing = pairing

        await self._with_retries("start_pairing", _pair_once, attempts=PAIR_RETRIES)

        return "AWAITING_PIN"

    async def finish_pairing(
        self,
        protocol: Protocol,
        pin: int,
    ) -> str:
        """Complete pairing after user enters PIN.

        Reuses the pairing handler from pair(). Returns credentials string.
        """
        pairing = self._active_pairing
        if pairing is None:
            raise RuntimeError(
                "No active pairing session. Call start_pairing first."
            )

        pairing.pin(pin)
        await pairing.finish()

        if not pairing.has_paired:
            await pairing.close()
            self._active_pairing = None
            raise RuntimeError("Pairing failed — PIN may be incorrect")

        creds = pairing.service.credentials
        if not creds:
            await pairing.close()
            self._active_pairing = None
            raise RuntimeError(
                "Pairing reported success but returned no credentials — pairing incomplete."
            )
        self._stored_credentials[protocol.name] = creds
        self._save_credentials()
        await pairing.close()
        self._active_pairing = None

        # Force reconnect so the next command picks up all paired credentials.
        await self.disconnect()

        logger.info("Paired %s, credentials saved", protocol.name)
        return creds

    # -- Power --

    async def power_on(self) -> None:
        atv = await self.ensure_connected()
        await atv.power.turn_on()

    async def power_off(self) -> None:
        atv = await self.ensure_connected()
        await atv.power.turn_off()

    # -- Audio --

    async def get_volume(self) -> float:
        atv = await self.ensure_connected()
        return atv.audio.volume

    async def set_volume(self, level: float) -> None:
        atv = await self.ensure_connected()
        await atv.audio.set_volume(level)

    async def volume_up(self) -> None:
        atv = await self.ensure_connected()
        await atv.audio.volume_up()

    async def volume_down(self) -> None:
        atv = await self.ensure_connected()
        await atv.audio.volume_down()

    # -- Remote control --

    async def press_key(self, key: str) -> None:
        atv = await self.ensure_connected()
        rc = atv.remote_control
        audio = atv.audio
        key_map: dict[str, RemoteControlCallable] = {
            "up": rc.up,
            "down": rc.down,
            "left": rc.left,
            "right": rc.right,
            "select": rc.select,
            "enter": rc.select,
            "menu": rc.menu,
            "back": rc.menu,
            "home": rc.home,
            "play": rc.play,
            "pause": rc.pause,
            "play_pause": rc.play_pause,
            "stop": rc.stop,
            "next": rc.next,
            "previous": rc.previous,
            "top_menu": rc.top_menu,
            "screensaver": rc.screensaver,
            "volume_up": audio.volume_up,
            "volume_down": audio.volume_down,
        }
        fn = key_map.get(key.lower())
        if fn is None:
            raise ValueError(
                f"Unknown key '{key}'. Valid: {', '.join(sorted(key_map))}"
            )
        await fn()

    # -- Apps --

    async def launch_app(self, app_id: str) -> None:
        atv = await self.ensure_connected()
        await atv.apps.launch_app(app_id)

    async def list_apps(self) -> list[dict[str, str]]:
        atv = await self.ensure_connected()
        apps = await atv.apps.app_list()
        return [{"name": a.name, "identifier": a.identifier} for a in apps]

    async def get_current_app(self) -> dict[str, str]:
        atv = await self.ensure_connected()
        app = atv.metadata.app
        if app is None:
            return {"name": "Unknown", "identifier": "unknown"}
        return {"name": app.name, "identifier": app.identifier}

    # -- Metadata --

    async def get_now_playing(self) -> dict[str, object]:
        atv = await self.ensure_connected()
        playing = await atv.metadata.playing()
        return {
            "title": playing.title,
            "artist": playing.artist,
            "album": playing.album,
            "genre": playing.genre,
            "media_type": str(playing.media_type),
            "device_state": str(playing.device_state),
            "position": playing.position,
            "total_time": playing.total_time,
        }

    # -- Keyboard / text input --

    async def type_text(self, text: str, append: bool = False) -> None:
        atv = await self.ensure_connected()
        if append:
            await atv.keyboard.text_append(text)
        else:
            await atv.keyboard.text_set(text)

    # -- Discovery helpers --

    async def _discover(
        self, loop: asyncio.AbstractEventLoop, timeout: int = DISCOVERY_TIMEOUT_SECONDS
    ) -> list[BaseConfig]:
        if self._ip:
            return await pyatv.scan(loop, hosts=[self._ip], timeout=timeout)
        atvs = await pyatv.scan(loop, timeout=timeout)
        if self._name:
            atvs = [a for a in atvs if a.name == self._name]
        return atvs

    async def discover(
        self, timeout: int = DISCOVERY_TIMEOUT_SECONDS
    ) -> list[dict[str, object]]:
        """Discover Apple TVs and return normalized setup metadata."""
        loop = asyncio.get_event_loop()
        configs = await self._with_retries(
            "discover",
            lambda: self._discover(loop, timeout=timeout),
            attempts=DISCOVERY_RETRIES,
        )
        results: list[dict[str, object]] = []
        for conf in configs:
            name = getattr(conf, "name", None) or "Apple TV"
            address = str(getattr(conf, "address", "") or "")
            model = None
            mac = None

            device_info = getattr(conf, "device_info", None)
            if device_info is not None:
                model = str(getattr(device_info, "model", "") or "") or None
                mac = str(getattr(device_info, "mac", "") or "") or None

            has_credentials = False
            for protocol in (Protocol.AirPlay, Protocol.Companion):
                service = conf.get_service(protocol)
                if service is not None and getattr(service, "credentials", None):
                    has_credentials = True
                    break

            results.append(
                {
                    "id": f"apple_tv:{address or name}",
                    "brand": "apple_tv",
                    "ip": address or None,
                    "name": name,
                    "model": model,
                    "mac": mac,
                    "status": "ready" if has_credentials else "needs_auth",
                    "confidence": "high",
                    "next_step": (
                        "Run control tools."
                        if has_credentials
                        else "Run start_pairing, then pair_apple_tv with the PIN shown on TV."
                    ),
                }
            )
        return results

    def _apply_credentials(self, conf: BaseConfig) -> None:
        """Apply stored credentials to a discovered config."""
        for proto_name, creds in self._stored_credentials.items():
            try:
                protocol = Protocol[proto_name]
                service = conf.get_service(protocol)
                if service is not None:
                    service.credentials = creds
            except (KeyError, AttributeError):
                pass

    # -- Credential persistence --

    def _load_credentials(self) -> None:
        if self._credentials_path.exists():
            try:
                self._stored_credentials = json.loads(
                    self._credentials_path.read_text()
                )
                logger.info(
                    "Loaded credentials for: %s",
                    ", ".join(self._stored_credentials.keys()),
                )
            except (json.JSONDecodeError, OSError) as e:
                logger.warning("Could not load credentials: %s", e)

    def _save_credentials(self) -> None:
        try:
            self._credentials_path.write_text(
                json.dumps(self._stored_credentials, indent=2)
            )
            logger.info("Credentials saved to %s", self._credentials_path)
        except OSError as e:
            logger.warning("Could not save credentials: %s", e)
