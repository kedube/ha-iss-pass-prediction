"""Calendar of the visible passes, for Home Assistant's calendar and calendar triggers."""

from __future__ import annotations

from collections.abc import Collection
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from homeassistant.components.calendar import CalendarEntity, CalendarEvent
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.translation import async_get_translations
from homeassistant.util import dt as dt_util

from . import IssConfigEntry
from .const import DOMAIN
from .coordinator import IssData, IssTrackerCoordinator
from .entity import IssEntity, confidence
from .predict import Pass, SkyPoint

PARALLEL_UPDATES = 0

TRANSLATIONS_DIR = Path(__file__).parent / "translations"
_PREFIX = f"component.{DOMAIN}.common."
# Event times are whole seconds, like the sensors'. A visible window shorter
# than a second (possible with a minimum visible time of 0 s) still lasts one,
# so the calendar turns on for it as it does for any other pass.
_MIN_EVENT = timedelta(seconds=1)


def resolve_language(language: str, available: Collection[str]) -> str:
    """Pick the translation for a Home Assistant language, as the globe does.

    "de-CH" gets German and "pt" Brazilian Portuguese; a language without a
    translation gets English.
    """
    if language in available:
        return language
    base = language.replace("_", "-").split("-")[0].lower()
    return next((code for code in sorted(available) if code.split("-")[0] == base), "en")


def _languages() -> set[str]:
    return {path.stem for path in TRANSLATIONS_DIR.glob("*.json")}


async def async_pass_text(hass: HomeAssistant) -> PassText:
    """Load the words for the events, in Home Assistant's language.

    Home Assistant fills in English for any string a translation lacks.
    """
    language = resolve_language(hass.config.language, await hass.async_add_executor_job(_languages))
    strings = await async_get_translations(hass, language, "common", [DOMAIN])
    return PassText({key.removeprefix(_PREFIX): value for key, value in strings.items()})


class PassText:
    """Words for the visible passes, in one language."""

    def __init__(self, strings: dict[str, str]) -> None:
        """Initialise with the integration's common strings, keyed without their prefix."""
        self._strings = strings

    def _t(self, key: str, **values: Any) -> str:
        return self._strings[key].format(**values)

    def _direction(self, point: SkyPoint) -> str:
        return self._t(f"compass_{point.compass.lower()}")

    def _number(self, value: float) -> str:
        # Adding 0.0 turns -0.0 into 0.0.
        return f"{round(value, 1) + 0.0:.1f}".replace(".", self._t("decimal_separator"))

    def summary(self, p: Pass) -> str:
        """Event title: what it is and how high it climbs."""
        assert p.visible is not None
        return self._t("calendar_summary", elevation=round(p.visible.peak.elevation))

    def description(self, p: Pass, epoch: datetime) -> str:
        """Where to look, how bright it is and how far the timing can be trusted."""
        v = p.visible
        assert v is not None
        path = self._t(
            "calendar_fades" if v.ends_in_shadow else "calendar_sets",
            start=self._direction(v.start),
            start_elevation=round(v.start.elevation),
            peak=self._direction(v.peak),
            peak_elevation=round(v.peak.elevation),
            end=self._direction(v.end),
        )
        details = [self._t(f"confidence_{confidence(v.start.time, epoch)}")]
        if v.magnitude is not None:
            details.insert(0, self._t("calendar_brightness", magnitude=self._number(v.magnitude)))
        line = " · ".join(details)
        return f"{path}\n{line[:1].upper()}{line[1:]}"


def event_times(p: Pass) -> tuple[datetime, datetime]:
    """Start and end of the visible window, to the second as the sensors give them."""
    v = p.visible
    assert v is not None
    start = dt_util.as_local(v.start.time.replace(microsecond=0))
    end = dt_util.as_local(v.end.time.replace(microsecond=0))
    return start, max(end, start + _MIN_EVENT)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: IssConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the calendar (only forwarded while the option is on)."""
    async_add_entities([IssPassCalendar(entry.runtime_data, await async_pass_text(hass))])


class IssPassCalendar(IssEntity, CalendarEntity):
    """The visible passes in the forecast window, the same ones the sensors report."""

    def __init__(self, coordinator: IssTrackerCoordinator, text: PassText) -> None:
        """Initialise the calendar."""
        super().__init__(coordinator, "visible_passes")
        self._text = text
        # The first state is written with the passes there are now.
        self._written_data: IssData | None = coordinator.data
        self._written_success = coordinator.last_update_success

    def _event(self, p: Pass, start: datetime, end: datetime) -> CalendarEvent:
        assert self.coordinator.data is not None
        return CalendarEvent(
            start=start,
            end=end,
            summary=self._text.summary(p),
            description=self._text.description(p, self.coordinator.data.elements.epoch),
            uid=f"{self.coordinator.config_entry.entry_id}_{int(start.timestamp())}",
        )

    @property
    def event(self) -> CalendarEvent | None:
        """The visible pass under way, or else the next one.

        Judged by the event's own times, so that at the end of an event, when
        the calendar's timer writes the state, it moves on to the next pass.
        """
        data = self.coordinator.data
        if not self.available or data is None:
            return None
        now = dt_util.now()
        for p in data.visible_passes:
            start, end = event_times(p)
            if end > now:
                return self._event(p, start, end)
        return None

    async def async_get_events(
        self, hass: HomeAssistant, start_date: datetime, end_date: datetime
    ) -> list[CalendarEvent]:
        """Return the visible passes that overlap the requested range.

        Nothing while predictions are paused: the sensors are unavailable then,
        and passes predicted from elements that old would mislead.
        """
        data = self.coordinator.data
        if not self.available or data is None:
            return []
        events = []
        for p in data.visible_passes:
            start, end = event_times(p)
            if end > start_date and start < end_date:
                events.append(self._event(p, start, end))
        return events

    @callback
    def _handle_coordinator_update(self) -> None:
        """Write the state when the passes change, not with every live position.

        The coordinator updates its entities every 10 to 60 seconds for the
        live position. The calendar's own timers follow the start and end of
        each pass, and every write makes open calendars fetch the events again.
        """
        data, success = self.coordinator.data, self.coordinator.last_update_success
        if data is self._written_data and success == self._written_success:
            return
        self._written_data, self._written_success = data, success
        super()._handle_coordinator_update()
