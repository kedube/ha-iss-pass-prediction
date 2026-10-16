"""ISS pass prediction engine.

Everything in this module is plain Python with no Home Assistant imports so it
can be tested (and cross-checked against Skyfield) on its own.

Pipeline for each instant:

1. SGP4 propagates the orbital elements to a TEME position (km).
2. TEME is rotated into Earth-fixed coordinates using Greenwich Mean Sidereal
   Time. Polar motion and UT1-UTC are ignored; together they move the station by
   well under a kilometre, far below the error of the orbital elements.
3. The observer's WGS-84 position is subtracted to get azimuth, elevation and
   range.
4. A low-precision solar ephemeris (Astronomical Almanac, ~0.01 deg) provides
   the Sun's direction for the twilight test, the Earth-shadow test and the
   brightness estimate.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
import math

from sgp4.api import SGP4_ERRORS, Satrec

# WGS-84 ellipsoid (observer position and sub-satellite point).
_WGS84_A_KM = 6378.137
_WGS84_F = 1 / 298.257223563
_WGS84_E2 = _WGS84_F * (2 - _WGS84_F)

# Earth sphere used for the shadow test; same value Skyfield uses.
_SHADOW_RADIUS_KM = 6378.1366
_AU_KM = 149_597_870.7

_UNIX_EPOCH_JD = 2440587.5
_J2000_JD = 2451545.0
_SECONDS_PER_DAY = 86400.0
_TWO_PI = 2 * math.pi
_DEG = math.pi / 180

# Standard magnitude of the ISS at 1000 km range and 50% illumination (CalSky's
# value). The station's brightness also depends on its attitude and solar array
# angles, so treat computed magnitudes as estimates good to about half a magnitude.
ISS_STANDARD_MAGNITUDE = -2.0

# Coarse search step. The station is above the horizon for several minutes on
# every pass, so a one minute step cannot skip over the peak of a pass.
_COARSE_STEP_S = 60.0
# Sampling step used to locate where a pass becomes visible.
_FINE_STEP_S = 5.0
# Precision of the refined event times.
_TIME_TOLERANCE_S = 0.1
# How far back to look for a pass that is already in progress at search start.
_LOOKBACK_S = 20 * 60.0
# A pass never lasts longer than this from rise to set (ISS: ~11 minutes).
_MAX_HALF_PASS_S = 15 * 60.0

_COMPASS_POINTS = (
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
)  # fmt: skip


class PropagationError(Exception):
    """SGP4 could not propagate the orbital elements to the requested time."""


@dataclass(frozen=True, slots=True)
class Observer:
    """A location on Earth."""

    latitude: float
    longitude: float
    elevation_m: float = 0.0


@dataclass(frozen=True, slots=True)
class SkyPoint:
    """Where the station appears in the sky at one instant."""

    time: datetime
    azimuth: float
    elevation: float
    range_km: float

    @property
    def compass(self) -> str:
        """16-point compass direction of the azimuth."""
        return azimuth_to_compass(self.azimuth)


@dataclass(frozen=True, slots=True)
class VisibleWindow:
    """The part of a pass when the station is sunlit against a dark sky."""

    start: SkyPoint
    peak: SkyPoint
    end: SkyPoint
    magnitude: float | None
    # True when the station appears out of Earth's shadow (rather than rising
    # above the elevation mask) or fades into it (rather than setting).
    starts_from_shadow: bool
    ends_in_shadow: bool

    @property
    def duration_s(self) -> float:
        """Length of the visible window in seconds."""
        return (self.end.time - self.start.time).total_seconds()


@dataclass(frozen=True, slots=True)
class Pass:
    """One pass of the station above the elevation mask."""

    rise: SkyPoint
    culmination: SkyPoint
    set: SkyPoint
    visible: VisibleWindow | None


@dataclass(frozen=True, slots=True)
class SubPoint:
    """The point on Earth directly beneath the station."""

    time: datetime
    latitude: float
    longitude: float
    altitude_km: float
    speed_km_s: float


@dataclass(frozen=True, slots=True)
class TrackPoint:
    """One point of the ground track."""

    time: datetime
    latitude: float
    longitude: float
    altitude_km: float
    sunlit: bool


def azimuth_to_compass(azimuth: float) -> str:
    """Return the 16-point compass direction for an azimuth in degrees."""
    return _COMPASS_POINTS[round((azimuth % 360) / 22.5) % 16]


def angular_separation(az1: float, el1: float, az2: float, el2: float) -> float:
    """Angle between two sky directions given as azimuth/elevation, in degrees."""
    a1, e1, a2, e2 = (x * _DEG for x in (az1, el1, az2, el2))
    c = math.sin(e1) * math.sin(e2) + math.cos(e1) * math.cos(e2) * math.cos(a1 - a2)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def _unix_to_jd(t: float) -> tuple[float, float]:
    """Split a Unix timestamp into a whole and fractional Julian date."""
    days = t / _SECONDS_PER_DAY
    whole = math.floor(days)
    return _UNIX_EPOCH_JD + whole, days - whole


def _gmst(jd: float, fr: float) -> float:
    """Greenwich Mean Sidereal Time in radians (IAU-82, as used with TEME)."""
    tut1 = ((jd - _J2000_JD) + fr) / 36525.0
    seconds = (
        -6.2e-6 * tut1**3
        + 0.093104 * tut1**2
        + (876600.0 * 3600 + 8640184.812866) * tut1
        + 67310.54841
    )
    return (seconds * _DEG / 240.0) % _TWO_PI


def _sun_eci_km(jd: float, fr: float) -> tuple[float, float, float]:
    """Geocentric equatorial Sun vector in km (Astronomical Almanac, low precision)."""
    n = (jd - _J2000_JD) + fr
    mean_longitude = (280.460 + 0.9856474 * n) * _DEG
    g = (357.528 + 0.9856003 * n) * _DEG
    ecliptic_longitude = mean_longitude + (1.915 * math.sin(g) + 0.020 * math.sin(2 * g)) * _DEG
    obliquity = (23.439 - 0.0000004 * n) * _DEG
    distance = (1.00014 - 0.01671 * math.cos(g) - 0.00014 * math.cos(2 * g)) * _AU_KM
    return (
        distance * math.cos(ecliptic_longitude),
        distance * math.cos(obliquity) * math.sin(ecliptic_longitude),
        distance * math.sin(obliquity) * math.sin(ecliptic_longitude),
    )


def _rotate_to_ecef(v: tuple[float, float, float], theta: float) -> tuple[float, float, float]:
    """Rotate an inertial vector into Earth-fixed axes by sidereal angle theta."""
    c, s = math.cos(theta), math.sin(theta)
    return (c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2])


def _geodetic_to_ecef(lat: float, lon: float, h_km: float) -> tuple[float, float, float]:
    sin_lat = math.sin(lat)
    n = _WGS84_A_KM / math.sqrt(1 - _WGS84_E2 * sin_lat * sin_lat)
    return (
        (n + h_km) * math.cos(lat) * math.cos(lon),
        (n + h_km) * math.cos(lat) * math.sin(lon),
        (n * (1 - _WGS84_E2) + h_km) * sin_lat,
    )


def _ecef_to_geodetic(r: tuple[float, float, float]) -> tuple[float, float, float]:
    """Return (latitude deg, longitude deg, height km) for an Earth-fixed vector."""
    x, y, z = r
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - _WGS84_E2))
    for _ in range(6):
        sin_lat = math.sin(lat)
        n = _WGS84_A_KM / math.sqrt(1 - _WGS84_E2 * sin_lat * sin_lat)
        lat = math.atan2(z + _WGS84_E2 * n * sin_lat, p)
    sin_lat = math.sin(lat)
    height = (
        p * math.cos(lat) + z * sin_lat
        - _WGS84_A_KM * math.sqrt(1 - _WGS84_E2 * sin_lat * sin_lat)
    )  # fmt: skip
    return lat / _DEG, math.degrees(math.atan2(y, x)), height


def _is_sunlit(sat: tuple[float, float, float], sun: tuple[float, float, float]) -> bool:
    """Whether the line from the station to the Sun clears the Earth.

    Mirrors Skyfield's ``is_sunlit``: the Earth is a sphere and the Sun a point,
    so the change to shadow is instantaneous rather than a few seconds of fading.
    """
    d = (sun[0] - sat[0], sun[1] - sat[1], sun[2] - sat[2])
    dist = math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2)
    u = (d[0] / dist, d[1] / dist, d[2] / dist)
    b = sat[0] * u[0] + sat[1] * u[1] + sat[2] * u[2]
    c = sat[0] ** 2 + sat[1] ** 2 + sat[2] ** 2 - _SHADOW_RADIUS_KM**2
    disc = b * b - c
    if disc < 0:
        return True
    return -b + math.sqrt(disc) <= 0


def _to_datetime(t: float) -> datetime:
    return datetime.fromtimestamp(t, UTC)


@dataclass(slots=True)
class _State:
    """Everything computed for one instant, kept internal to the engine."""

    t: float
    azimuth: float
    elevation: float
    range_km: float
    sat_ecef: tuple[float, float, float]
    sun_ecef: tuple[float, float, float]
    velocity_km_s: float


class PassPredictor:
    """Predicts where the station is and when it passes over an observer."""

    def __init__(self, satrec: Satrec, observer: Observer) -> None:
        """Initialise with SGP4 elements and the observer location."""
        self._satrec = satrec
        self.observer = observer
        lat = observer.latitude * _DEG
        lon = observer.longitude * _DEG
        self._obs_ecef = _geodetic_to_ecef(lat, lon, observer.elevation_m / 1000.0)
        sin_lat, cos_lat = math.sin(lat), math.cos(lat)
        sin_lon, cos_lon = math.sin(lon), math.cos(lon)
        # Rows of the Earth-fixed -> South/East/Zenith rotation.
        self._south = (sin_lat * cos_lon, sin_lat * sin_lon, -cos_lat)
        self._east = (-sin_lon, cos_lon, 0.0)
        self._zenith = (cos_lat * cos_lon, cos_lat * sin_lon, sin_lat)

    # -- single instants -------------------------------------------------

    def _propagate(
        self, t: float
    ) -> tuple[float, float, tuple[float, float, float], tuple[float, float, float]]:
        """Julian date, its fraction, and the TEME position and velocity at ``t``."""
        jd, fr = _unix_to_jd(t)
        error, r, v = self._satrec.sgp4(jd, fr)
        if error:
            raise PropagationError(SGP4_ERRORS.get(error, f"SGP4 error {error}"))
        return jd, fr, r, v

    def _state(self, t: float) -> _State:
        jd, fr, r, v = self._propagate(t)
        theta = _gmst(jd, fr)
        sat = _rotate_to_ecef(r, theta)
        sun = _rotate_to_ecef(_sun_eci_km(jd, fr), theta)
        az, el, rng = self._look(sat)
        return _State(t, az, el, rng, sat, sun, math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2))

    def _look(self, target: tuple[float, float, float]) -> tuple[float, float, float]:
        """Azimuth (deg), elevation (deg) and range (km) of an Earth-fixed point."""
        o = self._obs_ecef
        rx, ry, rz = target[0] - o[0], target[1] - o[1], target[2] - o[2]
        s = self._south[0] * rx + self._south[1] * ry + self._south[2] * rz
        e = self._east[0] * rx + self._east[1] * ry
        z = self._zenith[0] * rx + self._zenith[1] * ry + self._zenith[2] * rz
        rng = math.sqrt(rx * rx + ry * ry + rz * rz)
        az = math.degrees(math.atan2(e, -s)) % 360.0
        el = math.degrees(math.asin(max(-1.0, min(1.0, z / rng))))
        return az, el, rng

    def _elevation(self, t: float) -> float:
        # Most of the pass search asks only this: skip the Sun and the speed.
        jd, fr, r, _ = self._propagate(t)
        return self._look(_rotate_to_ecef(r, _gmst(jd, fr)))[1]

    def _sun_elevation(self, st: _State) -> float:
        return self._look(st.sun_ecef)[1]

    def _magnitude(self, st: _State) -> float | None:
        """Estimated visual magnitude (diffuse sphere phase law)."""
        to_sun = tuple(st.sun_ecef[i] - st.sat_ecef[i] for i in range(3))
        to_obs = tuple(self._obs_ecef[i] - st.sat_ecef[i] for i in range(3))
        cos_phase = sum(to_sun[i] * to_obs[i] for i in range(3)) / (
            math.sqrt(sum(c * c for c in to_sun)) * math.sqrt(sum(c * c for c in to_obs))
        )
        phase = math.acos(max(-1.0, min(1.0, cos_phase)))
        illumination = math.sin(phase) + (math.pi - phase) * math.cos(phase)
        if illumination <= 1e-6:
            return None
        return (
            ISS_STANDARD_MAGNITUDE
            + 5 * math.log10(st.range_km / 1000.0)
            - 2.5 * math.log10(illumination)
        )

    def _point(self, st: _State) -> SkyPoint:
        return SkyPoint(_to_datetime(st.t), st.azimuth, st.elevation, st.range_km)

    def look(self, when: datetime) -> SkyPoint:
        """Where the station is in the observer's sky at ``when``."""
        return self._point(self._state(when.timestamp()))

    def subpoint(self, when: datetime) -> SubPoint:
        """Return the ground point beneath the station at ``when``."""
        st = self._state(when.timestamp())
        lat, lon, alt = _ecef_to_geodetic(st.sat_ecef)
        return SubPoint(_to_datetime(st.t), lat, lon, alt, st.velocity_km_s)

    def track(self, start: datetime, end: datetime, step_s: float) -> list[TrackPoint]:
        """Ground track from ``start`` to ``end`` (inclusive) every ``step_s`` seconds."""
        points = []
        t, t_end = start.timestamp(), end.timestamp()
        while t <= t_end + 1e-6:
            st = self._state(t)
            lat, lon, alt = _ecef_to_geodetic(st.sat_ecef)
            points.append(
                TrackPoint(_to_datetime(t), lat, lon, alt, _is_sunlit(st.sat_ecef, st.sun_ecef))
            )
            t += step_s
        return points

    def sun_elevation(self, when: datetime) -> float:
        """Elevation of the Sun at the observer, in degrees."""
        return self._sun_elevation(self._state(when.timestamp()))

    def is_sunlit(self, when: datetime) -> bool:
        """Whether the station is in sunlight at ``when``."""
        st = self._state(when.timestamp())
        return _is_sunlit(st.sat_ecef, st.sun_ecef)

    def magnitude(self, when: datetime) -> float | None:
        """Estimated visual magnitude at ``when`` (ignores shadow and daylight)."""
        return self._magnitude(self._state(when.timestamp()))

    # -- pass search -----------------------------------------------------

    def find_passes(
        self,
        start: datetime,
        end: datetime,
        *,
        min_elevation: float = 10.0,
        max_sun_elevation: float = -6.0,
    ) -> list[Pass]:
        """Return every pass above ``min_elevation`` that sets after ``start``.

        A pass already under way at ``start`` is included. Passes whose peak is
        after ``end`` are not. The visible window of each pass covers the time
        the station is above ``min_elevation``, sunlit, and the Sun is at or
        below ``max_sun_elevation`` for the observer.
        """
        # The coarse grid sits on whole multiples of the step, not on ``start``,
        # so searches made at different times refine to identical passes.
        t0 = math.floor((start.timestamp() - _LOOKBACK_S) / _COARSE_STEP_S) * _COARSE_STEP_S
        t1 = end.timestamp()
        passes: list[Pass] = []
        last_set = -math.inf

        prev2 = prev1 = None
        t = t0
        # A peak just before ``end`` can have its highest coarse sample after
        # ``end`` (the grid is not aligned to it) and is only recognised on the
        # sample after that, so scan two steps past ``end``; the peak_t check
        # below still leaves out passes that peak after ``end``.
        while t <= t1 + 2 * _COARSE_STEP_S:
            el = self._elevation(t)
            if prev2 is not None and prev1 is not None and prev2[1] < prev1[1] >= el:
                peak_t = self._golden_max(prev2[0], t)
                if peak_t <= t1 and peak_t > last_set:
                    found = self._build_pass(peak_t, min_elevation, max_sun_elevation)
                    if found is not None and found.set.time.timestamp() > start.timestamp():
                        passes.append(found)
                        last_set = found.set.time.timestamp()
            prev2, prev1 = prev1, (t, el)
            t += _COARSE_STEP_S
        return passes

    def _golden_max(self, lo: float, hi: float) -> float:
        """Time of maximum elevation in [lo, hi] (elevation is unimodal there)."""
        ratio = (math.sqrt(5) - 1) / 2
        a, b = lo, hi
        c = b - ratio * (b - a)
        d = a + ratio * (b - a)
        fc, fd = self._elevation(c), self._elevation(d)
        while b - a > _TIME_TOLERANCE_S:
            if fc > fd:
                b, d, fd = d, c, fc
                c = b - ratio * (b - a)
                fc = self._elevation(c)
            else:
                a, c, fc = c, d, fd
                d = a + ratio * (b - a)
                fd = self._elevation(d)
        return (a + b) / 2

    def _bisect(self, inside: float, outside: float, test: Callable[[float], bool]) -> float:
        """Boundary between a time where ``test`` holds and one where it does not.

        Returns a time on the ``inside`` side so the result still satisfies
        ``test`` (to within the time tolerance).
        """
        while abs(outside - inside) > _TIME_TOLERANCE_S:
            mid = (inside + outside) / 2
            if test(mid):
                inside = mid
            else:
                outside = mid
        return inside

    def _crossing(self, peak_t: float, direction: int, min_elevation: float) -> float:
        """Time the station crosses ``min_elevation`` before (-1) or after (+1) the peak."""
        step = direction * _COARSE_STEP_S
        t = peak_t
        while True:
            t += step
            if abs(t - peak_t) > _MAX_HALF_PASS_S or self._elevation(t) < min_elevation:
                break
        return self._bisect(peak_t, t, lambda x: self._elevation(x) >= min_elevation)

    def _build_pass(
        self, peak_t: float, min_elevation: float, max_sun_elevation: float
    ) -> Pass | None:
        peak = self._state(peak_t)
        if peak.elevation < min_elevation:
            return None
        rise_t = self._crossing(peak_t, -1, min_elevation)
        set_t = self._crossing(peak_t, +1, min_elevation)
        rise, set_ = self._state(rise_t), self._state(set_t)

        def visible(t: float) -> bool:
            st = self._state(t)
            return (
                st.elevation >= min_elevation
                and _is_sunlit(st.sat_ecef, st.sun_ecef)
                and self._sun_elevation(st) <= max_sun_elevation
            )

        window = self._visible_window(rise, peak, set_, visible)
        return Pass(self._point(rise), self._point(peak), self._point(set_), window)

    def _visible_window(
        self,
        rise: _State,
        peak: _State,
        set_: _State,
        visible: Callable[[float], bool],
    ) -> VisibleWindow | None:
        """Find the longest stretch of the pass where the station can be seen."""
        times = [rise.t]
        t = rise.t + _FINE_STEP_S
        while t < set_.t:
            times.append(t)
            t += _FINE_STEP_S
        times.append(set_.t)
        flags = [visible(x) for x in times]

        best: tuple[float, float] | None = None
        i = 0
        while i < len(times):
            if not flags[i]:
                i += 1
                continue
            j = i
            while j + 1 < len(times) and flags[j + 1]:
                j += 1
            run_start = times[i] if i == 0 else self._bisect(times[i], times[i - 1], visible)
            run_end = (
                times[j] if j == len(times) - 1 else self._bisect(times[j], times[j + 1], visible)
            )
            if best is None or run_end - run_start > best[1] - best[0]:
                best = (run_start, run_end)
            i = j + 1
        if best is None:
            return None

        start = self._state(best[0])
        end = self._state(best[1])
        if start.t <= peak.t <= end.t:
            top = peak
        else:
            top = start if start.elevation >= end.elevation else end

        samples = [start, top, end]
        samples += [self._state(x) for x in times if start.t < x < end.t]
        magnitudes = [m for m in map(self._magnitude, samples) if m is not None]

        return VisibleWindow(
            start=self._point(start),
            peak=self._point(top),
            end=self._point(end),
            magnitude=min(magnitudes) if magnitudes else None,
            starts_from_shadow=best[0] > rise.t + _TIME_TOLERANCE_S
            and not _is_sunlit(*self._shadow_probe(best[0] - 1.0)),
            ends_in_shadow=best[1] < set_.t - _TIME_TOLERANCE_S
            and not _is_sunlit(*self._shadow_probe(best[1] + 1.0)),
        )

    def _shadow_probe(
        self, t: float
    ) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
        st = self._state(t)
        return st.sat_ecef, st.sun_ecef
