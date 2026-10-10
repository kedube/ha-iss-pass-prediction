"""Tests for parsing and validating orbital elements."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
from sgp4 import omm
from sgp4.api import Satrec

from custom_components.iss_pass_prediction.elements import (
    ElementsError,
    OrbitalElements,
    parse_omm_xml,
    parse_tle,
)

NOW = datetime(2026, 10, 9, 22, 0, tzinfo=UTC)
LINE1 = "1 25544U 98067A   26281.85354122  .00006592  00000+0  12863-3 0  9993"
LINE2 = "2 25544  51.6315  97.5838 0006777 239.2205 120.8116 15.48782232589376"
# Hubble Space Telescope: a valid TLE that is not the ISS.
HST1 = "1 20580U 90037B   26281.50000000  .00001000  00000+0  50000-4 0  9990"


def _with_checksum(line: str) -> str:
    total = sum(int(c) if c.isdigit() else 1 if c == "-" else 0 for c in line[:68])
    return line[:68] + str(total % 10)


def test_parse_omm_xml(omm_xml: bytes) -> None:
    elements = parse_omm_xml("celestrak", omm_xml, NOW)
    assert elements.format == "omm"
    assert elements.epoch == datetime(2026, 10, 9, 19, 42, 49, 138848, tzinfo=UTC)
    assert elements.satrec().satnum == 25544


def test_omm_parse_works_with_two_argument_initialize(
    monkeypatch: pytest.MonkeyPatch, omm_xml: bytes
) -> None:
    """sgp4 2.20 to 2.24, which the manifest allows, define omm.initialize(sat, fields)."""
    real = omm.initialize

    def legacy_initialize(sat: Satrec, fields: dict[str, Any]) -> None:
        real(sat, fields)

    monkeypatch.setattr(omm, "initialize", legacy_initialize)
    assert parse_omm_xml("celestrak", omm_xml, NOW).format == "omm"


def test_omm_round_trip(omm_xml: bytes) -> None:
    elements = parse_omm_xml("celestrak", omm_xml, NOW)
    restored = OrbitalElements.from_dict(elements.as_dict())
    assert restored == elements


def test_omm_wrong_object_rejected(omm_xml: bytes) -> None:
    other = omm_xml.replace(b"<NORAD_CAT_ID>25544<", b"<NORAD_CAT_ID>20580<")
    with pytest.raises(ElementsError, match="no ISS segment"):
        parse_omm_xml("celestrak", other, NOW)


def test_omm_garbage_rejected() -> None:
    with pytest.raises(ElementsError):
        parse_omm_xml("celestrak", b"<html>Service unavailable", NOW)


def test_omm_implausible_orbit_rejected(omm_xml: bytes) -> None:
    geo = omm_xml.replace(b"<MEAN_MOTION>15.48793003<", b"<MEAN_MOTION>1.00270000<")
    with pytest.raises(ElementsError, match="mean motion"):
        parse_omm_xml("celestrak", geo, NOW)


def test_parse_tle() -> None:
    elements = parse_tle("wheretheiss.at", LINE1, LINE2, NOW)
    assert elements.format == "tle"
    assert elements.epoch.date().isoformat() == "2026-10-08"
    assert OrbitalElements.from_dict(elements.as_dict()) == elements


def test_tle_checksum_rejected() -> None:
    bad = LINE1[:-1] + str((int(LINE1[-1]) + 1) % 10)
    with pytest.raises(ElementsError, match="checksum"):
        parse_tle("wheretheiss.at", bad, LINE2, NOW)


def test_tle_other_satellite_rejected() -> None:
    hst2 = _with_checksum("2 20580  28.4700 100.0000 0002500 100.0000 260.0000 15.0900000000000")
    with pytest.raises(ElementsError, match="not the ISS"):
        parse_tle("n2yo", _with_checksum(HST1), hst2, NOW)


def test_tle_wrong_shape_rejected() -> None:
    with pytest.raises(ElementsError):
        parse_tle("n2yo", LINE2, LINE1, NOW)
    with pytest.raises(ElementsError):
        parse_tle("n2yo", LINE1[:60], LINE2, NOW)
