"""Globe card, sidebar panel and the websocket API they use."""

from __future__ import annotations

from datetime import datetime, timedelta
import hashlib
import inspect
import logging
import math
from pathlib import Path
from typing import Any

from homeassistant.components import frontend, panel_custom, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import (
    SIGNAL_CONFIG_ENTRY_CHANGED,
    ConfigEntry,
    ConfigEntryChange,
    ConfigEntryState,
)
from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv, issue_registry as ir
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.util import dt as dt_util
from homeassistant.util.hass_dict import HassKey
import voluptuous as vol

from .const import (
    CONF_SHOW_PANEL,
    DEFAULT_SHOW_PANEL,
    DOMAIN,
    ELEMENTS_MAX_AGE,
    FRONTEND_URL,
    ISSUE_ELEMENTS_STALE,
    MAX_LISTED_PASSES,
    NEXT_PASS_PATH_STEP_S,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL_PATH,
    PATH_MAX_POINTS,
    PATH_MAX_SPAN,
    TRACK_FUTURE,
    TRACK_PAST,
    TRACK_STEP_S,
    VISIBLE_PATH_STEP_S,
)
from .coordinator import IssPassCoordinator
from .entity import confidence, pass_attributes, visible_pass_attributes
from .predict import Pass, PassPredictor, PropagationError, TrackPoint

_LOGGER = logging.getLogger(__name__)

FRONTEND_DIR = Path(__file__).parent / "frontend"
DATA_FRONTEND: HassKey[FrontendState] = HassKey(f"{DOMAIN}_frontend")

# Websocket error codes, besides Home Assistant's own.
ERR_UNKNOWN_LOCATION = "unknown_location"
ERR_LOCATION_DISABLED = "location_disabled"
ERR_NOT_READY = "not_ready"
ERR_STALE_ELEMENTS = "stale_elements"

# Paths far from the epoch of the orbital elements are meaningless, and SGP4
# often returns positions for them without complaint. Anything the globe asks
# for (up to a forecast window ahead of elements at the age limit) fits.
PATH_EPOCH_RANGE = ELEMENTS_MAX_AGE + PATH_MAX_SPAN + timedelta(days=1)

# Home Assistant pads custom panels for the screen's safe areas (notches, home
# indicator) unless they opt out; the panel handles them itself. Cores older
# than the option do not pad.
_PANEL_HANDLES_SAFE_AREA = (
    "handle_safe_area" in inspect.signature(panel_custom.async_register_panel).parameters
)


class FrontendState:
    """What has been registered with the frontend in this run."""

    def __init__(self, version: str) -> None:
        """Initialise."""
        self.version = version
        self.panel_registered = False
        self.panel_conflict_logged = False


def _files_version() -> str:
    """Short hash of the frontend files, so browsers fetch new versions after updates."""
    digest = hashlib.sha256()
    for path in sorted(FRONTEND_DIR.glob("*.js")):
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


async def async_setup_frontend(hass: HomeAssistant) -> None:
    """Serve the frontend files and register the card and the websocket API."""
    version = await hass.async_add_executor_job(_files_version)
    hass.data[DATA_FRONTEND] = FrontendState(version)
    # The modules are revalidated rather than cached forever; the entry modules
    # carry the version so a new release is picked up straight away. MapLibre
    # (its folder names the version) and the images never change, so browsers
    # may keep them. Both folders also hold pre-compressed copies, which are
    # served to browsers that accept them.
    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(FRONTEND_URL, str(FRONTEND_DIR), cache_headers=False),
            StaticPathConfig(
                f"{FRONTEND_URL}/vendor", str(FRONTEND_DIR / "vendor"), cache_headers=True
            ),
            StaticPathConfig(f"{FRONTEND_URL}/img", str(FRONTEND_DIR / "img"), cache_headers=True),
        ]
    )
    frontend.add_extra_js_url(hass, f"{FRONTEND_URL}/iss-globe-card.js?v={version}")
    websocket_api.async_register_command(hass, ws_locations)
    websocket_api.async_register_command(hass, ws_track)
    websocket_api.async_register_command(hass, ws_path)

    @callback
    def _async_entry_changed(change: ConfigEntryChange, entry: ConfigEntry) -> None:
        # Disabling a location that is not loaded (one still retrying setup,
        # say) runs none of the integration's hooks, so look at the panel and
        # the repair issue here.
        if entry.domain == DOMAIN and entry.disabled_by is not None:
            hass.async_create_task(async_update_panel(hass))
            async_clear_stale_issue(hass)

    async_dispatcher_connect(hass, SIGNAL_CONFIG_ENTRY_CHANGED, _async_entry_changed)


@callback
def async_clear_stale_issue(hass: HomeAssistant) -> None:
    """Drop the paused-predictions repair once no enabled location is left to fix."""
    if not any(e.disabled_by is None for e in hass.config_entries.async_entries(DOMAIN)):
        ir.async_delete_issue(hass, DOMAIN, ISSUE_ELEMENTS_STALE)


def _loaded_entries(hass: HomeAssistant) -> list:
    return [
        e for e in hass.config_entries.async_entries(DOMAIN) if e.state is ConfigEntryState.LOADED
    ]


def _panel_wanted(entry: Any) -> bool:
    return bool(entry.options.get(CONF_SHOW_PANEL, DEFAULT_SHOW_PANEL))


async def async_update_panel(
    hass: HomeAssistant, *, adding: Any | None = None, removing: Any | None = None
) -> None:
    """Show the sidebar panel while any enabled location has it switched on.

    Enabled rather than loaded, so that reloading a location (after an options
    change, say) does not take the page away from anyone looking at it.
    ``adding`` is an entry being set up and ``removing`` one being deleted.
    Never raises, and never touches a panel this integration did not add.
    """
    state = hass.data.get(DATA_FRONTEND)
    if state is None:
        return
    entries = [
        e
        for e in hass.config_entries.async_entries(DOMAIN)
        if e.disabled_by is None and e is not removing
    ]
    if adding is not None and adding not in entries:
        entries.append(adding)
    wanted = any(_panel_wanted(e) for e in entries)

    if wanted and not state.panel_registered:
        if PANEL_URL_PATH in hass.data.get(frontend.DATA_PANELS, {}):
            # A dashboard (or another integration) already uses the address.
            if not state.panel_conflict_logged:
                state.panel_conflict_logged = True
                _LOGGER.warning(
                    "/%s is already used by another dashboard or panel, so the %s "
                    "sidebar page was not added. The globe card still works",
                    PANEL_URL_PATH,
                    PANEL_TITLE,
                )
            return
        extra: dict[str, Any] = {"handle_safe_area": True} if _PANEL_HANDLES_SAFE_AREA else {}
        try:
            await panel_custom.async_register_panel(
                hass,
                frontend_url_path=PANEL_URL_PATH,
                webcomponent_name="iss-tracker-panel",
                sidebar_title=PANEL_TITLE,
                sidebar_icon=PANEL_ICON,
                module_url=f"{FRONTEND_URL}/iss-tracker-panel.js?v={state.version}",
                embed_iframe=False,
                require_admin=False,
                config={"version": state.version},
                **extra,
            )
        except ValueError as err:
            _LOGGER.warning("Could not add the %s sidebar page: %s", PANEL_TITLE, err)
            return
        state.panel_registered = True
    elif not wanted and state.panel_registered:
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
        state.panel_registered = False


def _coordinator(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> IssPassCoordinator | None:
    """Return the loaded location a request is for, or send an error saying why there is none."""
    entries = hass.config_entries.async_entries(DOMAIN)
    if not entries:
        connection.send_error(
            msg["id"], websocket_api.ERR_NOT_FOUND, "No ISS Pass Prediction location is set up"
        )
        return None
    if (entry_id := msg.get("entry_id")) is not None:
        entries = [e for e in entries if e.entry_id == entry_id]
        if not entries:
            connection.send_error(
                msg["id"],
                ERR_UNKNOWN_LOCATION,
                "This ISS Pass Prediction location no longer exists",
            )
            return None
    for entry in entries:
        if entry.state is ConfigEntryState.LOADED:
            return entry.runtime_data
    enabled = [e for e in entries if e.disabled_by is None]
    if not enabled:
        # Not something waiting will fix.
        connection.send_error(msg["id"], ERR_LOCATION_DISABLED, "This location is disabled")
    else:
        connection.send_error(msg["id"], ERR_NOT_READY, enabled[0].reason or "Starting up")
    return None


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/locations"})
@callback
def ws_locations(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """List the configured locations."""
    connection.send_result(
        msg["id"],
        [
            {
                "entry_id": e.entry_id,
                "title": e.title,
                "show_in_sidebar": _panel_wanted(e),
            }
            for e in _loaded_entries(hass)
        ],
    )


def _unix(t: datetime) -> float:
    """Unix time to the millisecond; whole seconds stay integers to keep payloads small."""
    seconds = round(t.timestamp(), 3)
    return int(seconds) if seconds.is_integer() else seconds


def _track_json(points: list[TrackPoint]) -> list[list[float]]:
    """Compact rows: unix time, latitude, longitude, altitude km, sunlit (0/1)."""
    return [
        [
            _unix(p.time),
            round(p.latitude, 4),
            round(p.longitude, 4),
            round(p.altitude_km, 1),
            1 if p.sunlit else 0,
        ]
        for p in points
    ]


def paused_reason(coordinator: IssPassCoordinator, now: datetime) -> str | None:
    """Why predictions are paused, or None while they can be trusted.

    This mirrors the entities, which go unavailable at the same time.
    """
    data = coordinator.data
    if data is None:
        return "Waiting for ISS orbital elements"
    if not coordinator.last_update_success:
        return str(coordinator.last_exception or "Predictions could not be updated")
    age = now - data.elements.epoch
    if age > ELEMENTS_MAX_AGE:
        return f"Orbit data is {age.days} days old"
    return None


def pass_status(coordinator: IssPassCoordinator, predictor: PassPredictor, p: Pass) -> str:
    """Whether a pass qualifies for the visible-pass sensors, or why not.

    ``visible``, or ``low`` or ``brief`` for a visible pass that the minimum
    peak elevation or visible time leaves out. A pass that cannot be seen at
    all is ``shadow`` when the station is in Earth's shadow at culmination,
    otherwise ``daylight`` (the Sun is up) or ``twilight`` (the sky is too
    bright for the darkness threshold).
    """
    data = coordinator.data
    if data is not None and p in data.visible_passes:
        return "visible"
    if p.visible is not None:
        if p.visible.peak.elevation < coordinator.settings.min_peak_elevation:
            return "low"
        return "brief"
    when = p.culmination.time
    if not predictor.is_sunlit(when):
        return "shadow"
    return "daylight" if predictor.sun_elevation(when) > 0 else "twilight"


def build_track_payload(coordinator: IssPassCoordinator) -> dict[str, Any]:
    """Everything the globe needs: ground track, location and pass countdowns."""
    utcnow = dt_util.utcnow()
    now = utcnow.replace(microsecond=0)
    predictor = coordinator.live_predictor
    data = coordinator.data
    if predictor is None or data is None:
        raise PropagationError("No orbital elements loaded yet")

    entry = coordinator.config_entry
    settings = coordinator.settings
    epoch = data.elements.epoch
    paused = paused_reason(coordinator, now)
    payload: dict[str, Any] = {
        "generated_at": now.isoformat(),
        # Precise, so the globe can allow for a browser clock that is off.
        "server_time": utcnow.timestamp(),
        "paused": paused,
        "location": {
            "entry_id": entry.entry_id,
            "title": entry.title,
            "latitude": entry.data[CONF_LATITUDE],
            "longitude": entry.data[CONF_LONGITUDE],
            "elevation": entry.data.get(CONF_ELEVATION, 0.0),
        },
        "settings": {
            "min_elevation": settings.min_elevation,
            "min_peak_elevation": settings.min_peak_elevation,
            "max_sun_elevation": settings.max_sun_elevation,
            "min_visible_duration": settings.min_visible_duration,
            "forecast_days": settings.forecast_days,
        },
        "elements": {
            "epoch": epoch.isoformat(),
            "source": data.elements.source,
            "age_days": round((utcnow - epoch).total_seconds() / 86400, 2),
        },
        "track": _track_json(predictor.track(now - TRACK_PAST, now + TRACK_FUTURE, TRACK_STEP_S)),
        "next_visible_pass": None,
        "upcoming_visible_passes": [],
        "next_pass": None,
    }
    if paused is not None:
        # The entities are unavailable; do not count down to passes predicted
        # from elements this old either.
        return payload

    if (p := coordinator.next_visible_pass(now)) is not None and p.visible is not None:
        payload["next_visible_pass"] = {
            **visible_pass_attributes(p, epoch),
            "path": _track_json(
                predictor.track(p.visible.start.time, p.visible.end.time, VISIBLE_PATH_STEP_S)
            ),
        }
    payload["upcoming_visible_passes"] = [
        visible_pass_attributes(q, epoch)
        for q in data.visible_passes
        if q.visible is not None and q.visible.end.time > now
    ][:MAX_LISTED_PASSES]
    if (q := coordinator.next_pass(now)) is not None:
        reason = pass_status(coordinator, predictor, q)
        payload["next_pass"] = {
            **pass_attributes(q, epoch),
            "confidence": confidence(q.rise.time, epoch),
            "qualifies": reason == "visible",
            "reason": reason,
            # The height that matters for "low": the highest point while the
            # station can be seen, which can be far below its culmination.
            # Rounded down so 19.96 does not read as a 20 degree minimum.
            "visible_peak_elevation": None
            if q.visible is None
            else math.floor(q.visible.peak.elevation * 10) / 10,
            "path": _track_json(predictor.track(q.rise.time, q.set.time, NEXT_PASS_PATH_STEP_S)),
        }
    return payload


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/track", vol.Optional("entry_id"): str}
)
@callback
def ws_track(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Return the ground track and pass countdowns for one location."""
    if (coordinator := _coordinator(hass, connection, msg)) is None:
        return
    try:
        payload = build_track_payload(coordinator)
    except PropagationError as err:
        connection.send_error(msg["id"], websocket_api.ERR_HOME_ASSISTANT_ERROR, str(err))
        return
    connection.send_result(msg["id"], payload)


def path_step(start: datetime, end: datetime, step_s: float) -> float:
    """Return the requested spacing, widened so a path stays within PATH_MAX_POINTS."""
    span = (end - start).total_seconds()
    return max(step_s, math.ceil(span / (PATH_MAX_POINTS - 1)))


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/path",
        vol.Optional("entry_id"): str,
        vol.Required("start"): cv.datetime,
        vol.Required("end"): cv.datetime,
        vol.Optional("step", default=60): vol.All(vol.Coerce(float), vol.Range(min=5, max=900)),
    }
)
@websocket_api.async_response
async def ws_path(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Ground track for any stretch of time (used by the fast-forward preview)."""
    if (coordinator := _coordinator(hass, connection, msg)) is None:
        return
    try:
        start = dt_util.as_utc(msg["start"])
        end = dt_util.as_utc(msg["end"])
    except OverflowError:
        connection.send_error(
            msg["id"], websocket_api.ERR_INVALID_FORMAT, "start and end must be valid times"
        )
        return
    # A difference of two valid times cannot overflow, unlike start + span.
    if not timedelta(0) < end - start <= PATH_MAX_SPAN:
        connection.send_error(
            msg["id"],
            websocket_api.ERR_INVALID_FORMAT,
            f"end must be after start and at most {PATH_MAX_SPAN.days} days later",
        )
        return
    if (paused := paused_reason(coordinator, dt_util.utcnow())) is not None:
        connection.send_error(msg["id"], ERR_STALE_ELEMENTS, paused)
        return
    predictor = coordinator.new_predictor()
    if predictor is None or coordinator.data is None:
        connection.send_error(msg["id"], ERR_NOT_READY, "Waiting for ISS orbital elements")
        return
    epoch = coordinator.data.elements.epoch
    if not (epoch - PATH_EPOCH_RANGE <= start and end <= epoch + PATH_EPOCH_RANGE):
        connection.send_error(
            msg["id"],
            websocket_api.ERR_INVALID_FORMAT,
            f"start and end must be within {PATH_EPOCH_RANGE.days} days of the orbital "
            "elements' epoch",
        )
        return
    step = path_step(start, end, msg["step"])
    try:
        points = await hass.async_add_executor_job(predictor.track, start, end, step)
    except PropagationError as err:
        connection.send_error(msg["id"], websocket_api.ERR_HOME_ASSISTANT_ERROR, str(err))
        return
    connection.send_result(msg["id"], {"step": step, "track": _track_json(points)})
