// Unit tests for the globe's pure helpers: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bearing,
  circleRing,
  closestApproach,
  compass,
  currentVisiblePass,
  esc,
  formatCountdown,
  formatDuration,
  groundDistanceKm,
  lookAngles,
  mercator,
  orbitalSpeed,
  positionAt,
  previewTimeline,
  skyTrack,
  subsolarPoint,
  sunElevation,
  sunVector,
  visibilityRadius,
  wrapLongitude,
} from "../../custom_components/iss_tracker/frontend/iss-geo.js";
import { skyChartSvg, skyXY } from "../../custom_components/iss_tracker/frontend/iss-sky.js";
import { SpaceLayer, buildRibbon } from "../../custom_components/iss_tracker/frontend/iss-space.js";

const close = (actual, expected, tolerance, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} != ${expected} ± ${tolerance}`);

// Reference values from the Python engine (itself checked against Skyfield).
const SUN = [
  { time: "2026-03-20T12:00:00Z", lat: -0.0434, lon: 1.8656 },
  { time: "2026-06-21T18:30:00Z", lat: 23.4345, lon: -97.0288 },
  { time: "2026-10-09T23:15:00Z", lat: -6.5515, lon: -171.9686 },
  { time: "2026-12-21T03:00:00Z", lat: -23.4329, lon: 134.4689 },
];
const DENVER = { latitude: 39.74, longitude: -104.99, elevation: 1609 };
const LOOKS = [
  { lat: 43.496015, lon: -121.088092, alt: 427.0063, azimuth: 292.534, elevation: 10.001, range: 1507.09 },
  { lat: 36.36276, lon: -108.981291, alt: 424.6421, azimuth: 224.301, elevation: 36.269, range: 677.89 },
  { lat: 28.432903, lon: -98.278892, alt: 425.5809, azimuth: 151.771, elevation: 10.0, range: 1502.1 },
  { lat: 40.628149, lon: -105.855932, alt: 428.3167, azimuth: 323.496, elevation: 72.835, range: 445.27 },
];
const rows = LOOKS.map((l, i) => [1000 + i * 60, l.lat, l.lon, l.alt, 1]);

test("subsolar point and sun vector match the Python engine", () => {
  for (const s of SUN) {
    const p = subsolarPoint(new Date(s.time));
    close(p.lat, s.lat, 0.01, s.time);
    close(wrapLongitude(p.lon - s.lon), 0, 0.01, s.time);
    const v = sunVector(new Date(s.time));
    close(Math.hypot(...v), 1, 1e-12);
    close(Math.asin(v[2]) * (180 / Math.PI), s.lat, 0.01);
  }
});

test("look angles match the Python engine", () => {
  for (const l of LOOKS) {
    const a = lookAngles(DENVER, { lat: l.lat, lon: l.lon, alt: l.alt });
    close(a.elevation, l.elevation, 0.01, "elevation");
    close(wrapLongitude(a.azimuth - l.azimuth), 0, 0.01, "azimuth");
    close(a.range, l.range, 0.1, "range");
  }
  const sky = skyTrack(DENVER, rows);
  assert.equal(sky.length, rows.length);
  close(sky[1].elevation, 36.269, 0.01);
  assert.equal(closestApproach(DENVER, rows), 3); // the 72.8 deg point
});

test("sun elevation is 90 at the subsolar point and -90 opposite", () => {
  const sun = { lat: 10, lon: 20 };
  close(sunElevation(10, 20, sun), 90, 1e-6);
  close(sunElevation(-10, -160, sun), -90, 1e-6);
});

test("mercator coordinates", () => {
  assert.deepEqual(mercator(0, 0), [0.5, 0.5]);
  close(mercator(0, -180)[0], 0, 1e-12);
  close(mercator(85.051129, 90)[1], 0, 1e-6);
  close(mercator(-89, 90)[1], 1, 1e-6); // clamped to the mercator limit
  close(mercator(0, 190)[0], mercator(0, -170)[0], 1e-12);
});

test("interpolates position across the antimeridian", () => {
  const track = [
    [0, 10, 179, 420, 1],
    [30, 11, -179, 422, 0],
  ];
  const mid = positionAt(track, 15);
  close(mid.lat, 10.5, 1e-9);
  close(Math.abs(mid.lon), 180, 1e-9);
  close(mid.alt, 421, 1e-9);
  assert.equal(positionAt(track, -1), null);
  assert.equal(positionAt(track, 31), null);
  assert.equal(positionAt(track, 10).sunlit, true);
  assert.equal(positionAt(track, 20).sunlit, false);
});

test("circle radius, distance, bearing and speed", () => {
  // From 420 km the horizon is acos(R / (R + h)) = 20.25 deg of arc away;
  // the station is above 10 deg elevation within 12.49 deg.
  close(visibilityRadius(420, 0), 20.2455, 0.001);
  close(visibilityRadius(420, 10), 12.4872, 0.001);
  const ring = circleRing(0, 179, 10, 36);
  assert.equal(ring.length, 37);
  assert.ok(ring.every(([lon]) => Math.abs(lon - 179) <= 10.01));
  close(groundDistanceKm(0, 0, 0, 90), 10007.5, 1);
  close(bearing(0, 0, 10, 0), 0, 1e-9);
  close(bearing(0, 0, 0, 10), 90, 1e-9);
  close(orbitalSpeed(420), 7.66, 0.01);
});

test("formatting", () => {
  assert.equal(formatCountdown(65_000), "01:05");
  assert.equal(formatCountdown(3_725_000), "01:02:05");
  assert.equal(formatCountdown(93_784_000), "1d 02:03:04");
  assert.equal(formatCountdown(-5), "00:00");
  assert.equal(formatDuration(20_000), "under a minute");
  assert.equal(formatDuration(14 * 60_000), "14 min");
  assert.equal(formatDuration(134 * 60_000), "2 h 14 min");
  assert.equal(formatDuration(120 * 60_000), "2 h");
  assert.equal(formatDuration(26 * 3600_000), "1 d 2 h");
  assert.equal(compass(0), "N");
  assert.equal(compass(202), "SSW");
  assert.equal(compass(-90), "W");
  assert.equal(esc(`<b a="x">&'`), "&#60;b a=&#34;x&#34;&#62;&#38;&#39;");
});

test("picks the pass in progress, else the next one", () => {
  const payload = {
    upcoming_visible_passes: [
      { start: "2026-10-10T10:00:00Z", end: "2026-10-10T10:05:00Z" },
      { start: "2026-10-11T10:00:00Z", end: "2026-10-11T10:05:00Z" },
    ],
  };
  assert.equal(currentVisiblePass(payload, Date.parse("2026-10-10T10:02:00Z")).start, "2026-10-10T10:00:00Z");
  assert.equal(currentVisiblePass(payload, Date.parse("2026-10-10T10:06:00Z")).start, "2026-10-11T10:00:00Z");
  assert.equal(currentVisiblePass(payload, Date.parse("2026-10-12T00:00:00Z")), null);
});

test("preview timeline sweeps to the pass, plays it, then ends", () => {
  const start = 0;
  const passStart = 3 * 3600; // two orbits away
  const passEnd = passStart + 360;
  const tl = previewTimeline(start, passStart, passEnd);
  assert.ok(tl.durationMs > 3000 && tl.durationMs < 40000, `${tl.durationMs}`);
  assert.equal(tl.at(0).sim, 0);
  assert.equal(tl.at(0).phase, "approach");
  // Monotonic simulated time.
  let last = -1;
  for (let ms = 0; ms <= tl.durationMs; ms += 50) {
    const s = tl.at(ms);
    assert.ok(s.sim >= last - 1e-9, `time went backwards at ${ms} ms`);
    last = s.sim;
  }
  const passMoment = [...Array(400).keys()].map((i) => tl.at((i / 400) * tl.durationMs)).find((s) => s.phase === "pass");
  assert.ok(passMoment.sim >= passStart - 240 - 1 && passMoment.sim <= passEnd + 60);
  assert.equal(tl.at(tl.durationMs).done, true);
  // A pass starting within the lead time skips the fast part.
  assert.equal(previewTimeline(0, 100, 400).at(0).phase, "pass");
});

test("sky chart geometry and SVG", () => {
  const [cx, cy] = skyXY(0, 90, 100, 110); // zenith is the centre
  close(cx, 110, 1e-9);
  close(cy, 110, 1e-9);
  const [nx, ny] = skyXY(0, 0, 100, 110); // north on the horizon is at the top
  close(nx, 110, 1e-9);
  close(ny, 10, 1e-9);
  const [ex] = skyXY(90, 0, 100, 110); // east to the right
  close(ex, 210, 1e-9);

  const track = [
    { t: 0, azimuth: 225, elevation: 2 },
    { t: 60, azimuth: 200, elevation: 30 },
    { t: 120, azimuth: 120, elevation: 67 },
    { t: 180, azimuth: 60, elevation: 25 },
    { t: 240, azimuth: 45, elevation: 3 },
  ];
  const svg = skyChartSvg({
    track, visibleStart: 60, visibleEnd: 180, live: { azimuth: 120, elevation: 67 },
    formatTime: (t) => `T${t}`,
  });
  assert.match(svg, /^<svg/);
  assert.match(svg, />T60</);
  assert.match(svg, />T180</);
  assert.match(svg, />67°</);
  assert.match(svg, /class="live"/);
  assert.doesNotMatch(svg, /NaN/);
  assert.doesNotMatch(skyChartSvg({ track: [], visibleStart: 0, visibleEnd: 1, formatTime: String }), /class="vis"/);
});

test("ribbons split at the antimeridian", () => {
  const pts = [
    [0.97, 0.4, 400000, 0, 1],
    [0.99, 0.41, 400000, 30, 1],
    [0.01, 0.42, 400000, 60, 0],
    [0.03, 0.43, 400000, 90, 0],
  ];
  const { data, segments } = buildRibbon(pts);
  assert.equal(segments.length, 2);
  const stride = 12;
  // The first piece ends on the right edge, the second starts on the left edge.
  const lastOfFirst = (segments[0][0] + segments[0][1] - 1) * stride;
  const firstOfSecond = segments[1][0] * stride;
  close(data[lastOfFirst], 1, 1e-6);
  close(data[firstOfSecond], 0, 1e-6);
  close(data[lastOfFirst + 1], data[firstOfSecond + 1], 1e-6); // same latitude at the seam
  assert.ok(data.every(Number.isFinite));
  assert.equal(buildRibbon([pts[0]]).segments.length, 0);
});

test("CPU projection uses MapLibre's globe axes and hides the far side", () => {
  const layer = new SpaceLayer();
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  // Globe variant, identity matrix: the clip position is the unit-sphere position.
  layer._last = { main: identity, fallback: identity, plane: [0, 0, 1, 0], transition: 1, globe: true };
  const front = layer.project(0, 0, 0, 200, 200); // (0, 0) faces +z
  close(front.x, 100, 1e-6);
  close(front.y, 100, 1e-6);
  const east = layer.project(0, 60, 0, 200, 200); // 60E: x = sin(60) > 0, right of centre
  assert.ok(east.x > 150);
  const north = layer.project(45, 0, 0, 200, 200); // north is up the screen
  assert.ok(north.y < 100);
  assert.equal(layer.project(0, 180, 0, 200, 200), null); // behind the globe
  // Flat variant: mercator in, clip out.
  layer._last = { main: identity, fallback: identity, plane: [0, 0, 0, 0], transition: 0, globe: false };
  const flat = layer.project(0, 0, 0, 200, 200);
  close(flat.x, 150, 1e-6); // mercator x 0.5 -> clip 0.5 -> 150 px
});
