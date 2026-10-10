"""Cross-check the prediction engine against Skyfield and a JPL ephemeris.

Usage (from the repository root, with skyfield installed):

    python scripts/validate_against_skyfield.py --elements omm.xml --ephemeris de421.bsp

``--elements`` is a CelesTrak OMM XML file (FORMAT=XML). Without it the script
downloads the current ISS elements. ``--ephemeris`` defaults to de421.bsp,
which Skyfield downloads (~17 MB) if it is missing.

The engine's own pass search is compared with Skyfield's ``find_events`` and a
one-second brute-force scan for visibility, for several observers. With
``--write-fixture`` the Skyfield results are saved for the unit tests, so the
test suite does not need Skyfield or the ephemeris.
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime, timedelta
import json
import math
from pathlib import Path
import random
import statistics
import sys
import urllib.request

import numpy as np
from skyfield.api import EarthSatellite, Loader, wgs84

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from custom_components.iss_pass_prediction.elements import (
    CELESTRAK_URL,
    parse_omm_xml,
)
from custom_components.iss_pass_prediction.predict import (
    Observer,
    PassPredictor,
)

OBSERVERS = {
    "boston": Observer(42.36, -71.06, 10),
    "denver": Observer(39.74, -104.99, 1609),
    "london": Observer(51.51, -0.13, 11),
    "sydney": Observer(-33.87, 151.21, 58),
    "quito": Observer(-0.18, -78.47, 2850),
    "reykjavik": Observer(64.15, -21.94, 20),
}
MIN_ELEVATION = 10.0
MAX_SUN_ELEVATION = -6.0


def angle_between(az1: float, el1: float, az2: float, el2: float) -> float:
    """Great-circle separation of two sky directions, in degrees."""
    a1, e1, a2, e2 = map(math.radians, (az1, el1, az2, el2))
    c = math.sin(e1) * math.sin(e2) + math.cos(e1) * math.cos(e2) * math.cos(a1 - a2)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def skyfield_passes(sat, topos, eph, ts, start, end):
    """Rise/culmination/set from find_events plus a 1 s visibility scan."""
    t, events = sat.find_events(
        topos, ts.from_datetime(start), ts.from_datetime(end), altitude_degrees=MIN_ELEVATION
    )
    diff = sat - topos
    observer_at = eph["earth"] + topos
    out = []
    i = 0
    events = list(events)
    while i < len(events):
        # Only complete rise/culminate/set triples; partial passes at the window
        # edges are skipped (the engine's handling of those is tested separately).
        if events[i : i + 3] != [0, 1, 2]:
            i += 1
            continue
        rise, culm, set_ = t[i], t[i + 1], t[i + 2]
        seconds = int((set_.tt - rise.tt) * 86400)
        samples = ts.tt_jd(rise.tt + np.arange(seconds + 1) / 86400)
        alt = diff.at(samples).altaz()[0].degrees
        sunlit = sat.at(samples).is_sunlit(eph)
        sun_alt = observer_at.at(samples).observe(eph["sun"]).apparent().altaz()[0].degrees
        vis = [
            bool(s) and a >= MIN_ELEVATION and sa <= MAX_SUN_ELEVATION
            for s, a, sa in zip(sunlit, alt, sun_alt, strict=True)
        ]
        visible = None
        if any(vis):
            # Longest run of visible seconds.
            best, run_start = None, None
            for k, v in enumerate([*vis, False]):
                if v and run_start is None:
                    run_start = k
                elif not v and run_start is not None:
                    if best is None or k - run_start > best[1] - best[0]:
                        best = (run_start, k - 1)
                    run_start = None
            visible = {
                "start": samples[best[0]].utc_datetime().timestamp(),
                "end": samples[best[1]].utc_datetime().timestamp(),
            }
        alt_c, az_c, _ = diff.at(culm).altaz()
        out.append(
            {
                "rise": rise.utc_datetime().timestamp(),
                "culmination": culm.utc_datetime().timestamp(),
                "set": set_.utc_datetime().timestamp(),
                "culmination_elevation": alt_c.degrees,
                "culmination_azimuth": az_c.degrees,
                "visible": visible,
            }
        )
        i += 3
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--elements", type=Path)
    parser.add_argument("--ephemeris", default="de421.bsp")
    parser.add_argument("--days", type=float, default=10)
    parser.add_argument("--write-fixture", type=Path)
    args = parser.parse_args()

    if args.elements:
        payload = args.elements.read_bytes()
    else:
        with urllib.request.urlopen(CELESTRAK_URL, timeout=30) as resp:
            payload = resp.read()
    elements = parse_omm_xml("validation", payload, datetime.now(UTC))
    satrec = elements.satrec()

    eph_path = Path(args.ephemeris).resolve()
    load = Loader(str(eph_path.parent))
    eph = load(eph_path.name)
    ts = load.timescale(builtin=True)
    sat = EarthSatellite.from_satrec(satrec, ts)

    start = elements.epoch.replace(microsecond=0) + timedelta(hours=1)
    end = start + timedelta(days=args.days)
    print(f"Elements epoch {elements.epoch.isoformat()}  window {start} .. {end}")

    failures = 0
    fixture = {
        "elements_xml": payload.decode(),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "min_elevation": MIN_ELEVATION,
        "max_sun_elevation": MAX_SUN_ELEVATION,
        "observers": {},
    }
    rng = random.Random(25544)

    for name, obs in OBSERVERS.items():
        topos = wgs84.latlon(obs.latitude, obs.longitude, elevation_m=obs.elevation_m)
        predictor = PassPredictor(satrec, obs)
        observer_at = eph["earth"] + topos

        # Instantaneous geometry at random times.
        sep, sun_err, lit_mismatch, sub_err = [], [], 0, []
        random_times = []
        for _ in range(300):
            when = start + timedelta(seconds=rng.uniform(0, args.days * 86400))
            t = ts.from_datetime(when)
            alt, az, dist = (sat - topos).at(t).altaz()
            mine = predictor.look(when)
            sep.append(angle_between(mine.azimuth, mine.elevation, az.degrees, alt.degrees))
            sf_sun = observer_at.at(t).observe(eph["sun"]).apparent().altaz()[0].degrees
            sun_err.append(abs(predictor.sun_elevation(when) - sf_sun))
            sf_lit = bool(sat.at(t).is_sunlit(eph))
            lit_mismatch += predictor.is_sunlit(when) != sf_lit
            sp = wgs84.geographic_position_of(sat.at(t))
            my_sp = predictor.subpoint(when)
            sub_err.append(
                max(
                    abs(my_sp.latitude - sp.latitude.degrees),
                    abs((my_sp.longitude - sp.longitude.degrees + 180) % 360 - 180),
                )
            )
            random_times.append(
                {
                    "time": when.timestamp(),
                    "azimuth": az.degrees,
                    "elevation": alt.degrees,
                    "range_km": dist.km,
                    "sun_elevation": sf_sun,
                    "sunlit": sf_lit,
                    "latitude": sp.latitude.degrees,
                    "longitude": sp.longitude.degrees,
                    "altitude_km": sp.elevation.km,
                }
            )

        ref = skyfield_passes(sat, topos, eph, ts, start, end)
        mine_passes = [
            p
            for p in predictor.find_passes(
                start, end, min_elevation=MIN_ELEVATION, max_sun_elevation=MAX_SUN_ELEVATION
            )
            if p.rise.time >= start and p.set.time <= end
        ]

        timing, vis_timing, vis_mismatch = [], [], 0
        if len(ref) != len(mine_passes):
            print(f"  {name}: pass count differs: skyfield {len(ref)} vs engine {len(mine_passes)}")
            failures += 1
        for r, m in zip(ref, mine_passes, strict=False):
            timing += [
                abs(m.rise.time.timestamp() - r["rise"]),
                abs(m.culmination.time.timestamp() - r["culmination"]),
                abs(m.set.time.timestamp() - r["set"]),
            ]
            if (r["visible"] is None) != (m.visible is None):
                vis_mismatch += 1
            elif m.visible is not None:
                vis_timing += [
                    abs(m.visible.start.time.timestamp() - r["visible"]["start"]),
                    abs(m.visible.end.time.timestamp() - r["visible"]["end"]),
                ]

        n_vis = sum(1 for r in ref if r["visible"])
        print(
            f"{name:>10}: {len(ref):3d} passes ({n_vis:2d} visible) | "
            f"pointing max {max(sep):.4f} deg | sun max {max(sun_err):.4f} deg | "
            f"sunlit mismatches {lit_mismatch} | subpoint max {max(sub_err):.4f} deg | "
            f"rise/peak/set max {max(timing, default=0):.2f} s (median "
            f"{statistics.median(timing) if timing else 0:.2f}) | visible start/end max "
            f"{max(vis_timing, default=0):.2f} s | visibility mismatches {vis_mismatch}"
        )
        if max(sep) > 0.05 or max(sun_err) > 0.05 or max(sub_err) > 0.05:
            failures += 1
        if max(timing, default=0) > 1.0 or max(vis_timing, default=0) > 2.0 or vis_mismatch:
            failures += 1

        fixture["observers"][name] = {
            "latitude": obs.latitude,
            "longitude": obs.longitude,
            "elevation_m": obs.elevation_m,
            "instants": random_times[:40],
            "passes": ref,
        }

    if args.write_fixture:
        args.write_fixture.write_text(json.dumps(fixture, separators=(",", ":")))
        print(f"Wrote {args.write_fixture}")
    print("PASS" if not failures else f"FAIL ({failures} checks)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
