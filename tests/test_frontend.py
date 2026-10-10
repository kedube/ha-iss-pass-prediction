"""Tests for the globe card, the sidebar panel and their websocket API."""

from __future__ import annotations

from datetime import datetime, timedelta
import gzip
from pathlib import Path
from typing import Any

from freezegun.api import FrozenDateTimeFactory
from homeassistant.components.frontend import (
    DATA_EXTRA_MODULE_URL,
    DATA_PANELS,
    EVENT_PANELS_UPDATED,
)
from homeassistant.components.http.static import CACHE_HEADER
from homeassistant.config_entries import ConfigEntryDisabler, ConfigEntryState
from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
import pytest
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_capture_events,
    async_fire_time_changed,
)
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.iss_pass_prediction.const import (
    CONF_ALERT_LEAD_MINUTES,
    CONF_FORECAST_DAYS,
    CONF_MIN_VISIBLE_DURATION,
    CONF_SHOW_PANEL,
    DEFAULT_ALERT_LEAD_MINUTES,
    DOMAIN,
    FRONTEND_URL,
    PANEL_URL_PATH,
)
from custom_components.iss_pass_prediction.elements import CELESTRAK_URL, WHERETHEISS_URL
from custom_components.iss_pass_prediction.frontend import build_track_payload, pass_status

DENVER = {CONF_LATITUDE: 39.74, CONF_LONGITUDE: -104.99, CONF_ELEVATION: 1609.0}
FRONTEND = Path(__file__).parents[1] / "custom_components/iss_pass_prediction/frontend"
VENDOR = FRONTEND / "vendor/maplibre-gl-6.11.2"
VENDOR_FILES = (
    "maplibre-gl.mjs",
    "maplibre-gl-shared.mjs",
    "maplibre-gl-worker.mjs",
    "maplibre-gl.css",
)

# What the globe and the README's card read from the payload.
VISIBLE_PASS_KEYS = {
    "start",
    "end",
    "start_direction",
    "start_elevation",
    "peak_direction",
    "peak_elevation",
    "peak_azimuth",
    "end_direction",
    "duration_seconds",
    "magnitude",
    "disappears_into_shadow",
    "confidence",
}
NEXT_PASS_KEYS = {
    "rise",
    "set",
    "culmination",
    "culmination_elevation",
    "visible",
    "confidence",
    "qualifies",
    "reason",
    "visible_peak_elevation",
    "path",
}
REASONS = {"visible", "low", "brief", "shadow", "twilight", "daylight"}


async def _load(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    reference: dict[str, Any],
    omm_xml: bytes,
    options: dict[str, Any] | None = None,
) -> MockConfigEntry:
    freezer.move_to(datetime.fromisoformat(reference["start"]))
    aioclient_mock.get(CELESTRAK_URL, content=omm_xml)
    entry = MockConfigEntry(
        domain=DOMAIN, title="Home", data=DENVER, options=options or {}, unique_id="denver"
    )
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


@pytest.fixture
async def loaded(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    reference: dict[str, Any],
    omm_xml: bytes,
) -> MockConfigEntry:
    return await _load(hass, aioclient_mock, freezer, reference, omm_xml)


@pytest.fixture
async def loaded_month(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    reference: dict[str, Any],
    omm_xml: bytes,
) -> MockConfigEntry:
    """A location with the longest forecast window, whose passes outlast the elements."""
    return await _load(hass, aioclient_mock, freezer, reference, omm_xml, {CONF_FORECAST_DAYS: 30})


async def _advance(hass: HomeAssistant, freezer: FrozenDateTimeFactory, when: datetime) -> None:
    freezer.move_to(when)
    async_fire_time_changed(hass, when)
    await hass.async_block_till_done(wait_background_tasks=True)


async def test_card_files_are_served(
    hass: HomeAssistant, loaded: MockConfigEntry, hass_client
) -> None:
    urls = hass.data[DATA_EXTRA_MODULE_URL].urls
    card = next(u for u in urls if u.startswith(f"{FRONTEND_URL}/iss-globe-card.js?v="))

    client = await hass_client()
    for path in (
        card,
        f"{FRONTEND_URL}/iss-globe.js",
        f"{FRONTEND_URL}/iss-tracker-panel.js",
        f"{FRONTEND_URL}/vendor/maplibre-gl-6.11.2/maplibre-gl.mjs",
        f"{FRONTEND_URL}/vendor/maplibre-gl-6.11.2/maplibre-gl-shared.mjs",
        f"{FRONTEND_URL}/vendor/maplibre-gl-6.11.2/maplibre-gl-worker.mjs",
        f"{FRONTEND_URL}/vendor/maplibre-gl-6.11.2/maplibre-gl.css",
    ):
        resp = await client.get(path)
        assert resp.status == 200, path
        assert "javascript" in resp.content_type or path.endswith(".css"), path
    for width in (4096, 2048):
        resp = await client.get(f"{FRONTEND_URL}/img/black-marble-2016-{width}.jpg")
        assert resp.status == 200
        assert resp.content_type == "image/jpeg"


@pytest.mark.parametrize("name", VENDOR_FILES)
def test_gzip_copies_match(name: str) -> None:
    assert gzip.decompress((VENDOR / f"{name}.gz").read_bytes()) == (VENDOR / name).read_bytes()


@pytest.mark.parametrize("name", VENDOR_FILES)
def test_brotli_copies_match(name: str) -> None:
    brotli = pytest.importorskip("brotli")
    assert brotli.decompress((VENDOR / f"{name}.br").read_bytes()) == (VENDOR / name).read_bytes()


def test_only_vendor_files_are_precompressed() -> None:
    """A compressed copy is served instead of its source, so it must never go stale."""
    copies = {p for p in FRONTEND.rglob("*") if p.suffix in (".gz", ".br")}
    assert copies == {VENDOR / f"{n}{s}" for n in VENDOR_FILES for s in (".gz", ".br")}


async def test_long_lived_files_are_cached_and_compressed(
    hass: HomeAssistant, loaded: MockConfigEntry, hass_client
) -> None:
    client = await hass_client()
    resp = await client.get(
        f"{FRONTEND_URL}/vendor/maplibre-gl-6.11.2/maplibre-gl.mjs",
        headers={"Accept-Encoding": "gzip"},
    )
    assert resp.status == 200
    assert resp.headers["Content-Encoding"] == "gzip"
    assert resp.headers["Cache-Control"] == CACHE_HEADER
    assert "javascript" in resp.content_type
    assert await resp.read() == (VENDOR / "maplibre-gl.mjs").read_bytes()

    resp = await client.get(f"{FRONTEND_URL}/img/black-marble-2016-2048.jpg")
    assert resp.headers["Cache-Control"] == CACHE_HEADER
    # The integration's own modules are revalidated, so updates show at once.
    resp = await client.get(f"{FRONTEND_URL}/iss-globe.js")
    assert resp.status == 200
    assert "Cache-Control" not in resp.headers


async def test_sidebar_panel_follows_option(hass: HomeAssistant, loaded: MockConfigEntry) -> None:
    panel = hass.data[DATA_PANELS][PANEL_URL_PATH]
    assert panel.sidebar_title == "ISS Tracker"
    assert panel.sidebar_icon == "mdi:space-station"
    assert panel.config["_panel_custom"]["name"] == "iss-tracker-panel"
    # The panel pads itself for notches and the home indicator.
    assert panel.config["_panel_custom"]["handle_safe_area"] is True
    assert panel.require_admin is False

    # Reloading for any other change keeps the page, so nobody looking at it
    # is sent to the default dashboard.
    updates = async_capture_events(hass, EVENT_PANELS_UPDATED)
    hass.config_entries.async_update_entry(loaded, options={CONF_ALERT_LEAD_MINUTES: 20})
    await hass.async_block_till_done()
    hass.config_entries.async_update_entry(loaded, title="Back garden")
    await hass.async_block_till_done()
    assert loaded.state is ConfigEntryState.LOADED
    assert loaded.runtime_data.settings.alert_lead == timedelta(minutes=20)
    assert updates == []
    assert PANEL_URL_PATH in hass.data[DATA_PANELS]

    hass.config_entries.async_update_entry(loaded, options={CONF_SHOW_PANEL: False})
    await hass.async_block_till_done()
    assert PANEL_URL_PATH not in hass.data[DATA_PANELS]

    hass.config_entries.async_update_entry(loaded, options={CONF_SHOW_PANEL: True})
    await hass.async_block_till_done()
    assert PANEL_URL_PATH in hass.data[DATA_PANELS]

    # Disabling the location removes the page, enabling it brings it back.
    await hass.config_entries.async_set_disabled_by(loaded.entry_id, ConfigEntryDisabler.USER)
    await hass.async_block_till_done()
    assert PANEL_URL_PATH not in hass.data[DATA_PANELS]
    await hass.config_entries.async_set_disabled_by(loaded.entry_id, None)
    await hass.async_block_till_done()
    assert loaded.state is ConfigEntryState.LOADED
    assert PANEL_URL_PATH in hass.data[DATA_PANELS]

    await hass.config_entries.async_remove(loaded.entry_id)
    await hass.async_block_till_done()
    assert PANEL_URL_PATH not in hass.data[DATA_PANELS]


async def test_panel_while_setup_retries(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, hass_ws_client
) -> None:
    aioclient_mock.get(CELESTRAK_URL, status=500)
    aioclient_mock.get(WHERETHEISS_URL, status=500)
    entry = MockConfigEntry(domain=DOMAIN, title="Home", data=DENVER, unique_id="denver")
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_RETRY

    # The page is there, and says what it is waiting for.
    assert PANEL_URL_PATH in hass.data[DATA_PANELS]
    client = await hass_ws_client(hass)
    for request in ({}, {"entry_id": entry.entry_id}):
        await client.send_json_auto_id({"type": f"{DOMAIN}/track", **request})
        msg = await client.receive_json()
        assert not msg["success"]
        assert msg["error"]["code"] == "not_ready"
        assert "celestrak: HTTP 500" in msg["error"]["message"]

    # Disabling a location that is not loaded runs none of its hooks; the
    # page still goes.
    await hass.config_entries.async_set_disabled_by(entry.entry_id, ConfigEntryDisabler.USER)
    await hass.async_block_till_done()
    assert PANEL_URL_PATH not in hass.data[DATA_PANELS]
    await client.send_json_auto_id({"type": f"{DOMAIN}/track"})
    msg = await client.receive_json()
    assert msg["error"] == {"code": "location_disabled", "message": "This location is disabled"}


async def test_disabled_location_says_so(
    hass: HomeAssistant, loaded: MockConfigEntry, hass_ws_client
) -> None:
    """A card bound to a disabled location is told so, not to wait."""
    # (The location is loaded before the websocket client logs in, so its
    # token is not issued "after" the frozen clock.)
    home = loaded
    cabin = MockConfigEntry(
        domain=DOMAIN,
        title="Cabin",
        data={CONF_LATITUDE: 44.0, CONF_LONGITUDE: -71.5, CONF_ELEVATION: 300.0},
        unique_id="cabin",
    )
    cabin.add_to_hass(hass)
    await hass.config_entries.async_setup(cabin.entry_id)
    await hass.async_block_till_done()
    assert home.state is cabin.state is ConfigEntryState.LOADED
    await hass.config_entries.async_set_disabled_by(cabin.entry_id, ConfigEntryDisabler.USER)
    await hass.async_block_till_done()

    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/track", "entry_id": cabin.entry_id})
    msg = await client.receive_json()
    assert msg["error"] == {"code": "location_disabled", "message": "This location is disabled"}

    # The card's retry recovers once the location is enabled again.
    await hass.config_entries.async_set_disabled_by(cabin.entry_id, None)
    await hass.async_block_till_done()
    await client.send_json_auto_id({"type": f"{DOMAIN}/track", "entry_id": cabin.entry_id})
    msg = await client.receive_json()
    assert msg["success"]
    assert msg["result"]["location"]["title"] == "Cabin"


async def test_low_pass_reports_its_visible_peak(
    hass: HomeAssistant, loaded: MockConfigEntry, freezer: FrozenDateTimeFactory
) -> None:
    """A pass can climb high in Earth's shadow and be seen only low down.

    Denver, 2026-10-19: the station culminates at about 68 degrees, but it is
    seen only after it leaves Earth's shadow, for 40 s, up to 15 degrees.
    """
    when = datetime.fromisoformat("2026-10-19T03:00:00+00:00")
    await _advance(hass, freezer, when)
    coordinator = loaded.runtime_data
    payload = build_track_payload(coordinator)
    next_pass = payload["next_pass"]
    minimum = payload["settings"]["min_peak_elevation"]
    assert next_pass["reason"] == "low"
    assert next_pass["culmination_elevation"] >= minimum
    q = coordinator.next_pass(when)
    assert q.visible is not None
    assert next_pass["visible_peak_elevation"] == int(q.visible.peak.elevation * 10) / 10
    assert next_pass["visible_peak_elevation"] < minimum


async def test_existing_dashboard_keeps_its_address(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    reference: dict[str, Any],
    omm_xml: bytes,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A dashboard at /iss-tracker must not stop the location from setting up."""
    hass_storage["lovelace_dashboards"] = {
        "version": 1,
        "minor_version": 1,
        "key": "lovelace_dashboards",
        "data": {
            "items": [
                {
                    "id": "iss_tracker",
                    "url_path": PANEL_URL_PATH,
                    "title": "ISS Tracker",
                    "icon": "mdi:space-station",
                    "show_in_sidebar": True,
                    "require_admin": False,
                    "mode": "storage",
                }
            ]
        },
    }
    assert await async_setup_component(hass, "lovelace", {})
    assert hass.data[DATA_PANELS][PANEL_URL_PATH].component_name == "lovelace"

    entry = await _load(hass, aioclient_mock, freezer, reference, omm_xml)
    assert entry.state is ConfigEntryState.LOADED
    assert hass.data[DATA_PANELS][PANEL_URL_PATH].component_name == "lovelace"
    assert caplog.text.count("is already used by another dashboard or panel") == 1

    # The location works: its sensors follow the first visible pass.
    v = entry.runtime_data.data.visible_passes[0].visible
    lead = timedelta(minutes=DEFAULT_ALERT_LEAD_MINUTES)
    await _advance(hass, freezer, v.start.time - lead + timedelta(seconds=1))
    assert hass.states.get("binary_sensor.home_visible_pass_soon").state == "on"
    await _advance(hass, freezer, v.start.time + timedelta(seconds=1))
    assert hass.states.get("binary_sensor.home_visible_now").state == "on"

    # Reloading and unloading leave the dashboard alone, without errors.
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.NOT_LOADED
    assert hass.data[DATA_PANELS][PANEL_URL_PATH].component_name == "lovelace"
    assert caplog.text.count("is already used by another dashboard or panel") == 1


async def test_track_websocket(
    hass: HomeAssistant, loaded: MockConfigEntry, hass_ws_client, reference: dict[str, Any]
) -> None:
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/locations"})
    locations = (await client.receive_json())["result"]
    assert locations == [{"entry_id": loaded.entry_id, "title": "Home", "show_in_sidebar": True}]

    await client.send_json_auto_id({"type": f"{DOMAIN}/track", "entry_id": loaded.entry_id})
    msg = await client.receive_json()
    assert msg["success"], msg
    result = msg["result"]

    now = datetime.fromisoformat(reference["start"]).timestamp()
    assert result["server_time"] == pytest.approx(now, abs=1)
    assert result["paused"] is None
    assert result["location"]["latitude"] == DENVER[CONF_LATITUDE]
    assert result["settings"] == {
        "min_elevation": 10.0,
        "min_peak_elevation": 20.0,
        "max_sun_elevation": -6.0,
        "min_visible_duration": 60.0,
        "forecast_days": 10,
    }
    assert result["elements"]["source"] == "celestrak"
    assert result["elements"]["age_days"] == pytest.approx(1 / 24, abs=0.01)

    track = result["track"]
    assert len(track) == 301  # 50 minutes back and 100 ahead, every 30 s
    assert track[0][0] == pytest.approx(now - 50 * 60, abs=1)
    assert track[-1][0] == pytest.approx(now + 100 * 60, abs=1)
    # Whole seconds stay integers.
    assert all(isinstance(row[0], int) for row in track)
    for _t, lat, lon, alt, lit in track:
        assert -52 < lat < 52 and -180 <= lon <= 180 and 380 < alt < 460 and lit in (0, 1)
    # The track crosses into and out of Earth's shadow at least once per orbit.
    assert {row[4] for row in track} == {0, 1}

    nxt = result["next_visible_pass"]
    assert nxt is not None
    assert nxt.keys() >= VISIBLE_PASS_KEYS | {"path"}
    assert result["upcoming_visible_passes"]
    for item in result["upcoming_visible_passes"]:
        assert item.keys() >= VISIBLE_PASS_KEYS
    assert result["upcoming_visible_passes"][0]["start"] == nxt["start"]
    assert result["next_pass"]["rise"] <= nxt["start"]

    # The next pass over home carries its path from rise to set (for the
    # intercept), and why it does or does not count as visible.
    nxt_pass = result["next_pass"]
    assert nxt_pass.keys() >= NEXT_PASS_KEYS
    assert nxt_pass["reason"] in REASONS
    assert nxt_pass["qualifies"] is (nxt_pass["reason"] == "visible")
    # Path rows are labelled with the instant they were computed for, to the
    # millisecond (the rise is not on a whole second).
    exact = loaded.runtime_data.next_pass(datetime.fromisoformat(reference["start"])).rise.time
    path = nxt_pass["path"]
    assert path[0][0] == round(exact.timestamp(), 3)
    assert path[1][0] == pytest.approx(path[0][0] + 10, abs=0.001)
    set_ = datetime.fromisoformat(nxt_pass["set"]).timestamp()
    assert path[-1][0] <= set_ + 1


async def test_pass_status_explains_every_pass(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    reference: dict[str, Any],
    omm_xml: bytes,
) -> None:
    entry = await _load(
        hass, aioclient_mock, freezer, reference, omm_xml, {CONF_MIN_VISIBLE_DURATION: 300}
    )
    coordinator = entry.runtime_data
    predictor = coordinator.live_predictor
    settings = coordinator.settings
    seen = set()
    for p in coordinator.data.passes:
        reason = pass_status(coordinator, predictor, p)
        seen.add(reason)
        v = p.visible
        culmination = p.culmination.time
        match reason:
            case "visible":
                assert p in coordinator.data.visible_passes
            case "low":
                assert v is not None
                assert v.peak.elevation < settings.min_peak_elevation
            case "brief":
                assert v is not None
                assert v.peak.elevation >= settings.min_peak_elevation
                assert v.duration_s < settings.min_visible_duration
            case "shadow":
                assert v is None
                assert not predictor.is_sunlit(culmination)
            case "twilight":
                assert v is None
                assert predictor.is_sunlit(culmination)
                assert settings.max_sun_elevation < predictor.sun_elevation(culmination) <= 0
            case "daylight":
                assert v is None
                assert predictor.is_sunlit(culmination)
                assert predictor.sun_elevation(culmination) > 0
    assert seen == REASONS


async def test_paused_predictions(
    hass: HomeAssistant,
    loaded_month: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    hass_ws_client,
    reference: dict[str, Any],
) -> None:
    loaded = loaded_month
    client = await hass_ws_client(hass)
    aioclient_mock.clear_requests()
    aioclient_mock.get(CELESTRAK_URL, status=503)
    aioclient_mock.get(WHERETHEISS_URL, status=503)
    later = datetime.fromisoformat(reference["start"]) + timedelta(days=15)
    freezer.move_to(later)
    # Passes predicted from these elements are still to come.
    assert loaded.runtime_data.next_pass(later) is not None

    # Past the age limit, even before the next refresh notices.
    payload = build_track_payload(loaded.runtime_data)
    assert payload["paused"] == "Orbit data is 15 days old"
    assert payload["next_visible_pass"] is None
    assert payload["upcoming_visible_passes"] == []
    assert payload["next_pass"] is None
    assert len(payload["track"]) == 301

    # The refresh fails, and its reason is passed on.
    async_fire_time_changed(hass, later)
    await hass.async_block_till_done(wait_background_tasks=True)
    assert not loaded.runtime_data.last_update_success
    await client.send_json_auto_id({"type": f"{DOMAIN}/track"})
    msg = await client.receive_json()
    assert msg["success"], msg
    paused = msg["result"]["paused"]
    assert "15 days old and could not be refreshed" in paused
    assert "celestrak: HTTP 503" in paused
    assert msg["result"]["next_pass"] is None
    assert len(msg["result"]["track"]) == 301

    # Nor can a pass be previewed from them.
    await client.send_json_auto_id(
        {
            "type": f"{DOMAIN}/path",
            "start": later.isoformat(),
            "end": (later + timedelta(hours=2)).isoformat(),
        }
    )
    msg = await client.receive_json()
    assert msg["error"] == {"code": "stale_elements", "message": paused}


async def test_track_websocket_errors(
    hass: HomeAssistant, loaded: MockConfigEntry, hass_ws_client
) -> None:
    client = await hass_ws_client(hass)

    async def error(request: dict[str, Any]) -> dict[str, Any]:
        await client.send_json_auto_id(request)
        msg = await client.receive_json()
        assert not msg["success"]
        return msg["error"]

    for kind in ("track", "path"):
        request = {
            "type": f"{DOMAIN}/{kind}",
            "entry_id": "nope",
            "start": "2026-10-10T00:00:00+00:00",
            "end": "2026-10-10T01:00:00+00:00",
        }
        if kind == "track":
            del request["start"], request["end"]
        assert (await error(request))["code"] == "unknown_location"

    await hass.config_entries.async_remove(loaded.entry_id)
    await hass.async_block_till_done()
    assert (await error({"type": f"{DOMAIN}/track", "entry_id": loaded.entry_id}))[
        "code"
    ] == "not_found"
    assert (await error({"type": f"{DOMAIN}/track"}))["code"] == "not_found"


async def test_path_websocket(
    hass: HomeAssistant, loaded: MockConfigEntry, hass_ws_client, reference: dict[str, Any]
) -> None:
    client = await hass_ws_client(hass)
    start = datetime.fromisoformat(reference["start"])

    async def path(begin: Any, end: Any, **extra: Any) -> dict[str, Any]:
        await client.send_json_auto_id(
            {
                "type": f"{DOMAIN}/path",
                "start": begin if isinstance(begin, str) else begin.isoformat(),
                "end": end if isinstance(end, str) else end.isoformat(),
                **extra,
            }
        )
        return await client.receive_json()

    msg = await path(start, start + timedelta(hours=2), entry_id=loaded.entry_id, step=30)
    assert msg["success"], msg
    assert msg["result"]["step"] == 30
    track = msg["result"]["track"]
    assert len(track) == 241
    assert track[1][0] - track[0][0] == 30

    # Long spans are thinned to stay within the point limit. Any pass in the
    # longest forecast window can be previewed from now.
    for span in (timedelta(days=7), timedelta(days=30, hours=1)):
        msg = await path(start, start + span, step=5)
        assert msg["success"], msg
        assert len(msg["result"]["track"]) <= 6000
        assert msg["result"]["step"] > 5

    # Backwards, over-long, out-of-range and far-off windows are refused.
    for begin, end in (
        (start, start - timedelta(hours=1)),
        (start, start + timedelta(days=32)),
        ("9999-12-30T00:00:00+00:00", "9999-12-31T00:00:00+00:00"),
        ("9999-12-31T00:00:00+00:00", "9999-12-31T23:00:00-05:00"),
        ("0001-01-01T00:10:00+01:00", "0001-01-02T00:00:00+00:00"),
        ("1990-01-01T00:00:00+00:00", "1990-01-01T02:00:00+00:00"),
    ):
        msg = await path(begin, end)
        assert not msg["success"], (begin, end)
        assert msg["error"]["code"] == "invalid_format", (begin, end)
