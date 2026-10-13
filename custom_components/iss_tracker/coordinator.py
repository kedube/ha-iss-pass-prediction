"""Data coordination for ISS Tracker."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import partial
import logging
import statistics
from typing import TYPE_CHECKING, Any

from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_track_point_in_utc_time
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util
from homeassistant.util.hass_dict import HassKey

from .const import (
    CONF_ALERT_LEAD_MINUTES,
    CONF_FORECAST_DAYS,
    CONF_MAX_SUN_ELEVATION,
    CONF_MIN_ELEVATION,
    CONF_MIN_PEAK_ELEVATION,
    CONF_MIN_VISIBLE_DURATION,
    CONF_N2YO_API_KEY,
    CONF_SHOW_CALENDAR,
    DEFAULT_ALERT_LEAD_MINUTES,
    DEFAULT_FORECAST_DAYS,
    DEFAULT_MAX_SUN_ELEVATION,
    DEFAULT_MIN_ELEVATION,
    DEFAULT_MIN_PEAK_ELEVATION,
    DEFAULT_MIN_VISIBLE_DURATION,
    DEFAULT_SHOW_CALENDAR,
    DOMAIN,
    ELEMENTS_MAX_AGE,
    ELEMENTS_MIN_RETRY_INTERVAL,
    ELEMENTS_REFRESH_INTERVAL,
    ELEMENTS_UNREACHABLE_RETRY_INTERVAL,
    ISSUE_ELEMENTS_STALE,
    LIVE_INTERVAL_IDLE,
    LIVE_INTERVAL_PASS,
    N2YO_CHECK_INTERVAL,
    PASS_UPDATE_INTERVAL,
    STORAGE_KEY,
    STORAGE_VERSION,
    USER_AGENT,
)
from .elements import (
    SOURCE_CELESTRAK,
    SOURCE_N2YO,
    SOURCE_WHERETHEISS,
    ElementsError,
    OrbitalElements,
    SourceUnavailableError,
    fetch_celestrak,
    fetch_n2yo,
    fetch_n2yo_visual_passes,
    fetch_wheretheiss,
)
from .predict import (
    Observer,
    Pass,
    PassPredictor,
    PropagationError,
    SkyPoint,
    SubPoint,
    angular_separation,
)

if TYPE_CHECKING:
    from . import IssConfigEntry

_LOGGER = logging.getLogger(__name__)

DATA_ELEMENTS: HassKey[ElementsManager] = HassKey(DOMAIN)

_HEADERS = {"User-Agent": USER_AGENT}
# Elements older than this send the download on to the next source, a day
# before they would pause predictions.
_STALE_AGE = ELEMENTS_MAX_AGE - timedelta(days=1)


class ElementsManager:
    """Downloads and caches orbital elements, shared by every config entry.

    The newest elements are kept in Home Assistant storage, so a restart does
    not trigger a download and predictions keep working while offline.
    """

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialise the manager."""
        self._hass = hass
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._lock = asyncio.Lock()
        self._loaded = False
        self._retry_after: dict[str, datetime] = {}
        self._failing = False
        self.elements: OrbitalElements | None = None
        self.last_error: str | None = None

    async def async_get(self, n2yo_api_key: str | None) -> OrbitalElements:
        """Return current elements, downloading new ones when due."""
        async with self._lock:
            if not self._loaded:
                await self._async_load()
            now = dt_util.utcnow()
            # No back-off is longer than ELEMENTS_MIN_RETRY_INTERVAL. One further
            # ahead was set while the clock ran fast and has since been set
            # back, whether or not anything downloaded meanwhile.
            self._retry_after = {
                name: when
                for name, when in self._retry_after.items()
                if when - now <= ELEMENTS_MIN_RETRY_INTERVAL
            }
            due = self.elements is None
            if self.elements is not None:
                age = now - self.elements.fetched_at
                # A download in the future means the clock was set back since:
                # refresh rather than wait for the clock to catch up.
                due = age < -ELEMENTS_MIN_RETRY_INTERVAL or age >= ELEMENTS_REFRESH_INTERVAL
            if due:
                await self._async_refresh(now, n2yo_api_key)
            if self.elements is None:
                raise ElementsError(self.last_error or "No orbital elements available")
            return self.elements

    async def _async_load(self) -> None:
        self._loaded = True
        stored = await self._store.async_load()
        if not stored:
            return
        try:
            self.elements = OrbitalElements.from_dict(stored)
        except (ElementsError, KeyError, TypeError, ValueError) as err:
            _LOGGER.warning("Ignoring unreadable cached orbital elements: %s", err)

    async def _async_refresh(self, now: datetime, n2yo_api_key: str | None) -> None:
        session = async_get_clientsession(self._hass)
        # Every location shares these elements, so a location without a key of
        # its own still lets N2YO be asked when another location has one.
        n2yo_api_key = n2yo_api_key or next(
            (
                key
                for entry in self._hass.config_entries.async_entries(
                    DOMAIN, include_ignore=False, include_disabled=False
                )
                if (key := entry.options.get(CONF_N2YO_API_KEY))
            ),
            None,
        )
        sources: list[tuple[str, Callable[[], Any]]] = [
            (SOURCE_CELESTRAK, partial(fetch_celestrak, session, _HEADERS)),
            (SOURCE_WHERETHEISS, partial(fetch_wheretheiss, session, _HEADERS)),
        ]
        if n2yo_api_key:
            sources.append((SOURCE_N2YO, partial(fetch_n2yo, session, _HEADERS, n2yo_api_key)))

        errors: list[str] = []
        stale: OrbitalElements | None = None
        for name, fetch in sources:
            if now < self._retry_after.get(name, now):
                continue
            try:
                candidate: OrbitalElements = await fetch()
            except SourceUnavailableError as err:
                self._retry_after[name] = now + ELEMENTS_UNREACHABLE_RETRY_INTERVAL
                errors.append(str(err))
                continue
            except ElementsError as err:
                self._retry_after[name] = now + ELEMENTS_MIN_RETRY_INTERVAL
                errors.append(str(err))
                continue
            # Never download from the same source more than once per interval.
            self._retry_after[name] = now + ELEMENTS_MIN_RETRY_INTERVAL
            if self.elements is not None and candidate.epoch < self.elements.epoch:
                # A mirror that lags behind must not replace newer elements.
                _LOGGER.debug("%s has older elements than the cache; ignoring", name)
                continue
            age = now - candidate.epoch
            if age > _STALE_AGE:
                # A mirror that stopped updating must not hide a fresher source.
                errors.append(f"{name}: elements are {age.days} days old")
                if stale is None or candidate.epoch > stale.epoch:
                    stale = candidate
                continue
            self.elements = candidate
            self.last_error = None
            await self._store.async_save(candidate.as_dict())
            if self._failing:
                _LOGGER.info("ISS orbital elements downloaded again from %s", name)
            self._failing = False
            _LOGGER.debug("Orbital elements from %s, epoch %s", name, candidate.epoch)
            return

        if stale is not None and (self.elements is None or stale.epoch >= self.elements.epoch):
            # The best there is, though old. Keeping it restarts the refresh
            # interval, so the sources are not asked again straight away.
            self.elements = stale
            await self._store.async_save(stale.as_dict())
        if not errors:
            return
        self.last_error = "; ".join(errors)
        # Log loudly once per outage, then quietly until a download succeeds.
        log = _LOGGER.debug if self._failing else _LOGGER.warning
        self._failing = True
        if self.elements is None:
            log("Could not download ISS orbital elements: %s", self.last_error)
        else:
            log(
                "Could not refresh ISS orbital elements, using cached elements from %s: %s",
                self.elements.epoch,
                self.last_error,
            )


@dataclass(frozen=True, slots=True)
class PredictionSettings:
    """User-tunable settings, from the options flow."""

    min_elevation: float
    min_peak_elevation: float
    max_sun_elevation: float
    min_visible_duration: float
    forecast_days: int
    alert_lead: timedelta
    n2yo_api_key: str | None
    show_in_calendar: bool

    @classmethod
    def from_options(cls, options: dict[str, Any]) -> PredictionSettings:
        """Build settings, filling in defaults."""
        return cls(
            min_elevation=float(options.get(CONF_MIN_ELEVATION, DEFAULT_MIN_ELEVATION)),
            min_peak_elevation=float(
                options.get(CONF_MIN_PEAK_ELEVATION, DEFAULT_MIN_PEAK_ELEVATION)
            ),
            max_sun_elevation=float(options.get(CONF_MAX_SUN_ELEVATION, DEFAULT_MAX_SUN_ELEVATION)),
            min_visible_duration=float(
                options.get(CONF_MIN_VISIBLE_DURATION, DEFAULT_MIN_VISIBLE_DURATION)
            ),
            forecast_days=int(options.get(CONF_FORECAST_DAYS, DEFAULT_FORECAST_DAYS)),
            alert_lead=timedelta(
                minutes=float(options.get(CONF_ALERT_LEAD_MINUTES, DEFAULT_ALERT_LEAD_MINUTES))
            ),
            n2yo_api_key=options.get(CONF_N2YO_API_KEY) or None,
            show_in_calendar=bool(options.get(CONF_SHOW_CALENDAR, DEFAULT_SHOW_CALENDAR)),
        )


@dataclass(frozen=True, slots=True)
class IssData:
    """Result of one prediction run."""

    elements: OrbitalElements
    passes: list[Pass]
    visible_passes: list[Pass]
    computed_at: datetime


@dataclass(frozen=True, slots=True)
class LiveState:
    """Where the station is right now."""

    look: SkyPoint
    subpoint: SubPoint
    sunlit: bool


class IssTrackerCoordinator(DataUpdateCoordinator[IssData]):
    """Recomputes passes for one observer and tracks the station live."""

    config_entry: IssConfigEntry

    def __init__(
        self, hass: HomeAssistant, entry: IssConfigEntry, manager: ElementsManager
    ) -> None:
        """Initialise the coordinator."""
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=f"{DOMAIN} {entry.title}",
            update_interval=PASS_UPDATE_INTERVAL,
        )
        self._manager = manager
        self.observer = Observer(
            entry.data[CONF_LATITUDE],
            entry.data[CONF_LONGITUDE],
            entry.data.get(CONF_ELEVATION, 0.0),
        )
        self.settings = PredictionSettings.from_options(dict(entry.options))
        self.live: LiveState | None = None
        self.n2yo_check: dict[str, Any] | None = None
        self._live_predictor: PassPredictor | None = None
        self._unsub_live: CALLBACK_TYPE | None = None
        self._last_n2yo_check: datetime | None = None

    def new_predictor(self) -> PassPredictor | None:
        """Return a predictor of its own, safe to use from an executor thread."""
        if self.data is None:
            return None
        return PassPredictor(self.data.elements.satrec(), self.observer)

    @property
    def live_predictor(self) -> PassPredictor | None:
        """Predictor for use on the event loop (live position, ground track)."""
        return self._live_predictor

    @property
    def elements_error(self) -> str | None:
        """Most recent download error, if the last refresh attempt failed."""
        return self._manager.last_error

    @property
    def elements(self) -> OrbitalElements | None:
        """The cached orbital elements, kept even while predictions are paused."""
        return self._manager.elements

    async def _async_update_data(self) -> IssData:
        try:
            elements = await self._manager.async_get(self.settings.n2yo_api_key)
        except ElementsError as err:
            raise UpdateFailed(f"No ISS orbital elements: {err}") from err

        now = dt_util.utcnow()
        age = now - elements.epoch
        if age > ELEMENTS_MAX_AGE:
            cause = self._manager.last_error or "no newer elements were found"
            # One issue for every location: they all share the same elements.
            ir.async_create_issue(
                self.hass,
                DOMAIN,
                ISSUE_ELEMENTS_STALE,
                is_fixable=False,
                severity=ir.IssueSeverity.WARNING,
                translation_key=ISSUE_ELEMENTS_STALE,
                translation_placeholders={"age": str(age.days), "error": cause},
            )
            raise UpdateFailed(
                f"ISS orbital elements are {age.days} days old and could not be "
                f"refreshed ({cause}); predictions are paused until fresh elements download"
            )
        ir.async_delete_issue(self.hass, DOMAIN, ISSUE_ELEMENTS_STALE)

        s = self.settings
        # The SGP4 record is mutated during propagation, so the background
        # search and the live tracker each get their own copy.
        search = PassPredictor(elements.satrec(), self.observer)
        try:
            passes = await self.hass.async_add_executor_job(
                partial(
                    search.find_passes,
                    now,
                    now + timedelta(days=s.forecast_days),
                    min_elevation=s.min_elevation,
                    max_sun_elevation=s.max_sun_elevation,
                )
            )
        except PropagationError as err:
            raise UpdateFailed(f"Could not propagate ISS orbit: {err}") from err

        visible = [
            p
            for p in passes
            if p.visible is not None
            and p.visible.peak.elevation >= s.min_peak_elevation
            and p.visible.duration_s >= s.min_visible_duration
        ]
        self._live_predictor = PassPredictor(elements.satrec(), self.observer)
        self._async_maybe_start_cross_check(now)
        return IssData(elements, passes, visible, now)

    # -- live tracking ---------------------------------------------------

    @callback
    def async_start_live(self) -> CALLBACK_TYPE:
        """Start the local live-position timer; returns a stop callback."""
        self._async_live_tick()
        return self._async_stop_live

    @callback
    def _async_stop_live(self) -> None:
        if self._unsub_live is not None:
            self._unsub_live()
            self._unsub_live = None

    @callback
    def _async_live_tick(self, _now: datetime | None = None) -> None:
        self._unsub_live = None
        now = dt_util.utcnow()
        interval = LIVE_INTERVAL_IDLE
        if self._live_predictor is not None:
            try:
                look = self._live_predictor.look(now)
                self.live = LiveState(
                    look,
                    self._live_predictor.subpoint(now),
                    self._live_predictor.is_sunlit(now),
                )
            except PropagationError as err:
                _LOGGER.debug("Live position unavailable: %s", err)
                self.live = None
            else:
                if look.elevation > 0:
                    interval = LIVE_INTERVAL_PASS
        self.async_update_listeners()

        next_at = now + interval
        boundary = self._next_boundary(now)
        if boundary is not None and boundary < next_at:
            next_at = boundary
        self._unsub_live = async_track_point_in_utc_time(self.hass, self._async_live_tick, next_at)

    def _next_boundary(self, now: datetime) -> datetime | None:
        """Earliest upcoming moment at which an entity changes state."""
        if self.data is None:
            return None
        times: list[datetime] = []
        for p in self.data.passes:
            times += [p.rise.time, p.set.time]
        for p in self.data.visible_passes:
            assert p.visible is not None
            times += [
                p.visible.start.time - self.settings.alert_lead,
                p.visible.start.time,
                p.visible.end.time,
            ]
        future = [t for t in times if t > now]
        return min(future) if future else None

    # -- queries used by entities ---------------------------------------

    def next_visible_pass(self, now: datetime) -> Pass | None:
        """Return the visible pass in progress, or else the next one."""
        if self.data is None:
            return None
        for p in self.data.visible_passes:
            assert p.visible is not None
            if p.visible.end.time > now:
                return p
        return None

    def next_pass(self, now: datetime) -> Pass | None:
        """Return the pass above the elevation mask in progress, or else the next one."""
        if self.data is None:
            return None
        return next((p for p in self.data.passes if p.set.time > now), None)

    def above_horizon(self, now: datetime) -> bool:
        """Whether the station is above the elevation mask (lit or not)."""
        p = self.next_pass(now)
        return p is not None and p.rise.time <= now

    def visible_now(self, now: datetime) -> bool:
        """Whether a qualifying visible pass is under way."""
        p = self.next_visible_pass(now)
        return p is not None and p.visible is not None and p.visible.start.time <= now

    def visible_pass_soon(self, now: datetime) -> bool:
        """Whether a qualifying visible pass starts within the alert lead time."""
        p = self.next_visible_pass(now)
        return (
            p is not None
            and p.visible is not None
            and p.visible.start.time - self.settings.alert_lead <= now
        )

    # -- optional N2YO cross-check --------------------------------------

    @callback
    def _async_maybe_start_cross_check(self, now: datetime) -> None:
        """Start the daily comparison with N2YO, without waiting for it.

        It only feeds a diagnostic sensor, so setup and refreshes must not be
        held up by a slow N2YO. The task ends with the config entry.
        """
        key = self.settings.n2yo_api_key
        if not key or self._live_predictor is None:
            return
        if self._last_n2yo_check is not None and now - self._last_n2yo_check < N2YO_CHECK_INTERVAL:
            return
        self._last_n2yo_check = now
        self.config_entry.async_create_background_task(
            self.hass,
            self._async_cross_check(key, now),
            f"{DOMAIN} N2YO cross-check",
            eager_start=False,
        )

    async def _async_cross_check(self, key: str, now: datetime) -> None:
        try:
            n2yo_passes = await fetch_n2yo_visual_passes(
                async_get_clientsession(self.hass),
                _HEADERS,
                key,
                self.observer.latitude,
                self.observer.longitude,
                self.observer.elevation_m,
                min(self.settings.forecast_days, 10),
            )
        except ElementsError as err:
            _LOGGER.warning("N2YO cross-check failed: %s", err)
            self.n2yo_check = {"checked_at": now, "error": str(err)}
        else:
            if self._live_predictor is None:
                return
            self.n2yo_check = {
                "checked_at": now,
                **compare_with_n2yo(self._live_predictor, n2yo_passes),
            }
        self.async_update_listeners()


def compare_with_n2yo(
    predictor: PassPredictor, n2yo_passes: list[dict[str, Any]]
) -> dict[str, Any]:
    """Compare N2YO's predicted sky positions with this engine's.

    For the start, peak and end of every N2YO visible pass, compute where this
    engine places the station at that same instant and measure the angle
    between the two predictions. The comparison needs no agreement on what
    counts as the start or end of a pass. Near the peak the station moves about
    a degree per second, so the angle is roughly the timing difference in
    seconds.
    """
    separations: list[float] = []
    compared = 0
    for item in n2yo_passes:
        if not isinstance(item, dict):
            continue
        used = False
        for prefix in ("start", "max", "end"):
            try:
                when = dt_util.utc_from_timestamp(float(item[f"{prefix}UTC"]))
                az = float(item[f"{prefix}Az"])
                el = float(item[f"{prefix}El"])
            except (KeyError, TypeError, ValueError):
                continue
            try:
                mine = predictor.look(when)
            except PropagationError:
                continue
            separations.append(angular_separation(mine.azimuth, mine.elevation, az, el))
            used = True
        if used:
            compared += 1
    if not separations:
        return {"compared_passes": 0, "max_difference": None, "median_difference": None}
    return {
        "compared_passes": compared,
        "max_difference": round(max(separations), 2),
        "median_difference": round(statistics.median(separations), 2),
    }
