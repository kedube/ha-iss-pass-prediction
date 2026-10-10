"""Constants for the ISS Pass Prediction integration."""

from __future__ import annotations

from datetime import timedelta
from typing import Final

DOMAIN: Final = "iss_pass_prediction"
VERSION: Final = "0.1.0"
USER_AGENT: Final = (
    f"HomeAssistant-ISSPassPrediction/{VERSION} (+https://github.com/kedube/ha-iss-pass-prediction)"
)

CONF_MIN_ELEVATION: Final = "min_elevation"
CONF_MIN_PEAK_ELEVATION: Final = "min_peak_elevation"
CONF_MAX_SUN_ELEVATION: Final = "max_sun_elevation"
CONF_MIN_VISIBLE_DURATION: Final = "min_visible_duration"
CONF_FORECAST_DAYS: Final = "forecast_days"
CONF_ALERT_LEAD_MINUTES: Final = "alert_lead_minutes"
CONF_N2YO_API_KEY: Final = "n2yo_api_key"
CONF_SHOW_PANEL: Final = "show_in_sidebar"

# NASA's Spot the Station reports sightings from 10 degrees above the horizon;
# lower than that, trees and buildings usually hide the station.
DEFAULT_MIN_ELEVATION: Final = 10.0
DEFAULT_MIN_PEAK_ELEVATION: Final = 20.0
# Civil twilight: the sky is dark enough for the station to stand out.
DEFAULT_MAX_SUN_ELEVATION: Final = -6.0
DEFAULT_MIN_VISIBLE_DURATION: Final = 60
DEFAULT_FORECAST_DAYS: Final = 10
DEFAULT_ALERT_LEAD_MINUTES: Final = 15
DEFAULT_SHOW_PANEL: Final = True

# How often to download fresh orbital elements. CelesTrak asks for no more than
# one download per two hours and publishes new ISS elements a few times a day.
ELEMENTS_REFRESH_INTERVAL: Final = timedelta(hours=6)
# After a source refuses a request or returns unusable data, leave it alone for
# two hours (CelesTrak blocks clients that keep retrying errors). When a source
# simply cannot be reached, for example because Home Assistant started before
# the network was up, try again sooner.
ELEMENTS_MIN_RETRY_INTERVAL: Final = timedelta(hours=2)
ELEMENTS_UNREACHABLE_RETRY_INTERVAL: Final = timedelta(minutes=5)
# Older elements than this give misleading predictions, so entities go
# unavailable instead.
ELEMENTS_MAX_AGE: Final = timedelta(days=14)
# Repair issue raised while predictions are paused for want of fresh elements.
ISSUE_ELEMENTS_STALE: Final = "elements_stale"

# Passes are recomputed on this interval so the forecast window keeps rolling.
PASS_UPDATE_INTERVAL: Final = timedelta(minutes=30)
# The live position is recomputed locally (no network) on these intervals.
LIVE_INTERVAL_IDLE: Final = timedelta(seconds=60)
LIVE_INTERVAL_PASS: Final = timedelta(seconds=10)

N2YO_CHECK_INTERVAL: Final = timedelta(hours=24)

# Rough guide to how far the timing of a prediction can be trusted, by how far
# the pass is from the epoch of the orbital elements. Atmospheric drag and the
# station's periodic reboosts make far-off predictions drift by minutes. These
# thresholds are a practical rule of thumb, not a formal error bound.
CONFIDENCE_HIGH_DAYS: Final = 3
CONFIDENCE_MEDIUM_DAYS: Final = 7

STORAGE_KEY: Final = f"{DOMAIN}.elements"
STORAGE_VERSION: Final = 1

MAX_LISTED_PASSES: Final = 20

# Frontend: the globe card, the sidebar panel and the files they load.
FRONTEND_URL: Final = f"/{DOMAIN}/frontend"
PANEL_URL_PATH: Final = "iss-tracker"
PANEL_TITLE: Final = "ISS Tracker"
PANEL_ICON: Final = "mdi:space-station"
# Ground track sent to the globe: this far back and ahead, at this spacing.
TRACK_PAST: Final = timedelta(minutes=50)
TRACK_FUTURE: Final = timedelta(minutes=100)
TRACK_STEP_S: Final = 30
VISIBLE_PATH_STEP_S: Final = 5
NEXT_PASS_PATH_STEP_S: Final = 10
# Limits for on-demand paths (the globe's fast-forward preview). The span
# covers the longest forecast window, so any listed pass can be previewed;
# long spans are sampled more coarsely to stay within the point limit.
PATH_MAX_SPAN: Final = timedelta(days=31)
PATH_MAX_POINTS: Final = 6000
