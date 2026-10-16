"""Sensors for ISS Tracker."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from homeassistant.components.sensor import (
    DOMAIN as SENSOR_DOMAIN,
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
)
from homeassistant.const import DEGREE, EntityCategory, UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from . import IssConfigEntry
from .const import DOMAIN, ELEMENTS_MAX_AGE, MAX_LISTED_PASSES
from .coordinator import IssTrackerCoordinator
from .entity import IssEntity, pass_attributes, visible_pass_attributes

PARALLEL_UPDATES = 0


@dataclass(frozen=True, kw_only=True)
class IssSensorDescription(SensorEntityDescription):
    """Describes an ISS sensor."""

    value_fn: Callable[[IssTrackerCoordinator, datetime], Any]
    attrs_fn: Callable[[IssTrackerCoordinator, datetime], dict[str, Any]] | None = None
    # Stays available while predictions are paused, to show why.
    available_when_stale: bool = False


def _next_visible(attr: str) -> Callable[[IssTrackerCoordinator, datetime], Any]:
    def value(c: IssTrackerCoordinator, now: datetime) -> Any:
        p = c.next_visible_pass(now)
        if p is None or p.visible is None:
            return None
        v = p.visible
        match attr:
            case "start":
                return v.start.time.replace(microsecond=0)
            case "peak_elevation":
                return round(v.peak.elevation, 1)
            case "magnitude":
                return None if v.magnitude is None else round(v.magnitude, 1)
            case "duration":
                return round(v.duration_s)
        raise ValueError(attr)

    return value


def _next_visible_attrs(c: IssTrackerCoordinator, now: datetime) -> dict[str, Any]:
    p = c.next_visible_pass(now)
    if p is None or c.data is None:
        return {"upcoming": []}
    epoch = c.data.elements.epoch
    upcoming = [
        visible_pass_attributes(q, epoch)
        for q in c.data.visible_passes
        if q.visible is not None and q.visible.end.time > now
    ][:MAX_LISTED_PASSES]
    return {**visible_pass_attributes(p, epoch), "upcoming": upcoming}


def _next_pass_value(c: IssTrackerCoordinator, now: datetime) -> Any:
    p = c.next_pass(now)
    return None if p is None else p.rise.time.replace(microsecond=0)


def _next_pass_attrs(c: IssTrackerCoordinator, now: datetime) -> dict[str, Any]:
    p = c.next_pass(now)
    if p is None or c.data is None:
        return {}
    return pass_attributes(p, c.data.elements.epoch)


def _elevation_value(c: IssTrackerCoordinator, now: datetime) -> Any:
    return None if c.live is None else round(c.live.look.elevation, 1)


def _elevation_attrs(c: IssTrackerCoordinator, now: datetime) -> dict[str, Any]:
    if c.live is None:
        return {}
    look = c.live.look
    return {
        "azimuth": round(look.azimuth, 1),
        "direction": look.compass,
        "range_km": round(look.range_km),
        "sunlit": c.live.sunlit,
    }


def _epoch_value(c: IssTrackerCoordinator, now: datetime) -> Any:
    return None if c.elements is None else c.elements.epoch.replace(microsecond=0)


def _epoch_attrs(c: IssTrackerCoordinator, now: datetime) -> dict[str, Any]:
    if (e := c.elements) is None:
        return {}
    age = now - e.epoch
    return {
        "source": e.source,
        "format": e.format,
        "downloaded": dt_util.as_local(e.fetched_at.replace(microsecond=0)),
        "age_days": round(age.total_seconds() / 86400, 1),
        "stale": age > ELEMENTS_MAX_AGE,
        "last_download_error": c.elements_error,
    }


def _n2yo_value(c: IssTrackerCoordinator, now: datetime) -> Any:
    # The next few days only: further ahead, two predictions drift apart anyway.
    return None if c.n2yo_check is None else c.n2yo_check.get("near_term_max_difference")


def _n2yo_attrs(c: IssTrackerCoordinator, now: datetime) -> dict[str, Any]:
    return {} if c.n2yo_check is None else dict(c.n2yo_check)


SENSORS: tuple[IssSensorDescription, ...] = (
    IssSensorDescription(
        key="next_visible_pass",
        device_class=SensorDeviceClass.TIMESTAMP,
        value_fn=_next_visible("start"),
        attrs_fn=_next_visible_attrs,
    ),
    IssSensorDescription(
        key="next_visible_pass_peak_elevation",
        native_unit_of_measurement=DEGREE,
        suggested_display_precision=0,
        value_fn=_next_visible("peak_elevation"),
    ),
    IssSensorDescription(
        key="next_visible_pass_magnitude",
        suggested_display_precision=1,
        value_fn=_next_visible("magnitude"),
    ),
    IssSensorDescription(
        key="next_visible_pass_duration",
        device_class=SensorDeviceClass.DURATION,
        native_unit_of_measurement=UnitOfTime.SECONDS,
        suggested_unit_of_measurement=UnitOfTime.MINUTES,
        suggested_display_precision=1,
        value_fn=_next_visible("duration"),
    ),
    IssSensorDescription(
        key="next_pass",
        device_class=SensorDeviceClass.TIMESTAMP,
        value_fn=_next_pass_value,
        attrs_fn=_next_pass_attrs,
    ),
    IssSensorDescription(
        key="elevation",
        native_unit_of_measurement=DEGREE,
        suggested_display_precision=0,
        value_fn=_elevation_value,
        attrs_fn=_elevation_attrs,
    ),
    IssSensorDescription(
        key="elements_epoch",
        device_class=SensorDeviceClass.TIMESTAMP,
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=_epoch_value,
        attrs_fn=_epoch_attrs,
        available_when_stale=True,
    ),
)

N2YO_SENSOR = IssSensorDescription(
    key="n2yo_difference",
    native_unit_of_measurement=DEGREE,
    suggested_display_precision=2,
    entity_category=EntityCategory.DIAGNOSTIC,
    value_fn=_n2yo_value,
    attrs_fn=_n2yo_attrs,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: IssConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up sensors."""
    coordinator = entry.runtime_data
    descriptions = list(SENSORS)
    if coordinator.settings.n2yo_api_key:
        descriptions.append(N2YO_SENSOR)
    else:
        # The key was removed: drop the cross-check sensor rather than leave
        # it behind as an unavailable entity.
        ent_reg = er.async_get(hass)
        if entity_id := ent_reg.async_get_entity_id(
            SENSOR_DOMAIN, DOMAIN, f"{entry.entry_id}_{N2YO_SENSOR.key}"
        ):
            ent_reg.async_remove(entity_id)
    async_add_entities(IssSensor(coordinator, d) for d in descriptions)


class IssSensor(IssEntity, SensorEntity):
    """An ISS prediction or live-position sensor."""

    entity_description: IssSensorDescription
    # Keep out of the recorder database: the list of upcoming passes is large,
    # and the live look angles change on every position update.
    _unrecorded_attributes = frozenset({"upcoming", "azimuth", "direction", "range_km", "sunlit"})

    def __init__(
        self, coordinator: IssTrackerCoordinator, description: IssSensorDescription
    ) -> None:
        """Initialise the sensor."""
        super().__init__(coordinator, description.key)
        self.entity_description = description

    @property
    def available(self) -> bool:
        """Return True while there is something to show."""
        if self.entity_description.available_when_stale:
            return self.coordinator.elements is not None
        return super().available

    @property
    def native_value(self) -> Any:
        """Return the state."""
        return self.entity_description.value_fn(self.coordinator, dt_util.utcnow())

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Return extra attributes."""
        if self.entity_description.attrs_fn is None:
            return None
        return self.entity_description.attrs_fn(self.coordinator, dt_util.utcnow())
