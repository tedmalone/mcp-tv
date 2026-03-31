"""Unit tests for AtvClient — no real Apple TV required."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from apple_tv_mcp.atv_client import AtvClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_client(tmp_path: Path, ip: str | None = "192.168.1.101") -> AtvClient:
    """Return a client configured to use a temp credentials file."""
    creds_file = tmp_path / "pyatv_credentials.json"
    return AtvClient(ip=ip, credentials_path=str(creds_file))


# ---------------------------------------------------------------------------
# Credential persistence — _load_credentials
# ---------------------------------------------------------------------------


class TestLoadCredentials:
    def test_loads_valid_json(self, tmp_path: Path) -> None:
        creds_file = tmp_path / "creds.json"
        creds_file.write_text(json.dumps({"AirPlay": "abc123", "Companion": "xyz789"}))

        client = AtvClient(credentials_path=str(creds_file))
        assert client._stored_credentials == {"AirPlay": "abc123", "Companion": "xyz789"}

    def test_silently_ignores_missing_file(self, tmp_path: Path) -> None:
        missing = tmp_path / "nonexistent.json"
        client = AtvClient(credentials_path=str(missing))
        assert client._stored_credentials == {}

    def test_handles_corrupt_json_gracefully(self, tmp_path: Path) -> None:
        creds_file = tmp_path / "bad.json"
        creds_file.write_text("{this is not valid json")

        client = AtvClient(credentials_path=str(creds_file))
        assert client._stored_credentials == {}


# ---------------------------------------------------------------------------
# Credential persistence — _save_credentials
# ---------------------------------------------------------------------------


class TestSaveCredentials:
    def test_writes_credentials_to_file(self, tmp_path: Path) -> None:
        client = make_client(tmp_path)
        client._stored_credentials = {"AirPlay": "token123"}
        client._save_credentials()

        written = json.loads((tmp_path / "pyatv_credentials.json").read_text())
        assert written == {"AirPlay": "token123"}

    def test_overwrites_existing_file(self, tmp_path: Path) -> None:
        creds_file = tmp_path / "pyatv_credentials.json"
        creds_file.write_text(json.dumps({"AirPlay": "old"}))

        client = AtvClient(credentials_path=str(creds_file))
        client._stored_credentials = {"AirPlay": "new", "Companion": "also-new"}
        client._save_credentials()

        written = json.loads(creds_file.read_text())
        assert written["AirPlay"] == "new"
        assert written["Companion"] == "also-new"

    def test_write_error_does_not_raise(self, tmp_path: Path) -> None:
        client = make_client(tmp_path)
        client._stored_credentials = {"AirPlay": "x"}
        # Point to a path inside a nonexistent directory — write will fail
        client._credentials_path = tmp_path / "nodir" / "creds.json"
        client._save_credentials()  # should not raise


# ---------------------------------------------------------------------------
# press_key — key validation
# ---------------------------------------------------------------------------


class TestPressKey:
    VALID_KEYS = [
        "up", "down", "left", "right", "select", "enter",
        "menu", "back", "home", "play", "pause", "play_pause",
        "stop", "next", "previous", "top_menu", "screensaver",
    ]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("key", VALID_KEYS)
    async def test_valid_keys_call_remote_control(self, tmp_path: Path, key: str) -> None:
        client = make_client(tmp_path)
        mock_atv = MagicMock()
        mock_rc = MagicMock()
        # All rc methods are async
        for attr in ["up", "down", "left", "right", "select", "menu", "home",
                     "play", "pause", "play_pause", "stop", "next", "previous",
                     "top_menu", "screensaver"]:
            setattr(mock_rc, attr, AsyncMock())
        mock_atv.remote_control = mock_rc
        client._atv = mock_atv

        await client.press_key(key)  # should not raise

    @pytest.mark.asyncio
    async def test_invalid_key_raises_value_error(self, tmp_path: Path) -> None:
        client = make_client(tmp_path)
        mock_atv = MagicMock()
        mock_atv.remote_control = MagicMock()
        client._atv = mock_atv

        with pytest.raises(ValueError, match="Unknown key"):
            await client.press_key("turbo_boost")

    @pytest.mark.asyncio
    async def test_key_lookup_is_case_insensitive(self, tmp_path: Path) -> None:
        client = make_client(tmp_path)
        mock_atv = MagicMock()
        mock_rc = MagicMock()
        mock_rc.up = AsyncMock()
        mock_atv.remote_control = mock_rc
        client._atv = mock_atv

        await client.press_key("UP")  # should not raise


# ---------------------------------------------------------------------------
# discover — output normalisation
# ---------------------------------------------------------------------------


class TestDiscover:
    @pytest.mark.asyncio
    async def test_returns_normalised_metadata(self, tmp_path: Path) -> None:
        client = make_client(tmp_path, ip=None)

        mock_conf = MagicMock()
        mock_conf.name = "Living Room"
        mock_conf.address = "192.168.1.101"
        mock_device_info = MagicMock()
        mock_device_info.model = "AppleTV6,2"
        mock_device_info.mac = "aa:bb:cc:dd:ee:ff"
        mock_conf.device_info = mock_device_info
        mock_conf.get_service.return_value = None  # no credentials stored

        with patch("apple_tv_mcp.atv_client.pyatv.scan", new=AsyncMock(return_value=[mock_conf])):
            results = await client.discover()

        assert len(results) == 1
        r = results[0]
        assert r["brand"] == "apple_tv"
        assert r["ip"] == "192.168.1.101"
        assert r["name"] == "Living Room"
        assert r["model"] == "AppleTV6,2"
        assert r["status"] == "needs_auth"

    @pytest.mark.asyncio
    async def test_status_is_ready_when_credentials_present(self, tmp_path: Path) -> None:
        client = make_client(tmp_path, ip=None)

        mock_conf = MagicMock()
        mock_conf.name = "Bedroom TV"
        mock_conf.address = "192.168.1.102"
        mock_conf.device_info = None
        # Simulate stored credentials on a service
        mock_service = MagicMock()
        mock_service.credentials = "some-credential-string"
        mock_conf.get_service.return_value = mock_service

        with patch("apple_tv_mcp.atv_client.pyatv.scan", new=AsyncMock(return_value=[mock_conf])):
            results = await client.discover()

        assert results[0]["status"] == "ready"

    @pytest.mark.asyncio
    async def test_empty_result_when_no_devices_found(self, tmp_path: Path) -> None:
        client = make_client(tmp_path, ip=None)

        with patch("apple_tv_mcp.atv_client.pyatv.scan", new=AsyncMock(return_value=[])):
            results = await client.discover()

        assert results == []
