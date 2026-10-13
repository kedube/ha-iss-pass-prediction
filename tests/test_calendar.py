"""Tests for the calendar of visible passes."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json
from pathlib import Path
import string
from typing import Any

from freezegun.api import FrozenDateTimeFactory
from homeassistant.components.calendar import CalendarEvent
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
import pytest
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_fire_time_changed,
    async_mock_service,
)
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.iss_tracker.calendar import PassText, event_times, resolve_language
from custom_components.iss_tracker.const import (
    CONF_FORECAST_DAYS,
    CONF_SHOW_CALENDAR,
    DOMAIN,
    PASS_UPDATE_INTERVAL,
)
from custom_components.iss_tracker.elements import CELESTRAK_URL, WHERETHEISS_URL
from custom_components.iss_tracker.entity import confidence
from custom_components.iss_tracker.predict import Pass, SkyPoint, VisibleWindow

DENVER = {CONF_LATITUDE: 39.74, CONF_LONGITUDE: -104.99, CONF_ELEVATION: 1609.0}
CALENDAR = "calendar.home_iss_visible_passes"
INTEGRATION = Path(__file__).parents[1] / "custom_components/iss_tracker"
COMPASS = ("N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
           "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW")  # fmt: skip


@pytest.fixture
def start(reference: dict[str, Any]) -> datetime:
    return datetime.fromisoformat(reference["start"])


@pytest.fixture(autouse=True)
def _clock(freezer: FrozenDateTimeFactory, start: datetime) -> None:
    """Set the clock before the fixtures that sign in, so their tokens are valid then."""
    freezer.move_to(start)


async def _setup(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
    options: dict[str, Any] | None = None,
    location: dict[str, float] = DENVER,
) -> MockConfigEntry:
    freezer.move_to(start)
    aioclient_mock.get(CELESTRAK_URL, content=omm_xml)
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Home",
        data=location,
        options=options or {},
        unique_id=f"{location[CONF_LATITUDE]:.3f}_{location[CONF_LONGITUDE]:.3f}",
    )
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    return entry


async def _advance(hass: HomeAssistant, freezer: FrozenDateTimeFactory, when: datetime) -> None:
    freezer.move_to(when)
    async_fire_time_changed(hass, when)
    await hass.async_block_till_done(wait_background_tasks=True)


async def _events(
    hass: HomeAssistant, start: datetime, end: datetime, entity_id: str = CALENDAR
) -> list[dict[str, Any]]:
    response = await hass.services.async_call(
        "calendar",
        "get_events",
        {"entity_id": entity_id, "start_date_time": start, "end_date_time": end},
        blocking=True,
        return_response=True,
    )
    return response[entity_id]["events"]


def _english(p: Pass, epoch: datetime) -> tuple[str, str]:
    """The summary and description an English event should have."""
    v = p.visible
    assert v is not None
    ending = "fades into Earth's shadow" if v.ends_in_shadow else "sets"
    path = (
        f"Appears in the {v.start.compass} {round(v.start.elevation)}° up, climbs to "
        f"{round(v.peak.elevation)}° in the {v.peak.compass}, {ending} in the {v.end.compass}."
    )
    assert v.magnitude is not None
    magnitude = round(v.magnitude, 1) + 0.0
    details = f"Brightness {magnitude:.1f} · {confidence(v.start.time, epoch)} confidence"
    return f"ISS visible pass · up to {round(v.peak.elevation)}°", f"{path}\n{details}"


@pytest.mark.parametrize(
    ("observer", "days", "fades_into_shadow"),
    [
        # Morning passes, which end by setting.
        ("denver", 10, {False}),
        # Evening passes too, most of which end in Earth's shadow.
        ("sydney", 30, {False, True}),
    ],
)
async def test_calendar_lists_the_visible_passes(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    reference: dict[str, Any],
    omm_xml: bytes,
    start: datetime,
    observer: str,
    days: int,
    fades_into_shadow: set[bool],
) -> None:
    """One event per visible pass, the same passes and times as the sensors."""
    o = reference["observers"][observer]
    location = {
        CONF_LATITUDE: o["latitude"],
        CONF_LONGITUDE: o["longitude"],
        CONF_ELEVATION: float(o["elevation_m"]),
    }
    entry = await _setup(
        hass, aioclient_mock, freezer, omm_xml, start, {CONF_FORECAST_DAYS: days}, location
    )
    data = entry.runtime_data.data
    assert len(data.visible_passes) > 1
    assert {p.visible.ends_in_shadow for p in data.visible_passes} == fades_into_shadow

    events = await _events(hass, start, start + timedelta(days=days))
    assert len(events) == len(data.visible_passes)
    for event, p in zip(events, data.visible_passes, strict=True):
        assert p.visible is not None
        assert dt_util.parse_datetime(event["start"]) == p.visible.start.time.replace(microsecond=0)
        assert dt_util.parse_datetime(event["end"]) == p.visible.end.time.replace(microsecond=0)
        assert (event["summary"], event["description"]) == _english(p, data.elements.epoch)

    sensor = hass.states.get("sensor.home_next_visible_pass")
    assert dt_util.parse_datetime(events[0]["start"]) == dt_util.parse_datetime(sensor.state)

    # The calendar's state shows the next pass, and is off until it starts.
    state = hass.states.get(CALENDAR)
    assert state.state == "off"
    assert state.attributes["message"] == events[0]["summary"]
    assert state.attributes["description"] == events[0]["description"]
    assert state.attributes["start_time"] == dt_util.as_local(
        dt_util.parse_datetime(events[0]["start"])
    ).strftime("%Y-%m-%d %H:%M:%S")

    # Only the passes that overlap the requested range.
    first_end = dt_util.parse_datetime(events[0]["end"])
    assert await _events(hass, start, start + timedelta(minutes=1)) == []
    assert await _events(hass, first_end - timedelta(seconds=1), first_end) == events[:1]


async def test_calendar_follows_the_passes(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
) -> None:
    """On during each pass; once a pass is over the calendar shows the next one."""
    entry = await _setup(hass, aioclient_mock, freezer, omm_xml, start)
    first, following = entry.runtime_data.data.visible_passes[:2]
    first_start, first_end = event_times(first)
    following_start, _ = event_times(following)
    second = timedelta(seconds=1)

    def state() -> tuple[str, str]:
        s = hass.states.get(CALENDAR)
        return s.state, s.attributes["start_time"]

    def local(when: datetime) -> str:
        return when.strftime("%Y-%m-%d %H:%M:%S")

    await _advance(hass, freezer, first_start - second)
    assert state() == ("off", local(first_start))
    await _advance(hass, freezer, first_start + second)
    assert state() == ("on", local(first_start))
    # The event ends on the whole second before the pass does. Its end moves
    # the calendar on, without waiting for the next prediction run.
    assert first_end < first.visible.end.time
    await _advance(hass, freezer, first_end)
    assert state() == ("off", local(following_start))
    await _advance(hass, freezer, first.visible.end.time + second)
    assert state() == ("off", local(following_start))


async def test_calendar_can_be_switched_off(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
) -> None:
    entry = await _setup(
        hass, aioclient_mock, freezer, omm_xml, start, options={CONF_SHOW_CALENDAR: False}
    )
    assert hass.states.get(CALENDAR) is None
    entities = er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)
    assert entities
    assert not [e for e in entities if e.domain == "calendar"]
    # The calendar integration is not even loaded for it.
    assert "calendar" not in hass.config.components
    assert hass.states.get("sensor.home_next_visible_pass").state != "unavailable"


async def test_calendar_follows_the_option(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
    caplog: pytest.LogCaptureFixture,
) -> None:
    entry = await _setup(hass, aioclient_mock, freezer, omm_xml, start)
    ent_reg = er.async_get(hass)
    unique_id = f"{entry.entry_id}_visible_passes"
    assert ent_reg.async_get_entity_id("calendar", DOMAIN, unique_id) == CALENDAR
    assert hass.states.get(CALENDAR).state == "off"

    # Switched off, it goes, rather than staying behind unavailable.
    hass.config_entries.async_update_entry(entry, options={CONF_SHOW_CALENDAR: False})
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert ent_reg.async_get_entity_id("calendar", DOMAIN, unique_id) is None
    assert hass.states.get(CALENDAR) is None

    hass.config_entries.async_update_entry(entry, options={CONF_SHOW_CALENDAR: True})
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert hass.states.get(CALENDAR).state == "off"
    # Each reload unloaded the platforms that were loaded, and only those.
    assert "Ignored unload request" not in caplog.text


async def test_calendar_switched_on_later(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Switching it on reloads the location without unloading a calendar it never had."""
    # Loaded already, as it is for anyone with another calendar.
    assert await async_setup_component(hass, "calendar", {})
    entry = await _setup(
        hass, aioclient_mock, freezer, omm_xml, start, options={CONF_SHOW_CALENDAR: False}
    )
    assert hass.states.get(CALENDAR) is None

    hass.config_entries.async_update_entry(entry, options={CONF_SHOW_CALENDAR: True})
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert hass.states.get(CALENDAR).state == "off"
    assert "Ignored unload request" not in caplog.text


async def test_calendar_is_empty_while_predictions_are_paused(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    hass_ws_client,
    omm_xml: bytes,
    start: datetime,
) -> None:
    """Passes predicted from elements too old to trust are not shown."""
    entry = await _setup(
        hass, aioclient_mock, freezer, omm_xml, start, options={CONF_FORECAST_DAYS: 30}
    )
    # Signed in now, while the test user's token is still valid.
    client = await hass_ws_client(hass)
    aioclient_mock.clear_requests()
    aioclient_mock.get(CELESTRAK_URL, status=503)
    aioclient_mock.get(WHERETHEISS_URL, status=503)
    later = start + timedelta(days=15)
    await _advance(hass, freezer, later)
    assert not entry.runtime_data.last_update_success
    # Passes from the old elements are still to come...
    data = entry.runtime_data.data
    assert any(p.visible.start.time > later for p in data.visible_passes)
    # ...but the calendar is unavailable, like the sensors, and lists none of
    # them: the calendar panel asks for them whether or not it is available.
    assert hass.states.get(CALENDAR).state == "unavailable"
    await client.send_json_auto_id(
        {
            "type": "calendar/event/subscribe",
            "entity_id": CALENDAR,
            "start": later.isoformat(),
            "end": (later + timedelta(days=15)).isoformat(),
        }
    )
    msg = await client.receive_json()
    assert msg["success"], msg
    msg = await client.receive_json()
    assert msg["event"]["events"] == []


async def test_live_updates_do_not_resend_the_events(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    hass_ws_client,
    omm_xml: bytes,
    start: datetime,
) -> None:
    """An open calendar gets the events again when the passes change, not every minute."""
    entry = await _setup(hass, aioclient_mock, freezer, omm_xml, start)
    count = len(entry.runtime_data.data.visible_passes)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id(
        {
            "type": "calendar/event/subscribe",
            "entity_id": CALENDAR,
            "start": start.isoformat(),
            "end": (start + timedelta(days=10)).isoformat(),
        }
    )
    msg = await client.receive_json()
    assert msg["success"], msg
    msg = await client.receive_json()
    assert len(msg["event"]["events"]) == count

    # The live position updates every minute; nothing is sent for it. (Reading
    # after every step also answers the connection's heartbeat.)
    for minutes in (1, 2, 3):
        await _advance(hass, freezer, start + timedelta(minutes=minutes, seconds=1))
        await client.send_json_auto_id({"type": "ping"})
        assert (await client.receive_json())["type"] == "pong"

    # A new prediction run sends the events again.
    await _advance(hass, freezer, start + PASS_UPDATE_INTERVAL + timedelta(seconds=1))
    msg = await client.receive_json()
    assert msg["type"] == "event"
    assert len(msg["event"]["events"]) == count


async def test_calendar_trigger_before_a_pass(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
) -> None:
    """The README's automation: a calendar trigger ten minutes before each pass."""
    entry = await _setup(hass, aioclient_mock, freezer, omm_xml, start)
    p = entry.runtime_data.data.visible_passes[0]
    pass_start, _ = event_times(p)
    await _advance(hass, freezer, pass_start - timedelta(minutes=20))

    calls = async_mock_service(hass, "test", "automation")
    assert await async_setup_component(
        hass,
        "automation",
        {
            "automation": {
                "triggers": {
                    "trigger": "calendar",
                    "event": "start",
                    "offset": "-0:10:0",
                    "entity_id": CALENDAR,
                },
                "actions": {
                    "action": "test.automation",
                    "data": {
                        "summary": "{{ trigger.calendar_event.summary }}",
                        "start": "{{ trigger.calendar_event.start }}",
                    },
                },
            }
        },
    )
    await hass.async_block_till_done()

    await _advance(hass, freezer, pass_start - timedelta(minutes=10, seconds=1))
    assert not calls
    await _advance(hass, freezer, pass_start - timedelta(minutes=10) + timedelta(seconds=1))
    assert len(calls) == 1
    summary, _ = _english(p, entry.runtime_data.data.elements.epoch)
    assert calls[0].data["summary"] == summary
    assert dt_util.parse_datetime(calls[0].data["start"]) == pass_start

    # Stops the trigger's polling, which would outlast the test.
    await hass.services.async_call("automation", "turn_off", {"entity_id": "all"}, blocking=True)


@pytest.mark.parametrize(
    ("language", "summary", "brightness"),
    [
        ("de", "Sichtbarer ISS-Überflug · bis {}°", "Helligkeit {}"),
        # Regional variants get their language's text, as on the globe.
        ("de-CH", "Sichtbarer ISS-Überflug · bis {}°", "Helligkeit {}"),
        ("pt", "Passagem visível da ISS · até {}°", "Brilho {}"),
        # Languages without a translation get English.
        ("ja", "ISS visible pass · up to {}°", "Brightness {}"),
    ],
)
async def test_events_follow_the_home_assistant_language(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
    language: str,
    summary: str,
    brightness: str,
) -> None:
    hass.config.language = language
    entry = await _setup(hass, aioclient_mock, freezer, omm_xml, start)
    entity_id = er.async_get(hass).async_get_entity_id(
        "calendar", DOMAIN, f"{entry.entry_id}_visible_passes"
    )
    events = await _events(hass, start, start + timedelta(days=10), entity_id)
    v = entry.runtime_data.data.visible_passes[0].visible
    assert events[0]["summary"] == summary.format(round(v.peak.elevation))
    separator = "." if language == "ja" else ","
    magnitude = f"{v.magnitude:.1f}".replace(".", separator)
    assert events[0]["description"].splitlines()[1].startswith(brightness.format(magnitude))


async def test_german_events_use_the_globes_words(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    omm_xml: bytes,
    start: datetime,
) -> None:
    """Compass points and wording match the globe's German text."""
    hass.config.language = "de"
    entry = await _setup(hass, aioclient_mock, freezer, omm_xml, start)
    entity_id = er.async_get(hass).async_get_entity_id(
        "calendar", DOMAIN, f"{entry.entry_id}_visible_passes"
    )
    globe = json.loads((INTEGRATION / "frontend/translations/de.json").read_text())
    data = entry.runtime_data.data
    events = await _events(hass, start, start + timedelta(days=10), entity_id)
    for event, p in zip(events, data.visible_passes, strict=True):
        v = p.visible
        point = {c: globe["compass"][i] for i, c in enumerate(COMPASS)}
        path = globe["sky"]["fades" if v.ends_in_shadow else "sets"].format(
            start=point[v.start.compass],
            start_elevation=round(v.start.elevation),
            peak=point[v.peak.compass],
            peak_elevation=round(v.peak.elevation),
            end=point[v.end.compass],
        )
        level = globe["mission"][f"confidence_{confidence(v.start.time, data.elements.epoch)}"]
        magnitude = f"{round(v.magnitude, 1) + 0.0:.1f}".replace(".", ",")
        details = f"Helligkeit {magnitude} · {level}"
        assert event["description"] == f"{path}\n{details}"


def test_resolve_language() -> None:
    available = {"en", "de", "es", "fr", "it", "nl", "pl", "pt-BR", "sv"}
    assert resolve_language("de", available) == "de"
    assert resolve_language("pt-BR", available) == "pt-BR"
    assert resolve_language("de-CH", available) == "de"
    assert resolve_language("es-419", available) == "es"
    assert resolve_language("pt", available) == "pt-BR"
    assert resolve_language("pt_BR", available) == "pt-BR"
    assert resolve_language("en-GB", available) == "en"
    assert resolve_language("ja", available) == "en"
    assert resolve_language("zh-Hans", available) == "en"


def _point(t: datetime, azimuth: float, elevation: float) -> SkyPoint:
    return SkyPoint(t, azimuth, elevation, 800.0)


def _pass(start: datetime, end: datetime, magnitude: float | None, ends_in_shadow: bool) -> Pass:
    peak = start + (end - start) / 2
    window = VisibleWindow(
        start=_point(start, 315.0, 10.2),
        peak=_point(peak, 45.0, 67.4),
        end=_point(end, 135.0, 24.6),
        magnitude=magnitude,
        starts_from_shadow=False,
        ends_in_shadow=ends_in_shadow,
    )
    return Pass(window.start, window.peak, window.end, window)


def test_short_visible_window_still_lasts_a_second() -> None:
    """With a minimum visible time of 0 s, a window can be shorter than a second."""
    noon = datetime(2026, 10, 12, 12, 0, tzinfo=UTC)
    p = _pass(noon + timedelta(seconds=0.2), noon + timedelta(seconds=0.7), -1.0, False)
    start, end = event_times(p)
    assert (start, end - start) == (noon, timedelta(seconds=1))
    assert start.tzinfo is not None
    CalendarEvent(start=start, end=end, summary="ISS visible pass")


def _common(language: str) -> dict[str, str]:
    path = INTEGRATION / "translations" / f"{language}.json"
    return json.loads(path.read_text(encoding="utf-8"))["common"]


def _placeholders(text: str) -> set[str]:
    return {name for _, name, _, _ in string.Formatter().parse(text) if name}


@pytest.mark.parametrize(
    "language", sorted(p.stem for p in (INTEGRATION / "translations").glob("*.json"))
)
def test_every_language_describes_a_pass(language: str) -> None:
    """Every translation has all the calendar's words, with the placeholders filled in."""
    english, local = _common("en"), _common(language)
    assert local.keys() == english.keys()
    for key, text in local.items():
        assert _placeholders(text) == _placeholders(english[key]), key

    strings = json.loads((INTEGRATION / "translations" / f"{language}.json").read_text())
    assert strings["entity"]["calendar"]["visible_passes"]["name"]
    assert strings["options"]["step"]["init"]["data"][CONF_SHOW_CALENDAR]
    assert strings["options"]["step"]["init"]["data_description"][CONF_SHOW_CALENDAR]

    text = PassText(local)
    epoch = datetime(2026, 10, 12, tzinfo=UTC)
    when = epoch + timedelta(days=8, hours=20)
    for magnitude, fades in ((-3.44, True), (-0.04, False), (None, False)):
        p = _pass(when, when + timedelta(minutes=6), magnitude, fades)
        summary = text.summary(p)
        description = text.description(p, epoch)
        assert "67" in summary
        lines = description.splitlines()
        assert len(lines) == 2
        assert "{" not in description
        assert "}" not in description
        assert local["confidence_low"].lower() in lines[1].lower()
        assert lines[1][0] == lines[1][0].upper()
        if magnitude == -3.44:
            assert f"-3{local['decimal_separator']}4" in lines[1]
        elif magnitude is not None:
            assert "-0" not in lines[1]
        assert local["compass_nw"] in lines[0]
        assert local["compass_se"] in lines[0]
