/**
 * Geometry and formatting helpers for the ISS globe. Pure functions with no
 * DOM or WebGL, unit tested with `node --test "tests/js/*.test.mjs"`.
 *
 * Track rows, as sent by the integration: [unix seconds, latitude, longitude,
 * altitude km, sunlit 0/1].
 */

const DEG = Math.PI / 180;
const WGS84_A_KM = 6378.137;
const WGS84_E2 = 0.00669437999014;
const EARTH_MU = 398600.4418; // km^3/s^2
export const MERCATOR_MAX_LAT = 85.051129;
/** Orbital period of the ISS, near enough for counting orbits. */
export const ISS_PERIOD_S = 92.9 * 60;

export function wrapLongitude(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Web Mercator coordinates in 0..1 (MapLibre's "mercator units"). */
export function mercator(lat, lon) {
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const y = Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2));
  return [(wrapLongitude(lon) + 180) / 360, 0.5 - y / (2 * Math.PI)];
}

function gmst(jd) {
  const t = (jd - 2451545.0) / 36525.0;
  const seconds =
    -6.2e-6 * t ** 3 + 0.093104 * t ** 2 + (876600.0 * 3600 + 8640184.812866) * t + 67310.54841;
  return (((seconds * DEG) / 240.0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
}

/** Point on Earth with the Sun overhead (same low-precision formula as the Python engine). */
export function subsolarPoint(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const meanLongitude = 280.46 + 0.9856474 * n;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = (meanLongitude + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const obliquity = (23.439 - 0.0000004 * n) * DEG;
  const ra = Math.atan2(Math.cos(obliquity) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(obliquity) * Math.sin(lambda));
  return { lat: dec / DEG, lon: wrapLongitude((ra - gmst(jd)) / DEG) };
}

/** Unit vector towards the Sun in an Earth-fixed frame: x at (0, 0), y at (0, 90E), z north. */
export function sunVector(date) {
  const s = subsolarPoint(date);
  const lat = s.lat * DEG;
  const lon = s.lon * DEG;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

/** Elevation of the Sun, in degrees, seen from a point on Earth. */
export function sunElevation(lat, lon, sun) {
  const s =
    Math.sin(lat * DEG) * Math.sin(sun.lat * DEG) +
    Math.cos(lat * DEG) * Math.cos(sun.lat * DEG) * Math.cos((lon - sun.lon) * DEG);
  return Math.asin(Math.max(-1, Math.min(1, s))) / DEG;
}

/** Position on a track at time t (unix seconds), interpolated; null outside the track. */
export function positionAt(track, t) {
  if (!track || track.length < 2 || t < track[0][0] || t > track[track.length - 1][0]) {
    return null;
  }
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const a = track[lo];
  const b = track[hi];
  const f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
  return {
    t,
    lat: a[1] + f * (b[1] - a[1]),
    lon: wrapLongitude(a[2] + f * wrapLongitude(b[2] - a[2])),
    alt: a[3] + f * (b[3] - a[3]),
    sunlit: (f < 0.5 ? a[4] : b[4]) === 1,
  };
}

/** Initial great-circle bearing from one point to another, in degrees. */
export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Ground distance in km (spherical Earth). */
export function groundDistanceKm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const h =
    Math.sin((p2 - p1) / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
  return 2 * 6371.0 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ring of [lon, lat] points at a fixed angular distance (degrees) around a centre. */
export function circleRing(lat, lon, radiusDeg, points = 96) {
  const p1 = lat * DEG;
  const d = radiusDeg * DEG;
  const ring = [];
  for (let i = 0; i <= points; i++) {
    const b = (2 * Math.PI * i) / points;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 =
      lon * DEG +
      Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    // Keep longitudes continuous around the centre so the ring never jumps.
    let lng = l2 / DEG;
    while (lng - lon > 180) lng -= 360;
    while (lng - lon < -180) lng += 360;
    ring.push([lng, Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, p2 / DEG))]);
  }
  return ring;
}

/**
 * Angular radius (degrees) of the ground circle from which a satellite at
 * altitudeKm is at least minElevation degrees above the horizon.
 */
export function visibilityRadius(altitudeKm, minElevation) {
  const e = minElevation * DEG;
  return (Math.acos((WGS84_A_KM * Math.cos(e)) / (WGS84_A_KM + altitudeKm)) - e) / DEG;
}

function ecef(latDeg, lonDeg, hKm) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const n = WGS84_A_KM / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
  return [
    (n + hKm) * Math.cos(lat) * Math.cos(lon),
    (n + hKm) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - WGS84_E2) + hKm) * Math.sin(lat),
  ];
}

/** Azimuth, elevation (degrees) and range (km) of the station from an observer. */
export function lookAngles(observer, station) {
  const o = ecef(observer.latitude, observer.longitude, (observer.elevation || 0) / 1000);
  const s = ecef(station.lat, station.lon, station.alt);
  const r = [s[0] - o[0], s[1] - o[1], s[2] - o[2]];
  const lat = observer.latitude * DEG;
  const lon = observer.longitude * DEG;
  const east = -Math.sin(lon) * r[0] + Math.cos(lon) * r[1];
  const north =
    -Math.sin(lat) * Math.cos(lon) * r[0] - Math.sin(lat) * Math.sin(lon) * r[1] + Math.cos(lat) * r[2];
  const up =
    Math.cos(lat) * Math.cos(lon) * r[0] + Math.cos(lat) * Math.sin(lon) * r[1] + Math.sin(lat) * r[2];
  const range = Math.hypot(r[0], r[1], r[2]);
  return {
    azimuth: (Math.atan2(east, north) / DEG + 360) % 360,
    elevation: Math.asin(up / range) / DEG,
    range,
  };
}

/** Where a track appears in the observer's sky: [{t, azimuth, elevation, sunlit}]. */
export function skyTrack(observer, rows) {
  return (rows || []).map((r) => ({
    t: r[0],
    ...lookAngles(observer, { lat: r[1], lon: r[2], alt: r[3] }),
    sunlit: r[4] === 1,
  }));
}

/** Index of the row where the station is highest in the observer's sky. */
export function closestApproach(observer, rows) {
  let best = -1;
  let bestEl = -Infinity;
  (rows || []).forEach((r, i) => {
    const el = lookAngles(observer, { lat: r[1], lon: r[2], alt: r[3] }).elevation;
    if (el > bestEl) {
      bestEl = el;
      best = i;
    }
  });
  return best;
}

/** Orbital speed (km/s) at an altitude, for a near-circular orbit like the ISS's. */
export function orbitalSpeed(altitudeKm) {
  return Math.sqrt(EARTH_MU / (WGS84_A_KM + altitudeKm));
}

const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];
export function compass(azimuth) {
  return COMPASS[Math.round((((azimuth % 360) + 360) % 360) / 22.5) % 16];
}

/** Escape text for use in HTML. */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** "1d 07:42:13", "07:42:13" or "42:13". */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v) => String(v).padStart(2, "0");
  if (days) return `${days}d ${pad(h)}:${pad(m)}:${pad(s)}`;
  if (h) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/** "2 h 14 min", "14 min", "under a minute". */
export function formatDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "under a minute";
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d) return `${d} d ${h} h`;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

/** The visible pass under way, or else the next one. */
export function currentVisiblePass(payload, nowMs) {
  const list = payload?.upcoming_visible_passes || [];
  return list.find((p) => Date.parse(p.end) > nowMs) || null;
}

/**
 * Timeline of the fast-forward preview: sweep quickly to a few minutes before
 * the pass, play the pass itself slowly, then hold. With `skipApproach` (for
 * reduced motion) it starts at the lead-in instead of sweeping there.
 *
 * Returns { at(realMs) -> {sim, phase, done}, durationMs }.
 */
export function previewTimeline(simStartS, passStartS, passEndS, options = {}) {
  const lead = options.leadS ?? 240;
  const slowRate = options.slowRate ?? 30; // simulated seconds per real second during the pass
  const holdMs = options.holdMs ?? 2500;
  const startS = options.skipApproach ? Math.max(simStartS, passStartS - lead) : simStartS;
  const approachS = Math.max(0, passStartS - lead - startS);
  // About 1.5 s per orbit, between 3 and 9 seconds in all.
  const fastMs = approachS > 0 ? Math.min(9000, Math.max(3000, (approachS / ISS_PERIOD_S) * 1500)) : 0;
  const slowStartS = startS + approachS;
  const slowMs = ((passEndS + 60 - slowStartS) / slowRate) * 1000;
  const durationMs = fastMs + slowMs + holdMs;
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
  return {
    durationMs,
    at(realMs) {
      if (realMs < fastMs) {
        return { sim: startS + approachS * ease(realMs / fastMs), phase: "approach", done: false };
      }
      if (realMs < fastMs + slowMs) {
        return { sim: slowStartS + ((realMs - fastMs) / 1000) * slowRate, phase: "pass", done: false };
      }
      return { sim: passEndS + 60, phase: "hold", done: realMs >= durationMs };
    },
  };
}

/**
 * How long to wait before the next redraw, in ms; 0 means every display frame.
 *
 * `pxPerSecond` is how fast the station moves on screen (0 when it is off
 * screen). Aim for half a pixel per redraw, at least once a second. MapLibre
 * keeps redrawing for its 300 ms label fade after every camera move, so
 * anything between about 3 and 60 updates a second costs as much as redrawing
 * every frame: either wait at least 350 ms (steps of under 2 px up to 5 px/s),
 * or, once the motion is faster than that, redraw every frame.
 */
export function frameDelay(pxPerSecond, { chase = false, preview = false } = {}) {
  if (preview) return 0;
  // The near ground in the tilted chase view moves faster than the station.
  const speed = pxPerSecond * (chase ? 2.5 : 1);
  if (speed > 5) return 0;
  const ms = speed > 0 ? 500 / speed : Infinity;
  return Math.min(Math.max(ms, 350), 1000);
}

/** Whether to show a 12-hour clock, decided the way Home Assistant decides it. */
export function uses12Hour(locale) {
  const format = locale?.time_format;
  if (format === "12") return true;
  if (format === "24") return false;
  const language = format === "system" ? undefined : locale?.language;
  try {
    return new Date("January 1, 2023 22:00:00").toLocaleString(language).includes("10");
  } catch {
    return false;
  }
}

/** Locales and options for Intl.NumberFormat that follow Home Assistant's number format setting. */
export function numberLocale(locale) {
  switch (locale?.number_format) {
    case "comma_decimal":
      return [["en-US", "en"], {}];
    case "decimal_comma":
      return [["de", "es", "it"], {}];
    case "space_comma":
      return [["fr", "sv", "cs"], {}];
    case "quote_decimal":
      return [["de-CH"], {}];
    case "system":
      return [undefined, {}];
    case "none":
      return [["en-US"], { useGrouping: false }];
    default:
      return [locale?.language, {}];
  }
}
