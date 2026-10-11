"""Render the notification blueprint's templates with Home Assistant's engine."""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
import re
from typing import Any

from freezegun.api import FrozenDateTimeFactory
from homeassistant.components.blueprint.models import Blueprint, BlueprintInputs
from homeassistant.components.blueprint.schemas import BLUEPRINT_SCHEMA
from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.template import Template
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util, yaml as yaml_util
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_capture_events,
    async_fire_time_changed,
)
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.iss_tracker.const import DOMAIN
from custom_components.iss_tracker.elements import CELESTRAK_URL

BLUEPRINT = Path(__file__).parents[1] / "blueprints/automation/iss_tracker/notify_visible_pass.yaml"
PASS_SENSOR = "sensor.iss_next_visible_pass"
SOON_SENSOR = "binary_sensor.iss_visible_pass_soon"
ATTRIBUTES = {
    "start_direction": "WNW",
    "start_elevation": 10.0,
    "peak_direction": "SSW",
    "peak_elevation": 67.4,
    "end_direction": "ESE",
    "disappears_into_shadow": True,
    "duration_seconds": 372,
    "magnitude": -3.4,
}


def _automation() -> dict:
    blueprint = Blueprint(
        yaml_util.load_yaml_dict(BLUEPRINT),
        expected_domain="automation",
        schema=BLUEPRINT_SCHEMA,
    )
    inputs = BlueprintInputs(
        blueprint,
        {
            "use_blueprint": {
                "path": "iss.yaml",
                "input": {
                    "next_visible_pass": PASS_SENSOR,
                    "visible_pass_soon": SOON_SENSOR,
                    "notify_device": "abc123",
                },
            }
        },
    )
    inputs.validate()
    return inputs.async_substitute()


def _branch(config: dict, trigger_id: str) -> dict:
    """The condition branch that a trigger takes."""
    return next(
        c
        for c in config["conditions"][1]["conditions"]
        if c.get("id") == trigger_id
        or any(sub.get("id") == trigger_id for sub in c.get("conditions", []))
    )


def _with_recorded_notifications(config: dict) -> dict:
    """The blueprint's automation, with its phone notifications recorded as events."""
    actions = config["actions"][0]
    for sequence in (actions["choose"][0]["sequence"], actions["default"]):
        sent = sequence[0]
        sequence[0] = {
            "event": "iss_notification",
            "event_data": {"title": sent["title"], "message": sent["message"]},
        }
    return {**config, "id": "iss_notify", "alias": "ISS notify"}


async def test_blueprint_messages(hass: HomeAssistant, freezer: FrozenDateTimeFactory) -> None:
    await hass.config.async_set_time_zone("America/New_York")
    now = datetime(2026, 10, 10, 19, 0, tzinfo=dt_util.get_default_time_zone())
    freezer.move_to(now)
    start = now + timedelta(minutes=15)
    hass.states.async_set(PASS_SENSOR, start.isoformat(), {"start": start, **ATTRIBUTES})

    config = _automation()
    assert next(t for t in config["triggers"] if t["id"] == "daily")["at"] == "16:00:00"
    variables = cv.SCRIPT_VARIABLES_SCHEMA(config["variables"]).async_render(hass, {})
    assert variables["minutes_away"] == 15
    assert variables["day_text"] == "today"
    assert variables["time_text"] == "7:15 PM"
    assert variables["details"] == (
        "Appears in the WNW (10° up), climbs to 67° in the SSW, fades into Earth's shadow "
        "in the ESE. Visible for 6.2 min, brightness -3.4."
    )

    soon = config["actions"][0]["choose"][0]["sequence"][0]
    assert Template(soon["title"], hass).async_render(variables) == "ISS visible in 15 min"
    daily = config["actions"][0]["default"][0]
    assert Template(daily["title"], hass).async_render(variables) == "ISS visible today at 7:15 PM"

    daily_condition = _branch(config, "daily")["conditions"][1]
    assert Template(daily_condition["value_template"], hass).async_render(variables) is True


async def test_blueprint_without_a_pass(hass: HomeAssistant) -> None:
    hass.states.async_set(PASS_SENSOR, "unknown")
    config = _automation()
    variables = cv.SCRIPT_VARIABLES_SCHEMA(config["variables"]).async_render(hass, {})
    first_condition = config["conditions"][0]["value_template"]
    assert Template(first_condition, hass).async_render(variables) is False


async def test_back_to_back_passes_are_both_announced(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    """With a long advance notice, "soon" stays on between two passes."""
    await hass.config.async_set_time_zone("America/New_York")
    now = datetime(2026, 10, 10, 19, 0, tzinfo=dt_util.get_default_time_zone())
    freezer.move_to(now)

    async def advance(seconds: float) -> None:
        nonlocal now
        now += timedelta(seconds=seconds)
        freezer.move_to(now)
        async_fire_time_changed(hass, now)
        await hass.async_block_till_done()

    def pass_at(start: datetime) -> None:
        hass.states.async_set(PASS_SENSOR, start.isoformat(), {"start": start, **ATTRIBUTES})

    first = now + timedelta(minutes=100)
    hass.states.async_set(SOON_SENSOR, "off")
    pass_at(first)
    notifications = async_capture_events(hass, "iss_notification")
    assert await async_setup_component(
        hass, "automation", {"automation": [_with_recorded_notifications(_automation())]}
    )
    await hass.async_block_till_done()

    def titles() -> list[str]:
        return [e.data["title"] for e in notifications]

    # A 120-minute notice for the first pass.
    hass.states.async_set(SOON_SENSOR, "on")
    await hass.async_block_till_done()
    assert titles() == ["ISS visible in 100 min"]

    # The first pass ends; "soon" stays on for the next one, 92 minutes later.
    await advance(106 * 60)
    pass_at(first + timedelta(minutes=92))
    await advance(2)
    assert titles() == ["ISS visible in 100 min", "ISS visible in 86 min"]

    # A refinement of the same pass, or new attributes, say nothing.
    pass_at(first + timedelta(minutes=92, seconds=3))
    await advance(2)
    hass.states.async_set(
        PASS_SENSOR, hass.states.get(PASS_SENSOR).state, {**ATTRIBUTES, "magnitude": -3.0}
    )
    await advance(2)
    assert len(notifications) == 2

    # With a shorter notice "soon" is off when the sensor moves on, and the
    # pass is announced only when "soon" turns on for it.
    hass.states.async_set(SOON_SENSOR, "off")
    await hass.async_block_till_done()
    pass_at(first + timedelta(minutes=184))
    await advance(2)
    assert len(notifications) == 2
    hass.states.async_set(SOON_SENSOR, "on")
    await hass.async_block_till_done()
    assert len(notifications) == 3

    # The next pass's notice falls within the second soon_next waits: "soon"
    # turns off as one pass ends and back on 0.4 s later. One notice, not two.
    await advance(178 * 60)
    hass.states.async_set(SOON_SENSOR, "off")
    pass_at(first + timedelta(minutes=275))
    await advance(0.4)
    hass.states.async_set(SOON_SENSOR, "on")
    await advance(2)
    assert titles()[3:] == ["ISS visible in 91 min"]

    # Detach the triggers (the daily time trigger would outlive the test).
    await hass.services.async_call(
        "automation", "turn_off", {"entity_id": "automation.iss_notify"}, blocking=True
    )


async def test_soon_next_ignores_reloads_re_adds_and_write_order(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    """Each guard on soon_next keeps one of these from announcing a pass again."""
    await hass.config.async_set_time_zone("America/New_York")
    now = datetime(2026, 10, 10, 19, 0, tzinfo=dt_util.get_default_time_zone())
    freezer.move_to(now)

    async def advance(seconds: float) -> None:
        nonlocal now
        now += timedelta(seconds=seconds)
        freezer.move_to(now)
        async_fire_time_changed(hass, now)
        await hass.async_block_till_done()

    def pass_at(start: datetime) -> None:
        hass.states.async_set(PASS_SENSOR, start.isoformat(), {"start": start, **ATTRIBUTES})

    first = now + timedelta(minutes=100)
    hass.states.async_set(SOON_SENSOR, "off")
    pass_at(first)
    notifications = async_capture_events(hass, "iss_notification")
    assert await async_setup_component(
        hass, "automation", {"automation": [_with_recorded_notifications(_automation())]}
    )
    await hass.async_block_till_done()
    hass.states.async_set(SOON_SENSOR, "on")
    await hass.async_block_till_done()
    assert len(notifications) == 1

    # A reload: both entities go unavailable and come back (not_from/not_to).
    hass.states.async_set(PASS_SENSOR, "unavailable")
    hass.states.async_set(SOON_SENSOR, "unavailable")
    await advance(0.5)
    hass.states.async_set(SOON_SENSOR, "on")
    await advance(0.1)
    pass_at(first)
    await advance(2)
    assert len(notifications) == 1

    # The sensor is added again, with no previous state.
    hass.states.async_remove(PASS_SENSOR)
    await advance(0.5)
    pass_at(first)
    await advance(2)
    assert len(notifications) == 1

    # After a sleep through the end of one pass and the start of the next,
    # the sensor moves on to a pass already under way.
    await advance((100 + 95) * 60)
    second = first + timedelta(minutes=92)
    pass_at(second)
    await advance(2)
    assert len(notifications) == 1

    # That pass ends, and the pass sensor is written before "soon" turns off
    # (the second soon_next waits).
    await advance(4 * 60)
    pass_at(second + timedelta(minutes=92))
    hass.states.async_set(SOON_SENSOR, "off")
    await advance(2)
    assert len(notifications) == 1

    await hass.services.async_call(
        "automation", "turn_off", {"entity_id": "automation.iss_notify"}, blocking=True
    )


async def test_blueprint_reads_real_attributes(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    reference: dict[str, Any],
    omm_xml: bytes,
) -> None:
    """Every attribute the blueprint reads exists on the integration's sensor."""
    freezer.move_to(datetime.fromisoformat(reference["start"]))
    aioclient_mock.get(CELESTRAK_URL, content=omm_xml)
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="ISS",
        data={CONF_LATITUDE: 39.74, CONF_LONGITUDE: -104.99, CONF_ELEVATION: 1609.0},
    )
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    read = set(re.findall(r"state_attr\(pass_sensor, '(\w+)'\)", BLUEPRINT.read_text()))
    assert read >= {"duration_seconds", "magnitude", "disappears_into_shadow"}
    state = hass.states.get(PASS_SENSOR)
    assert read <= state.attributes.keys()
    assert hass.states.get(SOON_SENSOR) is not None

    variables = cv.SCRIPT_VARIABLES_SCHEMA(_automation()["variables"]).async_render(hass, {})
    assert "Visible for 0.0 min" not in variables["details"]
    assert variables["start_ts"] > 0
