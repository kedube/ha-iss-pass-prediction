"""Live ISS position, computed locally, for map cards."""

from __future__ import annotations

from typing import Any

from homeassistant.components.device_tracker import SourceType, TrackerEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import IssConfigEntry
from .coordinator import IssTrackerCoordinator
from .entity import IssEntity

PARALLEL_UPDATES = 0


async def async_setup_entry(
    hass: HomeAssistant,
    entry: IssConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the position tracker."""
    async_add_entities([IssTracker(entry.runtime_data)])


class IssTracker(IssEntity, TrackerEntity):
    """Ground point beneath the station."""

    _attr_source_type = SourceType.GPS
    # These change on every position update. The latitude and longitude stay
    # recorded, for the trail on map cards.
    _unrecorded_attributes = frozenset({"altitude_km", "speed_km_s", "sunlit"})

    def __init__(self, coordinator: IssTrackerCoordinator) -> None:
        """Initialise the tracker."""
        super().__init__(coordinator, "position")

    @property
    def force_update(self) -> bool:
        """Write only changes; the live timer already updates the position."""
        return False

    @property
    def latitude(self) -> float | None:
        """Latitude of the sub-satellite point."""
        live = self.coordinator.live
        return None if live is None else round(live.subpoint.latitude, 4)

    @property
    def longitude(self) -> float | None:
        """Longitude of the sub-satellite point."""
        live = self.coordinator.live
        return None if live is None else round(live.subpoint.longitude, 4)

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Altitude and speed."""
        live = self.coordinator.live
        if live is None:
            return None
        return {
            "altitude_km": round(live.subpoint.altitude_km, 1),
            "speed_km_s": round(live.subpoint.speed_km_s, 2),
            "sunlit": live.sunlit,
        }
