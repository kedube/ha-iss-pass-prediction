"""Orbital elements for the ISS: download, validation and serialisation.

No Home Assistant imports, so the parsing and validation rules can be tested
directly. Sources, in order of preference:

1. CelesTrak, CCSDS OMM XML. CelesTrak recommends OMM over the legacy TLE
   format, which ran out of 5-digit catalogue numbers in July 2026.
2. wheretheiss.at, two-line elements (independent mirror).
3. N2YO, two-line elements (only when the user supplies an API key).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import io
import json
import math
from typing import Any
from xml.etree.ElementTree import ParseError

import aiohttp
from sgp4 import omm
from sgp4.api import WGS72, Satrec
from sgp4.conveniences import sat_epoch_datetime

ISS_NORAD_ID = 25544

CELESTRAK_URL = f"https://celestrak.org/NORAD/elements/gp.php?CATNR={ISS_NORAD_ID}&FORMAT=XML"
WHERETHEISS_URL = f"https://api.wheretheiss.at/v1/satellites/{ISS_NORAD_ID}/tles"
N2YO_BASE_URL = "https://api.n2yo.com/rest/v1/satellite"

SOURCE_CELESTRAK = "celestrak"
SOURCE_WHERETHEISS = "wheretheiss.at"
SOURCE_N2YO = "n2yo"

FORMAT_OMM = "omm"
FORMAT_TLE = "tle"

_MAX_RESPONSE_BYTES = 256 * 1024
_REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=30)

# Sanity limits for the ISS: anything outside these means the data is not the
# station, or is corrupt.
_MIN_REV_PER_DAY = 14.5
_MAX_REV_PER_DAY = 16.5
_MIN_ALTITUDE_KM = 150.0
_MAX_ALTITUDE_KM = 800.0


class ElementsError(Exception):
    """Orbital elements could not be fetched or failed validation."""


class SourceRejectedError(ElementsError):
    """The source refused the request (HTTP 403/404/429); do not retry soon."""


class SourceUnavailableError(ElementsError):
    """The source could not be reached or had a server error; retry soon."""


@dataclass(frozen=True, slots=True)
class OrbitalElements:
    """A validated set of SGP4 mean elements for the ISS."""

    source: str
    format: str
    fields: dict[str, Any]
    epoch: datetime
    fetched_at: datetime

    def satrec(self) -> Satrec:
        """Build an SGP4 satellite record."""
        return _build_satrec(self.format, self.fields)

    def as_dict(self) -> dict[str, Any]:
        """Serialise for Home Assistant storage."""
        return {
            "source": self.source,
            "format": self.format,
            "fields": self.fields,
            "fetched_at": self.fetched_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> OrbitalElements:
        """Restore stored elements, re-validating them."""
        return _validated(
            data["source"],
            data["format"],
            data["fields"],
            datetime.fromisoformat(data["fetched_at"]),
        )


def _build_satrec(fmt: str, fields: dict[str, Any]) -> Satrec:
    if fmt == FORMAT_OMM:
        sat = Satrec()
        # WGS72 is the default from sgp4 2.25 and hard-coded before that.
        omm.initialize(sat, fields)
        return sat
    if fmt == FORMAT_TLE:
        return Satrec.twoline2rv(fields["line1"], fields["line2"], WGS72)
    raise ElementsError(f"Unknown element format {fmt!r}")


def _validated(
    source: str, fmt: str, fields: dict[str, Any], fetched_at: datetime
) -> OrbitalElements:
    """Build elements and reject anything that is not a plausible ISS orbit."""
    try:
        sat = _build_satrec(fmt, fields)
    except (KeyError, ValueError, TypeError) as err:
        raise ElementsError(f"{source}: malformed elements ({err})") from err

    if sat.satnum != ISS_NORAD_ID:
        raise ElementsError(f"{source}: catalogue number {sat.satnum} is not the ISS")
    rev_per_day = sat.no_kozai * 1440 / (2 * math.pi)
    if not _MIN_REV_PER_DAY <= rev_per_day <= _MAX_REV_PER_DAY:
        raise ElementsError(f"{source}: implausible mean motion {rev_per_day:.3f} rev/day")

    error, r, _ = sat.sgp4(sat.jdsatepoch, sat.jdsatepochF)
    if error:
        raise ElementsError(f"{source}: SGP4 error {error} at epoch")
    altitude = math.sqrt(r[0] ** 2 + r[1] ** 2 + r[2] ** 2) - 6378.137
    if not _MIN_ALTITUDE_KM <= altitude <= _MAX_ALTITUDE_KM:
        raise ElementsError(f"{source}: implausible altitude {altitude:.0f} km")

    epoch = sat_epoch_datetime(sat).astimezone(UTC)
    return OrbitalElements(source, fmt, fields, epoch, fetched_at)


def _tle_checksum_ok(line: str) -> bool:
    total = sum(int(c) if c.isdigit() else 1 if c == "-" else 0 for c in line[:68])
    return line[68:69].isdigit() and total % 10 == int(line[68])


def parse_tle(source: str, line1: str, line2: str, fetched_at: datetime) -> OrbitalElements:
    """Validate a two-line element set."""
    line1, line2 = line1.strip(), line2.strip()
    if not (line1.startswith("1 ") and line2.startswith("2 ")):
        raise ElementsError(f"{source}: not a two-line element set")
    if len(line1) != 69 or len(line2) != 69:
        raise ElementsError(f"{source}: TLE lines must be 69 characters")
    if not (_tle_checksum_ok(line1) and _tle_checksum_ok(line2)):
        raise ElementsError(f"{source}: TLE checksum mismatch")
    return _validated(source, FORMAT_TLE, {"line1": line1, "line2": line2}, fetched_at)


def parse_omm_xml(source: str, payload: bytes, fetched_at: datetime) -> OrbitalElements:
    """Validate a CCSDS OMM XML document and return the ISS segment."""
    try:
        segments = list(omm.parse_xml(io.BytesIO(payload)))
    except (ParseError, AttributeError, TypeError) as err:
        raise ElementsError(f"{source}: unreadable OMM XML ({err})") from err
    for fields in segments:
        if str(fields.get("NORAD_CAT_ID", "")).strip() == str(ISS_NORAD_ID):
            clean = {k: (v.strip() if isinstance(v, str) else v) for k, v in fields.items()}
            return _validated(source, FORMAT_OMM, clean, fetched_at)
    raise ElementsError(f"{source}: no ISS segment in OMM response")


async def _get(session: aiohttp.ClientSession, url: str, label: str, **kwargs: Any) -> bytes:
    """GET a URL, returning at most _MAX_RESPONSE_BYTES of body.

    ``label`` is used in errors instead of the URL so API keys are never logged.
    """
    try:
        async with session.get(url, timeout=_REQUEST_TIMEOUT, **kwargs) as resp:
            if resp.status in (403, 404, 429):
                raise SourceRejectedError(f"{label}: HTTP {resp.status}")
            if resp.status >= 500:
                raise SourceUnavailableError(f"{label}: HTTP {resp.status}")
            if resp.status != 200:
                raise ElementsError(f"{label}: HTTP {resp.status}")
            body = bytearray()
            async for chunk in resp.content.iter_chunked(64 * 1024):
                body += chunk
                if len(body) > _MAX_RESPONSE_BYTES:
                    raise ElementsError(f"{label}: response too large")
    # The text of aiohttp's errors can include the request URL, which for N2YO
    # holds the API key and the observer's coordinates; report the type only.
    except aiohttp.ClientResponseError as err:
        status = f" {err.status}" if err.status else ""
        raise SourceUnavailableError(f"{label}: {type(err).__name__}{status}") from None
    except (aiohttp.ClientError, TimeoutError) as err:
        raise SourceUnavailableError(f"{label}: {type(err).__name__}") from None
    return bytes(body)


def _json_object(body: bytes, label: str) -> dict[str, Any]:
    try:
        data = json.loads(body)
    except ValueError as err:
        raise ElementsError(f"{label}: invalid JSON") from err
    if not isinstance(data, dict):
        raise ElementsError(f"{label}: unexpected response")
    return data


def _n2yo_object(body: bytes) -> dict[str, Any]:
    data = _json_object(body, SOURCE_N2YO)
    if "error" in data:
        # N2YO reports a bad or rate-limited API key this way, with HTTP 200.
        raise SourceRejectedError(f"{SOURCE_N2YO}: {data['error']}")
    return data


async def fetch_celestrak(
    session: aiohttp.ClientSession, headers: dict[str, str]
) -> OrbitalElements:
    """Fetch OMM XML from CelesTrak."""
    body = await _get(session, CELESTRAK_URL, SOURCE_CELESTRAK, headers=headers)
    return parse_omm_xml(SOURCE_CELESTRAK, body, datetime.now(UTC))


async def fetch_wheretheiss(
    session: aiohttp.ClientSession, headers: dict[str, str]
) -> OrbitalElements:
    """Fetch two-line elements from wheretheiss.at."""
    body = await _get(session, WHERETHEISS_URL, SOURCE_WHERETHEISS, headers=headers)
    data = _json_object(body, SOURCE_WHERETHEISS)
    try:
        return parse_tle(SOURCE_WHERETHEISS, data["line1"], data["line2"], datetime.now(UTC))
    except (KeyError, TypeError, AttributeError) as err:
        raise ElementsError(f"{SOURCE_WHERETHEISS}: unexpected response") from err


async def fetch_n2yo(
    session: aiohttp.ClientSession, headers: dict[str, str], api_key: str
) -> OrbitalElements:
    """Fetch two-line elements from N2YO."""
    url = f"{N2YO_BASE_URL}/tle/{ISS_NORAD_ID}&apiKey={api_key}"
    data = _n2yo_object(await _get(session, url, SOURCE_N2YO, headers=headers))
    try:
        line1, line2 = data["tle"].replace("\r\n", "\n").split("\n")[:2]
    except (KeyError, AttributeError, ValueError) as err:
        raise ElementsError(f"{SOURCE_N2YO}: unexpected response") from err
    return parse_tle(SOURCE_N2YO, line1, line2, datetime.now(UTC))


async def fetch_n2yo_visual_passes(
    session: aiohttp.ClientSession,
    headers: dict[str, str],
    api_key: str,
    latitude: float,
    longitude: float,
    elevation_m: float,
    days: int,
) -> list[dict[str, Any]]:
    """Fetch N2YO's own visible-pass predictions (used only as a cross-check)."""
    url = (
        f"{N2YO_BASE_URL}/visualpasses/{ISS_NORAD_ID}/{latitude:.4f}/{longitude:.4f}/"
        f"{elevation_m:.0f}/{days}/1/&apiKey={api_key}"
    )
    data = _n2yo_object(await _get(session, url, SOURCE_N2YO, headers=headers))
    passes = data.get("passes") or []
    if not isinstance(passes, list):
        raise ElementsError(f"{SOURCE_N2YO}: unexpected response")
    return passes
