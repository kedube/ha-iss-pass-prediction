"""Shared entity code for ISS Tracker."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import dt as dt_util

from .const import CONFIDENCE_HIGH_DAYS, CONFIDENCE_MEDIUM_DAYS, DOMAIN, VERSION
from .coordinator import IssTrackerCoordinator
from .predict import Pass, SkyPoint


class IssEntity(CoordinatorEntity[IssTrackerCoordinator]):
    """Base entity bound to one observer location."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: IssTrackerCoordinator, key: str) -> None:
        """Initialise the entity."""
        super().__init__(coordinator)
        entry = coordinator.config_entry
        self._attr_translation_key = key
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="ISS Tracker",
            model="SGP4 pass predictor",
            sw_version=VERSION,
            entry_type=DeviceEntryType.SERVICE,
        )


def _time(t: datetime) -> datetime:
    return dt_util.as_local(t.replace(microsecond=0))


def confidence(when: datetime, epoch: datetime) -> str:
    """How far the timing of a prediction can be trusted (rule of thumb)."""
    days = (when - epoch).total_seconds() / 86400
    if days <= CONFIDENCE_HIGH_DAYS:
        return "high"
    if days <= CONFIDENCE_MEDIUM_DAYS:
        return "medium"
    return "low"


def _point(prefix: str, point: SkyPoint) -> dict[str, Any]:
    return {
        prefix: _time(point.time),
        f"{prefix}_direction": point.compass,
        f"{prefix}_azimuth": round(point.azimuth, 1),
        f"{prefix}_elevation": round(point.elevation, 1),
    }


def visible_pass_attributes(p: Pass, epoch: datetime) -> dict[str, Any]:
    """Attributes describing the visible part of a pass."""
    v = p.visible
    assert v is not None
    return {
        **_point("start", v.start),
        **_point("peak", v.peak),
        **_point("end", v.end),
        "duration_seconds": round(v.duration_s),
        "magnitude": None if v.magnitude is None else round(v.magnitude, 1),
        "appears_from_shadow": v.starts_from_shadow,
        "disappears_into_shadow": v.ends_in_shadow,
        "confidence": confidence(v.start.time, epoch),
    }


def pass_attributes(p: Pass, epoch: datetime) -> dict[str, Any]:
    """Attributes describing a pass above the elevation mask."""
    return {
        **_point("rise", p.rise),
        **_point("culmination", p.culmination),
        **_point("set", p.set),
        "visible": p.visible is not None,
        "confidence": confidence(p.rise.time, epoch),
    }
