"""ISS Tracker: follows the International Space Station and predicts when it is visible."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN
from .coordinator import DATA_ELEMENTS, ElementsManager, IssTrackerCoordinator
from .frontend import async_clear_stale_issue, async_setup_frontend, async_update_panel

PLATFORMS = [Platform.BINARY_SENSOR, Platform.DEVICE_TRACKER, Platform.SENSOR]

type IssConfigEntry = ConfigEntry[IssTrackerCoordinator]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Serve the globe card and sidebar panel."""
    await async_setup_frontend(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: IssConfigEntry) -> bool:
    """Set up a location from a config entry."""
    # The panel follows the enabled locations, so it is there (and says what
    # it is waiting for) even while setup retries.
    await async_update_panel(hass, adding=entry)

    manager = hass.data.get(DATA_ELEMENTS)
    if manager is None:
        manager = hass.data[DATA_ELEMENTS] = ElementsManager(hass)

    coordinator = IssTrackerCoordinator(hass, entry, manager)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    entry.async_on_unload(coordinator.async_start_live())
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: IssConfigEntry) -> bool:
    """Unload a config entry."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        # A reload keeps the panel (the entry is still enabled); disabling the
        # entry, which happens before the unload, removes it. A reload also
        # keeps the repair issue, and the user's "Ignore" with it.
        await async_update_panel(hass)
    return unloaded


async def async_remove_entry(hass: HomeAssistant, entry: IssConfigEntry) -> None:
    """Remove the panel and the repair issue with the last enabled location."""
    await async_update_panel(hass, removing=entry)
    async_clear_stale_issue(hass)


async def _async_update_listener(hass: HomeAssistant, entry: IssConfigEntry) -> None:
    """Reload when the options or the location change."""
    await hass.config_entries.async_reload(entry.entry_id)
