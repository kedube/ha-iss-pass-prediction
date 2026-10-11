"""Binary sensors for ISS Tracker."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from homeassistant.components.binary_sensor import (
    BinarySensorEntity,
    BinarySensorEntityDescription,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from . import IssConfigEntry
from .coordinator import IssTrackerCoordinator
from .entity import IssEntity

PARALLEL_UPDATES = 0


@dataclass(frozen=True, kw_only=True)
class IssBinarySensorDescription(BinarySensorEntityDescription):
    """Describes an ISS binary sensor."""

    is_on_fn: Callable[[IssTrackerCoordinator, datetime], bool]


BINARY_SENSORS: tuple[IssBinarySensorDescription, ...] = (
    IssBinarySensorDescription(
        key="visible_now",
        is_on_fn=lambda c, now: c.visible_now(now),
    ),
    IssBinarySensorDescription(
        key="visible_pass_soon",
        is_on_fn=lambda c, now: c.visible_pass_soon(now),
    ),
    IssBinarySensorDescription(
        key="above_horizon",
        is_on_fn=lambda c, now: c.above_horizon(now),
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: IssConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up binary sensors."""
    coordinator = entry.runtime_data
    async_add_entities(IssBinarySensor(coordinator, d) for d in BINARY_SENSORS)


class IssBinarySensor(IssEntity, BinarySensorEntity):
    """An ISS pass binary sensor."""

    entity_description: IssBinarySensorDescription

    def __init__(
        self, coordinator: IssTrackerCoordinator, description: IssBinarySensorDescription
    ) -> None:
        """Initialise the binary sensor."""
        super().__init__(coordinator, description.key)
        self.entity_description = description

    @property
    def is_on(self) -> bool:
        """Return true if the condition holds now."""
        return self.entity_description.is_on_fn(self.coordinator, dt_util.utcnow())
