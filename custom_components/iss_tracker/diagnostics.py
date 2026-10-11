"""Diagnostics for ISS Tracker."""

from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from . import IssConfigEntry
from .const import CONF_N2YO_API_KEY

TO_REDACT = {CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE, CONF_N2YO_API_KEY}


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: IssConfigEntry
) -> dict[str, Any]:
    """Return diagnostics for a config entry."""
    coordinator = entry.runtime_data
    data = coordinator.data
    result: dict[str, Any] = {
        "entry": async_redact_data(dict(entry.data), TO_REDACT),
        "options": async_redact_data(dict(entry.options), TO_REDACT),
        "last_update_success": coordinator.last_update_success,
        "last_download_error": coordinator.elements_error,
        "n2yo_check": coordinator.n2yo_check,
        "now": dt_util.utcnow().isoformat(),
    }
    if data is not None:
        epoch = data.elements.epoch
        result["elements"] = {**data.elements.as_dict(), "epoch": epoch.isoformat()}
        result["computed_at"] = data.computed_at.isoformat()
        # Counts only: the times and look angles of the passes would reveal
        # the home location to within a few hundred metres.
        result["pass_count"] = len(data.passes)
        result["visible_pass_count"] = len(data.visible_passes)
    return result
