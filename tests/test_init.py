"""Integration tests in a real Home Assistant test instance (network mocked)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
import re
import time
from typing import Any

from aiohttp import ClientConnectionError, ClientResponseError, RequestInfo, TooManyRedirects
from freezegun.api import FrozenDateTimeFactory
from homeassistant.config_entries import ConfigEntryDisabler, ConfigEntryState
from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE, EVENT_STATE_CHANGED
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er, issue_registry as ir
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from multidict import CIMultiDict, CIMultiDictProxy
import pytest
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_capture_events,
    async_fire_time_changed,
)
from pytest_homeassistant_custom_component.test_util.aiohttp import (
    AiohttpClientMocker,
    AiohttpClientMockResponse,
)
from yarl import URL

from custom_components.iss_tracker.const import (
    CONF_ALERT_LEAD_MINUTES,
    CONF_N2YO_API_KEY,
    DEFAULT_ALERT_LEAD_MINUTES,
    DOMAIN,
    ISSUE_ELEMENTS_STALE,
    STORAGE_KEY,
)
from custom_components.iss_tracker.coordinator import ElementsManager
from custom_components.iss_tracker.diagnostics import (
    async_get_config_entry_diagnostics,
)
from custom_components.iss_tracker.elements import (
    CELESTRAK_URL,
    N2YO_BASE_URL,
    WHERETHEISS_URL,
    ElementsError,
    parse_omm_xml,
    parse_tle,
)
from custom_components.iss_tracker.predict import Observer, PassPredictor

DENVER = {CONF_LATITUDE: 39.74, CONF_LONGITUDE: -104.99, CONF_ELEVATION: 1609.0}
LINE1 = "1 25544U 98067A   26281.85354122  .00006592  00000+0  12863-3 0  9993"
LINE2 = "2 25544  51.6315  97.5838 0006777 239.2205 120.8116 15.48782232589376"
N2YO_TLE = re.compile(r"n2yo\.com/.*/tle/25544")
N2YO_PASSES = re.compile(r"n2yo\.com/.*/visualpasses/25544/")


@pytest.fixture
def start(reference: dict[str, Any]) -> datetime:
    return datetime.fromisoformat(reference["start"])


@pytest.fixture
def entry(hass: HomeAssistant) -> MockConfigEntry:
    entry = MockConfigEntry(domain=DOMAIN, title="ISS", data=DENVER, unique_id="39.740_-104.990")
    entry.add_to_hass(hass)
    return entry


def _n2yo_entry(hass: HomeAssistant, **kwargs: Any) -> MockConfigEntry:
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="ISS",
        data=DENVER,
        options={CONF_N2YO_API_KEY: "secret-key"},
        unique_id="39.740_-104.990",
        **kwargs,
    )
    entry.add_to_hass(hass)
    return entry


def _other_location(hass: HomeAssistant, **kwargs: Any) -> MockConfigEntry:
    other = MockConfigEntry(
        domain=DOMAIN,
        title="Other",
        data={**DENVER, CONF_LATITUDE: 40.0},
        unique_id="40.000_-104.990",
        **kwargs,
    )
    other.add_to_hass(hass)
    return other


def _expected_visible(omm_xml: bytes, start: datetime) -> list:
    """Visible passes as the integration should report them with default options."""
    elements = parse_omm_xml("x", omm_xml, start)
    predictor = PassPredictor(
        elements.satrec(),
        Observer(DENVER[CONF_LATITUDE], DENVER[CONF_LONGITUDE], DENVER[CONF_ELEVATION]),
    )
    return [
        p
        for p in predictor.find_passes(start, start + timedelta(days=10))
        if p.visible is not None and p.visible.peak.elevation >= 20 and p.visible.duration_s >= 60
    ]


def _tle_line1(epoch: datetime) -> str:
    """LINE1 moved to another epoch, with its checksum redone: the same orbit, older or newer."""
    day = (epoch - datetime(epoch.year, 1, 1, tzinfo=UTC)).total_seconds() / 86400 + 1
    line = f"{LINE1[:18]}{epoch.year % 100:02d}{day:012.8f}{LINE1[32:68]}"
    return line + str(sum(int(c) if c.isdigit() else 1 if c == "-" else 0 for c in line) % 10)


def _omm(omm_xml: bytes, epoch: datetime) -> bytes:
    """The fixture's OMM moved to another epoch, standing in for a newer download."""
    tag = f"<EPOCH>{epoch:%Y-%m-%dT%H:%M:%S.%f}</EPOCH>".encode()
    return re.sub(rb"<EPOCH>[^<]*</EPOCH>", tag, omm_xml)


def _store(hass_storage: dict[str, Any], elements: Any) -> None:
    hass_storage[STORAGE_KEY] = {"version": 1, "key": STORAGE_KEY, "data": elements.as_dict()}


def _calls(aioclient_mock: AiohttpClientMocker, host: str) -> int:
    return sum(1 for c in aioclient_mock.mock_calls if host in str(c[1]))


async def _setup(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


async def _advance(hass: HomeAssistant, freezer: FrozenDateTimeFactory, when: datetime) -> None:
    freezer.move_to(when)
    async_fire_time_changed(hass, when)
    # Scheduled coordinator refreshes and setup retries run as background
    # tasks; without waiting for them the tests race the pass search.
    await hass.async_block_till_done(wait_background_tasks=True)


def _stale_issue(hass: HomeAssistant) -> ir.IssueEntry | None:
    return ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_ELEMENTS_STALE)


async def test_setup_and_states(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
) -> None:
    freezer.move_to(start)
    aioclient_mock.get(CELESTRAK_URL, content=omm_xml)
    await _setup(hass, entry)
    assert entry.state is ConfigEntryState.LOADED

    expected = _expected_visible(omm_xml, start)
    assert expected
    first = expected[0].visible

    state = hass.states.get("sensor.iss_next_visible_pass")
    assert state is not None
    assert dt_util.parse_datetime(state.state) == first.start.time.replace(microsecond=0)
    assert state.attributes["start_direction"] == first.start.compass
    assert state.attributes["peak_elevation"] == round(first.peak.elevation, 1)
    assert state.attributes["confidence"] in {"high", "medium", "low"}
    assert len(state.attributes["upcoming"]) == len(expected)

    assert float(hass.states.get("sensor.iss_next_visible_pass_peak_elevation").state) == round(
        first.peak.elevation, 1
    )
    assert float(hass.states.get("sensor.iss_next_visible_pass_duration").state) == pytest.approx(
        round(first.duration_s) / 60, abs=0.01
    )
    assert hass.states.get("sensor.iss_next_pass").state not in (None, "unknown")

    epoch = hass.states.get("sensor.iss_orbital_elements_epoch")
    assert epoch.attributes["source"] == "celestrak"
    assert epoch.attributes["stale"] is False
    assert epoch.attributes["age_days"] == 0.0

    tracker = hass.states.get("device_tracker.iss_position")
    assert -52 < tracker.attributes["latitude"] < 52
    assert 380 < tracker.attributes["altitude_km"] < 460

    elevation = hass.states.get("sensor.iss_elevation")
    assert -90 <= float(elevation.state) <= 90

    # The live attributes change on every update and stay out of the recorder;
    # the tracker's coordinates are kept for map-card trails.
    unrecorded = elevation.state_info["unrecorded_attributes"]
    assert {"azimuth", "direction", "range_km", "sunlit"} <= unrecorded
    unrecorded = tracker.state_info["unrecorded_attributes"]
    assert {"altitude_km", "speed_km_s", "sunlit"} <= unrecorded
    assert not {"latitude", "longitude"} & unrecorded

    for key in ("visible_now", "visible_pass_soon", "above_horizon"):
        assert hass.states.get(f"binary_sensor.iss_{key}").state == "off"

    # Only one download: the elements are cached for the next refresh.
    assert aioclient_mock.call_count == 1
    await _advance(hass, freezer, start + timedelta(hours=1))
    assert aioclient_mock.call_count == 1


async def test_unchanged_position_is_not_rewritten(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
) -> None:
    freezer.move_to(start)
    aioclient_mock.get(CELESTRAK_URL, content=omm_xml)
    await _setup(hass, entry)

    changes = async_capture_events(hass, EVENT_STATE_CHANGED)
    await entry.runtime_data.async_refresh()
    await hass.async_block_till_done()
    assert not [e for e in changes if e.data["entity_id"] == "device_tracker.iss_position"]


async def test_binary_sensors_follow_the_pass(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
) -> None:
    freezer.move_to(start)
    aioclient_mock.get(CELESTRAK_URL, content=omm_xml)
    await _setup(hass, entry)

    expected = _expected_visible(omm_xml, start)
    p = expected[0]
    v = p.visible
    lead = timedelta(minutes=DEFAULT_ALERT_LEAD_MINUTES)
    second = timedelta(seconds=1)

    def states() -> tuple[str, str, str]:
        return tuple(
            hass.states.get(f"binary_sensor.iss_{k}").state
            for k in ("visible_pass_soon", "visible_now", "above_horizon")
        )

    await _advance(hass, freezer, v.start.time - lead - second)
    assert states() == ("off", "off", "off")
    await _advance(hass, freezer, v.start.time - lead + second)
    assert states() == ("on", "off", "off")
    await _advance(hass, freezer, v.start.time + second)
    assert states() == ("on", "on", "on")
    assert float(hass.states.get("sensor.iss_elevation").state) >= 10
    await _advance(hass, freezer, v.end.time + second)
    assert states()[:2] == ("off", "off")
    await _advance(hass, freezer, p.set.time + second)
    assert states() == ("off", "off", "off")

    # The sensor has moved on to the following visible pass.
    state = hass.states.get("sensor.iss_next_visible_pass")
    assert dt_util.parse_datetime(state.state) == expected[1].visible.start.time.replace(
        microsecond=0
    )


async def test_falls_back_to_second_source(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    start: datetime,
) -> None:
    freezer.move_to(start)
    aioclient_mock.get(CELESTRAK_URL, status=403)
    aioclient_mock.get(WHERETHEISS_URL, json={"line1": LINE1, "line2": LINE2})
    await _setup(hass, entry)

    assert entry.state is ConfigEntryState.LOADED
    epoch = hass.states.get("sensor.iss_orbital_elements_epoch")
    assert epoch.attributes["source"] == "wheretheiss.at"
    assert hass.states.get("sensor.iss_next_visible_pass").state != "unavailable"


def _only_n2yo_is_fresh(aioclient_mock: AiohttpClientMocker, start: datetime) -> None:
    """CelesTrak refuses, wheretheiss.at has stopped updating and N2YO is up to date."""
    aioclient_mock.get(CELESTRAK_URL, status=403)
    aioclient_mock.get(
        WHERETHEISS_URL, json={"line1": _tle_line1(start - timedelta(days=16)), "line2": LINE2}
    )
    aioclient_mock.get(N2YO_TLE, json={"info": {"satid": 25544}, "tle": f"{LINE1}\r\n{LINE2}"})
    aioclient_mock.get(N2YO_PASSES, json={"passes": []})


async def test_stale_mirror_does_not_hide_a_fresher_source(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    start: datetime,
) -> None:
    """A mirror that stopped updating must not end the search for fresh elements."""
    entry = _n2yo_entry(hass)
    freezer.move_to(start)
    _only_n2yo_is_fresh(aioclient_mock, start)
    await _setup(hass, entry)
    await hass.async_block_till_done(wait_background_tasks=True)

    assert entry.state is ConfigEntryState.LOADED
    epoch = hass.states.get("sensor.iss_orbital_elements_epoch")
    assert epoch.attributes["source"] == "n2yo"
    assert epoch.attributes["last_download_error"] is None


async def test_location_without_a_key_still_asks_n2yo(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    start: datetime,
) -> None:
    """The locations share the elements, so one location's N2YO key serves them all."""
    # Added first, so the location without a key is the one that refreshes them.
    other = _other_location(hass)
    entry = _n2yo_entry(hass)
    freezer.move_to(start)
    _only_n2yo_is_fresh(aioclient_mock, start)
    await _setup(hass, other)
    await hass.async_block_till_done(wait_background_tasks=True)

    assert other.state is ConfigEntryState.LOADED
    assert entry.state is ConfigEntryState.LOADED
    assert hass.states.get("sensor.other_orbital_elements_epoch").attributes["source"] == "n2yo"


async def test_disabled_locations_key_is_not_used(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    start: datetime,
) -> None:
    _n2yo_entry(hass, disabled_by=ConfigEntryDisabler.USER)
    freezer.move_to(start)
    _only_n2yo_is_fresh(aioclient_mock, start)
    assert (await ElementsManager(hass).async_get(None)).source == "wheretheiss.at"
    assert _calls(aioclient_mock, "n2yo") == 0


async def test_stale_sources_are_named(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    hass_storage: dict[str, Any],
    start: datetime,
) -> None:
    """When only old elements can be had, the reason says where they came from."""
    freezer.move_to(start)
    aioclient_mock.get(CELESTRAK_URL, status=403)
    aioclient_mock.get(
        WHERETHEISS_URL,
        json={"line1": _tle_line1(start - timedelta(days=16, hours=1)), "line2": LINE2},
    )
    await _setup(hass, entry)

    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert "celestrak: HTTP 403" in entry.reason
    assert "wheretheiss.at: elements are 16 days old" in entry.reason
    # The best of them is kept, so the sources are not asked again at once.
    assert hass_storage[STORAGE_KEY]["data"]["source"] == "wheretheiss.at"


async def test_no_elements_retries_setup(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    start: datetime,
) -> None:
    freezer.move_to(start)
    aioclient_mock.get(CELESTRAK_URL, status=500)
    aioclient_mock.get(WHERETHEISS_URL, status=500)
    await _setup(hass, entry)
    assert entry.state is ConfigEntryState.SETUP_RETRY


async def test_recovers_when_network_comes_up(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
) -> None:
    """Home Assistant often starts before the network; setup must not stall for hours."""
    # Load the platform components up front: setting them up for the first time
    # from inside a retry timer does not complete under the frozen test clock.
    for component in ("binary_sensor", "device_tracker", "sensor"):
        assert await async_setup_component(hass, component, {})
    freezer.move_to(start)
    aioclient_mock.get(CELESTRAK_URL, exc=ClientConnectionError())
    aioclient_mock.get(WHERETHEISS_URL, exc=ClientConnectionError())
    await _setup(hass, entry)
    assert entry.state is ConfigEntryState.SETUP_RETRY
    failed_calls = aioclient_mock.call_count

    aioclient_mock.clear_requests()
    aioclient_mock.get(CELESTRAK_URL, content=omm_xml)
    now = start
    for _ in range(10):
        now += timedelta(seconds=90)
        await _advance(hass, freezer, now)
        if entry.state is ConfigEntryState.LOADED:
            break
    assert entry.state is ConfigEntryState.LOADED
    assert now - start <= timedelta(minutes=8)
    # Unreachable sources are not hammered while setup keeps retrying.
    assert failed_calls == 2
    assert aioclient_mock.call_count == 1


async def test_refused_source_is_left_alone(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    hass_storage: dict[str, Any],
    omm_xml: bytes,
    start: datetime,
) -> None:
    """After a 403, CelesTrak is left alone for two hours even while elements are due."""
    _store(hass_storage, parse_omm_xml("celestrak", omm_xml, start - timedelta(hours=7)))
    freezer.move_to(start)
    aioclient_mock.get(CELESTRAK_URL, status=403)
    aioclient_mock.get(WHERETHEISS_URL, status=500)
    await _setup(hass, entry)
    assert entry.state is ConfigEntryState.LOADED
    assert (_calls(aioclient_mock, "celestrak"), _calls(aioclient_mock, "wheretheiss")) == (1, 1)

    await _advance(hass, freezer, start + timedelta(minutes=31))
    assert _calls(aioclient_mock, "wheretheiss") == 2  # unreachable: tried again soon
    assert _calls(aioclient_mock, "celestrak") == 1  # refused: left alone
    await _advance(hass, freezer, start + timedelta(hours=1, minutes=31))
    assert _calls(aioclient_mock, "celestrak") == 1
    await _advance(hass, freezer, start + timedelta(hours=2, minutes=1))
    assert _calls(aioclient_mock, "celestrak") == 2


async def test_lagging_mirror_does_not_replace_newer_elements(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    hass_storage: dict[str, Any],
    omm_xml: bytes,
    start: datetime,
) -> None:
    cached = parse_omm_xml("celestrak", omm_xml, start - timedelta(hours=7))
    assert parse_tle("wheretheiss.at", LINE1, LINE2, start).epoch < cached.epoch
    _store(hass_storage, cached)
    freezer.move_to(start)
    aioclient_mock.get(CELESTRAK_URL, status=500)
    aioclient_mock.get(WHERETHEISS_URL, json={"line1": LINE1, "line2": LINE2})
    await _setup(hass, entry)
    assert entry.state is ConfigEntryState.LOADED
    assert _calls(aioclient_mock, "wheretheiss") == 1

    epoch = hass.states.get("sensor.iss_orbital_elements_epoch")
    assert epoch.attributes["source"] == "celestrak"
    assert dt_util.parse_datetime(epoch.state) == cached.epoch.replace(microsecond=0)
    assert hass_storage[STORAGE_KEY]["data"]["source"] == "celestrak"


async def test_cached_elements_survive_restart_offline(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    hass_storage: dict[str, Any],
    omm_xml: bytes,
    start: datetime,
) -> None:
    _store(hass_storage, parse_omm_xml("celestrak", omm_xml, start - timedelta(hours=12)))
    freezer.move_to(start)
    aioclient_mock.get(CELESTRAK_URL, exc=TimeoutError())
    aioclient_mock.get(WHERETHEISS_URL, exc=TimeoutError())
    await _setup(hass, entry)

    assert entry.state is ConfigEntryState.LOADED
    epoch = hass.states.get("sensor.iss_orbital_elements_epoch")
    assert epoch.attributes["source"] == "celestrak"
    assert epoch.attributes["last_download_error"]
    assert hass.states.get("sensor.iss_next_visible_pass").state not in ("unknown", "unavailable")


async def test_stale_elements_pause_predictions(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    hass_storage: dict[str, Any],
    omm_xml: bytes,
    start: datetime,
) -> None:
    later = start + timedelta(days=20)
    _store(hass_storage, parse_omm_xml("celestrak", omm_xml, later - timedelta(hours=1)))
    freezer.move_to(later)
    await _setup(hass, entry)
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert aioclient_mock.call_count == 0
    assert "20 days old" in entry.reason

    issue = ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_ELEMENTS_STALE)
    assert issue is not None
    assert issue.translation_placeholders["age"] == "20"
    # The issue goes with the last location.
    await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    assert ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_ELEMENTS_STALE) is None


async def _paused_while_loaded(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
) -> datetime:
    """Set up the location, then let every source go quiet past the age limit."""
    freezer.move_to(start)
    aioclient_mock.get(CELESTRAK_URL, content=omm_xml)
    await _setup(hass, entry)
    assert entry.state is ConfigEntryState.LOADED

    aioclient_mock.clear_requests()
    aioclient_mock.get(CELESTRAK_URL, status=503)
    aioclient_mock.get(WHERETHEISS_URL, status=503)
    later = start + timedelta(days=15)
    await _advance(hass, freezer, later)
    assert entry.state is ConfigEntryState.LOADED
    return later


async def test_paused_predictions_explain_themselves(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
) -> None:
    later = await _paused_while_loaded(hass, entry, aioclient_mock, freezer, omm_xml, start)

    assert hass.states.get("sensor.iss_next_visible_pass").state == "unavailable"
    # The diagnostic sensor stays, to say why.
    epoch = hass.states.get("sensor.iss_orbital_elements_epoch")
    assert epoch.state != "unavailable"
    assert epoch.attributes["stale"] is True
    assert epoch.attributes["age_days"] == pytest.approx(15.0, abs=0.1)
    assert "celestrak: HTTP 503" in epoch.attributes["last_download_error"]

    issue = _stale_issue(hass)
    assert issue is not None
    assert not issue.is_fixable
    assert issue.translation_placeholders["age"] == "15"
    assert "celestrak: HTTP 503" in issue.translation_placeholders["error"]
    assert "celestrak: HTTP 503" in str(entry.runtime_data.last_exception)

    # A reload keeps the issue, and the user's "Ignore" with it. Setup then
    # retries, so the diagnostic sensor is unavailable too.
    ir.async_get(hass).async_ignore(DOMAIN, ISSUE_ELEMENTS_STALE, True)
    assert not await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert _stale_issue(hass).dismissed_version is not None
    epoch = hass.states.get("sensor.iss_orbital_elements_epoch")
    assert epoch.state == "unavailable"
    assert epoch.attributes["restored"] is True

    # Disabling the last location clears the issue; enabling it again with
    # the sources still quiet brings it back.
    await hass.config_entries.async_set_disabled_by(entry.entry_id, ConfigEntryDisabler.USER)
    await hass.async_block_till_done()
    assert _stale_issue(hass) is None
    await hass.config_entries.async_set_disabled_by(entry.entry_id, None)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert _stale_issue(hass) is not None

    # Fresh elements end the pause and the issue.
    aioclient_mock.clear_requests()
    aioclient_mock.get(CELESTRAK_URL, content=_omm(omm_xml, later - timedelta(hours=1)))
    now = later
    for _ in range(10):
        now += timedelta(seconds=90)
        await _advance(hass, freezer, now)
        if entry.state is ConfigEntryState.LOADED:
            break
    assert entry.state is ConfigEntryState.LOADED
    assert hass.states.get("sensor.iss_next_visible_pass").state != "unavailable"
    assert hass.states.get("sensor.iss_orbital_elements_epoch").attributes["stale"] is False
    assert _stale_issue(hass) is None


async def test_clock_set_back_refreshes(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    hass_storage: dict[str, Any],
    omm_xml: bytes,
    start: datetime,
) -> None:
    """Elements downloaded while the clock ran a month fast are refreshed at once."""
    epoch = start - timedelta(days=15)
    _store(
        hass_storage,
        parse_tle("wheretheiss.at", _tle_line1(epoch), LINE2, start + timedelta(days=30)),
    )
    freezer.move_to(start)
    aioclient_mock.get(CELESTRAK_URL, content=omm_xml)
    await _setup(hass, entry)

    assert entry.state is ConfigEntryState.LOADED
    assert aioclient_mock.call_count == 1
    assert hass.states.get("sensor.iss_orbital_elements_epoch").attributes["source"] == "celestrak"


async def test_small_clock_correction_does_not_refresh(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    hass_storage: dict[str, Any],
    omm_xml: bytes,
    start: datetime,
) -> None:
    _store(hass_storage, parse_omm_xml("celestrak", omm_xml, start + timedelta(hours=1)))
    freezer.move_to(start)
    await _setup(hass, entry)
    assert entry.state is ConfigEntryState.LOADED
    assert aioclient_mock.call_count == 0


async def test_clock_set_back_ends_back_offs(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
) -> None:
    """A back-off set while the clock ran fast does not outlast the correction."""
    freezer.move_to(start + timedelta(days=30))
    aioclient_mock.get(CELESTRAK_URL, status=403)
    aioclient_mock.get(WHERETHEISS_URL, json={"line1": LINE1, "line2": LINE2})
    manager = ElementsManager(hass)
    assert (await manager.async_get(None)).source == "wheretheiss.at"

    freezer.move_to(start)
    aioclient_mock.clear_requests()
    aioclient_mock.get(CELESTRAK_URL, content=omm_xml)
    assert (await manager.async_get(None)).source == "celestrak"


def _sources_down(aioclient_mock: AiohttpClientMocker) -> None:
    aioclient_mock.get(CELESTRAK_URL, exc=ClientConnectionError())
    aioclient_mock.get(WHERETHEISS_URL, exc=ClientConnectionError())


async def test_clock_set_back_after_failed_downloads(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    hass_storage: dict[str, Any],
    omm_xml: bytes,
    start: datetime,
) -> None:
    """Back-offs set while the clock ran fast end with the correction.

    Even when nothing downloaded while it was fast.
    """
    _store(hass_storage, parse_omm_xml("celestrak", omm_xml, start - timedelta(hours=7)))
    manager = ElementsManager(hass)
    freezer.move_to(start + timedelta(days=30))
    _sources_down(aioclient_mock)
    await manager.async_get(None)
    assert aioclient_mock.call_count == 2

    freezer.move_to(start)
    aioclient_mock.clear_requests()
    aioclient_mock.get(CELESTRAK_URL, content=omm_xml)
    assert (await manager.async_get(None)).source == "celestrak"
    assert aioclient_mock.call_count == 1
    assert manager.last_error is None


async def test_clock_set_back_without_a_cache(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
) -> None:
    manager = ElementsManager(hass)
    freezer.move_to(start + timedelta(days=30))
    _sources_down(aioclient_mock)
    with pytest.raises(ElementsError):
        await manager.async_get(None)

    freezer.move_to(start)
    aioclient_mock.clear_requests()
    aioclient_mock.get(CELESTRAK_URL, content=omm_xml)
    assert (await manager.async_get(None)).source == "celestrak"


async def _retrying_with_stale_elements(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    hass_storage: dict[str, Any],
    omm_xml: bytes,
    start: datetime,
) -> None:
    _store(hass_storage, parse_omm_xml("celestrak", omm_xml, start))
    _sources_down(aioclient_mock)
    freezer.move_to(start + timedelta(days=20))
    await _setup(hass, entry)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert _stale_issue(hass) is not None


async def test_disabling_a_retrying_location_clears_the_issue(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    hass_storage: dict[str, Any],
    omm_xml: bytes,
    start: datetime,
) -> None:
    """No hook runs for a location that is not loaded; the repair must still go."""
    await _retrying_with_stale_elements(
        hass, entry, aioclient_mock, freezer, hass_storage, omm_xml, start
    )
    await hass.config_entries.async_set_disabled_by(entry.entry_id, ConfigEntryDisabler.USER)
    await hass.async_block_till_done()
    assert _stale_issue(hass) is None

    # Enabled again with the sources still down, it is back.
    await hass.config_entries.async_set_disabled_by(entry.entry_id, None)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert _stale_issue(hass) is not None


async def test_issue_kept_while_another_location_needs_it(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    hass_storage: dict[str, Any],
    omm_xml: bytes,
    start: datetime,
) -> None:
    other = _other_location(hass)
    await _retrying_with_stale_elements(
        hass, entry, aioclient_mock, freezer, hass_storage, omm_xml, start
    )
    assert other.state is ConfigEntryState.SETUP_RETRY
    await hass.config_entries.async_set_disabled_by(entry.entry_id, ConfigEntryDisabler.USER)
    await hass.async_block_till_done()
    assert _stale_issue(hass) is not None


async def test_removing_the_last_enabled_location_clears_the_issue(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    hass_storage: dict[str, Any],
    omm_xml: bytes,
    start: datetime,
) -> None:
    _other_location(hass, disabled_by=ConfigEntryDisabler.USER)
    await _retrying_with_stale_elements(
        hass, entry, aioclient_mock, freezer, hass_storage, omm_xml, start
    )
    await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    assert _stale_issue(hass) is None


async def test_options_change_keeps_the_ignored_issue(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
) -> None:
    """An options change reloads the location; the user's "Ignore" must survive it."""
    await _paused_while_loaded(hass, entry, aioclient_mock, freezer, omm_xml, start)
    ir.async_get(hass).async_ignore(DOMAIN, ISSUE_ELEMENTS_STALE, True)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    await hass.config_entries.options.async_configure(
        result["flow_id"], {CONF_ALERT_LEAD_MINUTES: 20}
    )
    await hass.async_block_till_done(wait_background_tasks=True)
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert _stale_issue(hass).dismissed_version is not None


async def _disable_or_remove(hass: HomeAssistant, entry: MockConfigEntry, action: str) -> None:
    if action == "disable":
        await hass.config_entries.async_set_disabled_by(entry.entry_id, ConfigEntryDisabler.USER)
    else:
        await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()


@pytest.mark.parametrize("action", ["disable", "remove"])
async def test_issue_goes_with_the_last_loaded_location(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
    action: str,
) -> None:
    """The issue outlives a reload, but goes with the last location."""
    await _paused_while_loaded(hass, entry, aioclient_mock, freezer, omm_xml, start)
    await _disable_or_remove(hass, entry, action)
    assert _stale_issue(hass) is None


@pytest.mark.parametrize("action", ["disable", "remove"])
async def test_ignored_issue_kept_while_another_location_is_paused(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
    action: str,
) -> None:
    """A loaded location that goes away leaves the issue to one still retrying setup."""
    await _paused_while_loaded(hass, entry, aioclient_mock, freezer, omm_xml, start)
    other = _other_location(hass)
    await _setup(hass, other)
    assert other.state is ConfigEntryState.SETUP_RETRY
    ir.async_get(hass).async_ignore(DOMAIN, ISSUE_ELEMENTS_STALE, True)

    await _disable_or_remove(hass, entry, action)
    issue = _stale_issue(hass)
    assert issue is not None
    assert issue.dismissed_version is not None


async def test_n2yo_cross_check(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
) -> None:
    entry = _n2yo_entry(hass)
    freezer.move_to(start)

    # N2YO's answer, built from this engine's own prediction offset by one
    # second, so the reported difference should be about one second of motion.
    fake = []
    for p in _expected_visible(omm_xml, start):
        item: dict[str, Any] = {}
        for prefix, point in (
            ("start", p.visible.start),
            ("max", p.visible.peak),
            ("end", p.visible.end),
        ):
            item[f"{prefix}UTC"] = int(point.time.timestamp()) + 1
            item[f"{prefix}Az"] = round(point.azimuth, 2)
            item[f"{prefix}El"] = round(point.elevation, 2)
        fake.append(item)

    aioclient_mock.get(CELESTRAK_URL, content=omm_xml)
    aioclient_mock.get(N2YO_PASSES, json={"passes": fake})
    await _setup(hass, entry)
    # The cross-check runs in the background.
    await hass.async_block_till_done(wait_background_tasks=True)

    state = hass.states.get("sensor.iss_n2yo_prediction_difference")
    assert state is not None
    assert state.attributes["compared_passes"] == len(fake)
    assert 0 < float(state.state) < 2.5

    diag = await async_get_config_entry_diagnostics(hass, entry)
    assert diag["options"][CONF_N2YO_API_KEY] == "**REDACTED**"
    for key in (CONF_LATITUDE, CONF_LONGITUDE, CONF_ELEVATION):
        assert diag["entry"][key] == "**REDACTED**"
    # Pass times and angles would give the home location away; counts do not.
    assert "passes" not in diag
    assert "visible_passes" not in diag
    assert diag["visible_pass_count"] == len(fake)
    assert diag["pass_count"] >= diag["visible_pass_count"]
    assert "secret-key" not in repr(diag)


async def test_setup_does_not_wait_for_n2yo(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
) -> None:
    entry = _n2yo_entry(hass)
    freezer.move_to(start)
    answer = asyncio.Event()

    async def slow_n2yo(method: str, url: URL, data: Any) -> AiohttpClientMockResponse:
        await answer.wait()
        return AiohttpClientMockResponse(method, url, json={"passes": []})

    aioclient_mock.get(CELESTRAK_URL, content=omm_xml)
    aioclient_mock.get(N2YO_PASSES, side_effect=slow_n2yo)
    setup = hass.async_create_task(hass.config_entries.async_setup(entry.entry_id))
    # Give setup up to a few seconds of real time (the event loop's clock is
    # frozen, so wait in the executor) while N2YO keeps everyone waiting.
    for _ in range(300):
        if setup.done():
            break
        await hass.async_add_executor_job(time.sleep, 0.01)
    finished_first = setup.done()
    if finished_first:
        await hass.async_block_till_done()
        assert entry.state is ConfigEntryState.LOADED
        assert hass.states.get("sensor.iss_next_visible_pass").state not in (
            "unknown",
            "unavailable",
        )
        state = hass.states.get("sensor.iss_n2yo_prediction_difference")
        assert "checked_at" not in state.attributes
    answer.set()
    await setup
    assert finished_first, "setup waited for N2YO"
    await hass.async_block_till_done(wait_background_tasks=True)
    state = hass.states.get("sensor.iss_n2yo_prediction_difference")
    assert state.attributes["compared_passes"] == 0


def _aiohttp_failure(kind: str, url: str) -> ClientResponseError:
    """What aiohttp raises for an unparsable response or a redirect loop; its text holds the URL."""
    info = RequestInfo(URL(url), "GET", CIMultiDictProxy(CIMultiDict()), URL(url))
    if kind == "redirects":
        return TooManyRedirects(info, ())
    return ClientResponseError(
        info, (), status=400, message="Got more than 8190 bytes when reading: header value"
    )


SECRETS = ("secret-key", "39.7400/-104.9900")


@pytest.mark.parametrize("kind", ["response", "redirects"])
async def test_n2yo_errors_keep_key_and_location_private(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    hass_storage: dict[str, Any],
    caplog: pytest.LogCaptureFixture,
    omm_xml: bytes,
    start: datetime,
    kind: str,
) -> None:
    entry = _n2yo_entry(hass)
    # The elements are due for renewal, and only N2YO answers, badly.
    _store(hass_storage, parse_omm_xml("celestrak", omm_xml, start - timedelta(hours=7)))
    freezer.move_to(start)
    tle_url = f"{N2YO_BASE_URL}/tle/25544&apiKey=secret-key"
    passes_url = (
        f"{N2YO_BASE_URL}/visualpasses/25544/39.7400/-104.9900/1609/10/1/&apiKey=secret-key"
    )
    assert all(s in str(_aiohttp_failure(kind, passes_url)) for s in SECRETS)
    aioclient_mock.get(CELESTRAK_URL, status=500)
    aioclient_mock.get(WHERETHEISS_URL, status=500)
    aioclient_mock.get(N2YO_TLE, exc=_aiohttp_failure(kind, tle_url))
    aioclient_mock.get(N2YO_PASSES, exc=_aiohttp_failure(kind, passes_url))
    await _setup(hass, entry)
    await hass.async_block_till_done(wait_background_tasks=True)
    assert entry.state is ConfigEntryState.LOADED

    epoch = hass.states.get("sensor.iss_orbital_elements_epoch")
    assert "n2yo: " in epoch.attributes["last_download_error"]
    check = hass.states.get("sensor.iss_n2yo_prediction_difference")
    assert check.attributes["error"].startswith("n2yo: ")
    diag = await async_get_config_entry_diagnostics(hass, entry)
    for secret in SECRETS:
        assert secret not in caplog.text
        assert secret not in repr(diag)
        for state in hass.states.async_all():
            assert secret not in repr(state.attributes), state.entity_id


async def test_n2yo_errors_keep_key_out_of_setup_reason(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    caplog: pytest.LogCaptureFixture,
    start: datetime,
) -> None:
    entry = _n2yo_entry(hass)
    freezer.move_to(start)
    aioclient_mock.get(CELESTRAK_URL, status=500)
    aioclient_mock.get(WHERETHEISS_URL, status=500)
    aioclient_mock.get(
        N2YO_TLE, exc=_aiohttp_failure("response", f"{N2YO_BASE_URL}/tle/25544&apiKey=secret-key")
    )
    await _setup(hass, entry)
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert "n2yo: ClientResponseError 400" in entry.reason
    assert "secret-key" not in entry.reason
    assert "secret-key" not in caplog.text


async def test_n2yo_sensor_removed_with_the_key(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
) -> None:
    entry = _n2yo_entry(hass)
    freezer.move_to(start)
    aioclient_mock.get(CELESTRAK_URL, content=omm_xml)
    aioclient_mock.get(N2YO_PASSES, json={"passes": []})
    await _setup(hass, entry)
    await hass.async_block_till_done(wait_background_tasks=True)
    unique_id = f"{entry.entry_id}_n2yo_difference"
    assert er.async_get(hass).async_get_entity_id("sensor", DOMAIN, unique_id)

    result = await hass.config_entries.options.async_init(entry.entry_id)
    await hass.config_entries.options.async_configure(result["flow_id"], {CONF_N2YO_API_KEY: ""})
    await hass.async_block_till_done(wait_background_tasks=True)
    assert entry.state is ConfigEntryState.LOADED
    assert er.async_get(hass).async_get_entity_id("sensor", DOMAIN, unique_id) is None
    assert hass.states.get("sensor.iss_n2yo_prediction_difference") is None


async def test_unload(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
) -> None:
    freezer.move_to(start)
    aioclient_mock.get(CELESTRAK_URL, content=omm_xml)
    await _setup(hass, entry)
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.NOT_LOADED
