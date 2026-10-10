"""Check the prediction engine against Skyfield results stored in a fixture."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from custom_components.iss_pass_prediction.elements import parse_omm_xml
from custom_components.iss_pass_prediction.predict import (
    Observer,
    PassPredictor,
    angular_separation,
    azimuth_to_compass,
)


def _predictor(reference: dict[str, Any], name: str) -> PassPredictor:
    elements = parse_omm_xml("test", reference["elements_xml"].encode(), datetime.now(UTC))
    obs = reference["observers"][name]
    return PassPredictor(
        elements.satrec(), Observer(obs["latitude"], obs["longitude"], obs["elevation_m"])
    )


def _window(reference: dict[str, Any]) -> tuple[datetime, datetime]:
    return datetime.fromisoformat(reference["start"]), datetime.fromisoformat(reference["end"])


OBSERVERS = ["boston", "denver", "london", "sydney", "quito", "reykjavik"]


@pytest.mark.parametrize("name", OBSERVERS)
def test_instantaneous_geometry_matches_skyfield(reference: dict[str, Any], name: str) -> None:
    predictor = _predictor(reference, name)
    for item in reference["observers"][name]["instants"]:
        when = datetime.fromtimestamp(item["time"], UTC)
        look = predictor.look(when)
        assert (
            angular_separation(look.azimuth, look.elevation, item["azimuth"], item["elevation"])
            < 0.01
        )
        assert look.range_km == pytest.approx(item["range_km"], abs=0.5)
        assert predictor.sun_elevation(when) == pytest.approx(item["sun_elevation"], abs=0.02)

        sub = predictor.subpoint(when)
        assert sub.latitude == pytest.approx(item["latitude"], abs=0.005)
        assert (sub.longitude - item["longitude"] + 180) % 360 - 180 == pytest.approx(0, abs=0.005)
        assert sub.altitude_km == pytest.approx(item["altitude_km"], abs=0.5)

        if predictor.is_sunlit(when) != item["sunlit"]:
            # Only acceptable right at the shadow boundary, where the two Sun
            # models differ by a fraction of a second.
            nearby = {predictor.is_sunlit(when + timedelta(seconds=s)) for s in (-1, 1)}
            assert nearby == {True, False}


@pytest.mark.parametrize("name", OBSERVERS)
def test_passes_match_skyfield(reference: dict[str, Any], name: str) -> None:
    predictor = _predictor(reference, name)
    start, end = _window(reference)
    ref = reference["observers"][name]["passes"]
    mine = [
        p
        for p in predictor.find_passes(
            start,
            end,
            min_elevation=reference["min_elevation"],
            max_sun_elevation=reference["max_sun_elevation"],
        )
        if p.rise.time >= start and p.set.time <= end
    ]
    assert len(mine) == len(ref)
    for r, m in zip(ref, mine, strict=True):
        assert m.rise.time.timestamp() == pytest.approx(r["rise"], abs=1.0)
        assert m.culmination.time.timestamp() == pytest.approx(r["culmination"], abs=1.0)
        assert m.set.time.timestamp() == pytest.approx(r["set"], abs=1.0)
        # Near the zenith the station moves ~1 deg/s, so a few hundredths of a
        # second in the peak time shift the peak elevation by a few hundredths
        # of a degree.
        assert m.culmination.elevation == pytest.approx(r["culmination_elevation"], abs=0.1)
        assert (r["visible"] is None) == (m.visible is None)
        if m.visible is not None:
            # Skyfield's visibility was sampled once per second.
            assert m.visible.start.time.timestamp() == pytest.approx(r["visible"]["start"], abs=2.0)
            assert m.visible.end.time.timestamp() == pytest.approx(r["visible"]["end"], abs=2.0)


def test_visible_window_is_consistent(reference: dict[str, Any]) -> None:
    predictor = _predictor(reference, "denver")
    start, end = _window(reference)
    visible = [p for p in predictor.find_passes(start, end) if p.visible is not None]
    assert visible
    for p in visible:
        v = p.visible
        assert v is not None
        assert p.rise.time <= v.start.time <= v.peak.time <= v.end.time <= p.set.time
        assert v.peak.elevation >= max(v.start.elevation, v.end.elevation) - 1e-6
        assert v.magnitude is not None and -6 < v.magnitude < 4
        assert predictor.is_sunlit(v.start.time) and predictor.is_sunlit(v.end.time)
        assert predictor.sun_elevation(v.start.time) <= -6.0 + 0.01
        if v.ends_in_shadow:
            assert not predictor.is_sunlit(v.end.time + timedelta(seconds=2))
        if v.starts_from_shadow:
            assert not predictor.is_sunlit(v.start.time - timedelta(seconds=2))


def test_pass_in_progress_at_start_is_included(reference: dict[str, Any]) -> None:
    predictor = _predictor(reference, "boston")
    start, end = _window(reference)
    first = predictor.find_passes(start, end)[3]
    midway = first.rise.time + (first.set.time - first.rise.time) / 2

    passes = predictor.find_passes(midway, midway + timedelta(hours=3))
    assert passes[0].rise.time.timestamp() == pytest.approx(first.rise.time.timestamp(), abs=0.5)
    assert passes[0].rise.time < midway < passes[0].set.time


def test_passes_after_window_are_excluded(reference: dict[str, Any]) -> None:
    predictor = _predictor(reference, "boston")
    start, end = _window(reference)
    passes = predictor.find_passes(start, end)
    cut = passes[5].culmination.time - timedelta(seconds=1)
    short = predictor.find_passes(start, cut)
    assert [p.rise.time for p in short] == [p.rise.time for p in passes[:5]]


@pytest.mark.parametrize("name", ["boston", "denver"])
def test_pass_peaking_just_before_end_is_included(reference: dict[str, Any], name: str) -> None:
    """The coordinator's end is now + N days, so it can fall anywhere within a minute."""
    predictor = _predictor(reference, name)
    start, end = _window(reference)
    for p in predictor.find_passes(start, end)[1:11]:
        peak = p.culmination.time
        for offset in (0.2, 1, 5, 15, 29, 31, 45, 59.5):
            cut = peak + timedelta(seconds=offset)
            short = predictor.find_passes(peak - timedelta(hours=2), cut)
            assert short and short[-1].culmination == p.culmination, (peak, offset)


def test_searches_at_different_times_agree(reference: dict[str, Any]) -> None:
    """Each refresh searches from a new "now"; the passes it shares must not move."""
    predictor = _predictor(reference, "boston")
    start, end = _window(reference)
    offset = timedelta(seconds=1800.37)
    first = predictor.find_passes(start, end)
    second = predictor.find_passes(start + offset, end + offset)
    shared = [p for p in second if p.culmination.time <= end]
    assert len(shared) > 10
    assert shared == [p for p in first if p.set.time > start + offset]


def test_minimum_elevation_mask(reference: dict[str, Any]) -> None:
    predictor = _predictor(reference, "london")
    start, end = _window(reference)
    low = predictor.find_passes(start, end, min_elevation=0.0)
    high = predictor.find_passes(start, end, min_elevation=30.0)
    assert len(high) < len(low)
    assert all(p.culmination.elevation >= 30.0 for p in high)
    assert all(p.rise.elevation == pytest.approx(30.0, abs=0.05) for p in high)


@pytest.mark.parametrize(
    ("azimuth", "expected"),
    [(0, "N"), (11.2, "N"), (11.3, "NNE"), (90, "E"), (200, "SSW"), (359, "N"), (-90, "W")],
)
def test_compass(azimuth: float, expected: str) -> None:
    assert azimuth_to_compass(azimuth) == expected
