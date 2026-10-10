// Unit tests for the WebGL layers (iss-space.js) and the sky chart: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import { circleRing, visibilityRadius } from "../../custom_components/iss_pass_prediction/frontend/iss-geo.js";
import { skyChartSvg } from "../../custom_components/iss_pass_prediction/frontend/iss-sky.js";
import {
  NightLayer,
  SpaceLayer,
  buildRibbon,
  loadCityLights,
  toMercator,
} from "../../custom_components/iss_pass_prediction/frontend/iss-space.js";

const close = (actual, expected, tolerance, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} != ${expected} ± ${tolerance}`);
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const DEG = Math.PI / 180;
const ISS_M = 420000;

test("points high above the ground stay in view past the limb, as far as the planet does not hide them", () => {
  const layer = new SpaceLayer();
  const D = 3.79; // camera distance in globe radii (the default view)
  layer._last = { main: IDENTITY, fallback: IDENTITY, plane: [0, 0, 1, -1 / D], transition: 1, globe: true };
  // Along the equator the angle from the camera axis (+z) is the longitude.
  assert.ok(layer.project(0, 85, ISS_M, 400, 400), "85 deg: in space beyond the limb, visible");
  assert.equal(layer.project(0, 100, ISS_M, 400, 400), null, "100 deg: behind the planet");
  // Brute force: the line of sight from the camera at (0, 0, D) must miss the unit sphere.
  const k = 1 + ISS_M / 6371008.8;
  const seen = (deg) => {
    const d = [Math.sin(deg * DEG) * k, 0, Math.cos(deg * DEG) * k - D];
    const t = Math.max(0, Math.min(1, (-D * d[2]) / (d[0] ** 2 + d[2] ** 2)));
    return Math.hypot(t * d[0], D + t * d[2]) >= 1;
  };
  for (let deg = 80; deg <= 100; deg += 0.25) {
    assert.equal(!!layer.project(0, deg, ISS_M, 400, 400), seen(deg), `${deg} deg at 420 km`);
  }
  // On the ground it is MapLibre's own clipping plane.
  for (let deg = 70; deg <= 80; deg += 0.1) {
    const inFront = Math.cos(deg * DEG) - 1 / D >= 0;
    assert.equal(!!layer.project(0, deg, 0, 400, 400), inFront, `${deg} deg on the ground`);
  }
});

test("on the flat map a point is placed on the copy of the world nearest the centre", () => {
  const layer = new SpaceLayer();
  // Clip x = 10 * (mercator x - 1.02): the view is centred on 187.2 E, past the antimeridian.
  const main = [10, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -10.2, 0, 0, 1];
  layer._last = { main, fallback: main, plane: [0, 0, 0, 0], transition: 0, globe: false, center: 1.02 };
  const east = layer.project(0, -179, 0, 200, 200); // mercator x 0.003, drawn at 1.003
  close(east.x, (10 * (1 + toMercator(0, -179)[0] - 1.02) * 0.5 + 0.5) * 200, 1e-6);
  const west = layer.project(0, 170, 0, 200, 200); // mercator x 0.972 is already the nearest
  close(west.x, (10 * (toMercator(0, 170)[0] - 1.02) * 0.5 + 0.5) * 200, 1e-6);
  // While the globe flattens into the map, the flat half uses that copy too (the camera looks along -z here).
  layer._last = { main: IDENTITY, fallback: main, plane: [0, 0, -1, 0], transition: 0.5, globe: true, center: 1.02 };
  const lon = -179;
  const [x] = toMercator(0, lon);
  const globeX = Math.sin(x * 2 * Math.PI + Math.PI);
  const flatX = 10 * (x + 1 - 1.02);
  close(layer.project(0, lon, 0, 200, 200).x, ((0.5 * globeX + 0.5 * flatX) * 0.5 + 0.5) * 200, 1e-6);
});

test("ribbons are split at the antimeridian and the prime meridian into pieces of at most half a world", () => {
  const pts = [0.3, 0.45, 0.55, 0.7, 0.95, 0.05, 0.2].map((x, i) => [x, 0.4, 0, i * 10, 1]);
  const { data, segments } = buildRibbon(pts);
  assert.equal(segments.length, 3);
  const stride = 12;
  for (const [first, count, mid] of segments) {
    const xs = [];
    for (let v = first; v < first + count; v++) xs.push(data[v * stride]);
    assert.ok(Math.max(...xs) - Math.min(...xs) <= 0.5 + 1e-6, `piece spans ${Math.max(...xs) - Math.min(...xs)}`);
    close(mid, (Math.max(...xs) + Math.min(...xs)) / 2, 1e-6);
  }
  // The cut at x = 0.5 is shared by both pieces, with the time interpolated.
  const endOfFirst = (segments[0][0] + segments[0][1] - 1) * stride;
  close(data[endOfFirst], 0.5, 1e-6);
  close(data[endOfFirst + 10], 15, 1e-4);
  close(data[segments[1][0] * stride], 0.5, 1e-6);
});

test("a ring numbers its points, so a dashed ring has dashes", () => {
  const layer = new SpaceLayer();
  const ring = circleRing(20, -60, 15, 24);
  layer.setRing("footprint", ring, 0);
  const { data, segments } = layer._ribbons.get("footprint");
  assert.equal(segments.length, 1);
  for (let i = 0; i < ring.length; i++) {
    close(data[i * 2 * 12 + 10], i, 1e-6);
    close(data[(i * 2 + 1) * 12 + 10], i, 1e-6);
  }
  // Across the prime meridian the cut gets an index between its neighbours.
  layer.setRing("footprint", circleRing(0, 0, 10, 8), 0);
  const r = layer._ribbons.get("footprint");
  assert.equal(r.segments.length, 3);
  const ts = Array.from({ length: r.data.length / 12 }, (_, v) => r.data[v * 12 + 10]);
  assert.ok(ts.every((t, i) => i === 0 || t >= ts[i - 1] - 1e-6), "indices only grow along the ring");
});

/**
 * Rasterise flat-map triangles [x, y, elevation, alpha] (mercator units, y clamped to the map)
 * and compare with the true circle around home.
 */
function rasterise(data, home, radiusDeg, W = 360) {
  const x0 = toMercator(home.latitude, home.longitude)[0];
  const [yLo, yHi] = home.latitude > 0 ? [0, 0.42] : [0.58, 1];
  const H = Math.round(W * (yHi - yLo));
  const hits = new Uint8Array(W * H);
  const clampY = (y) => Math.min(1, Math.max(0, y));
  for (let t = 0; t < data.length; t += 12) {
    const p = [data[t], clampY(data[t + 1])];
    const q = [data[t + 4], clampY(data[t + 5])];
    const r = [data[t + 8], clampY(data[t + 9])];
    const det = (q[1] - r[1]) * (p[0] - r[0]) + (r[0] - q[0]) * (p[1] - r[1]);
    if (Math.abs(det) < 1e-15) continue;
    for (let j = 0; j < H; j++) {
      const y = yLo + (j + 0.5) / W;
      for (let i = 0; i < W; i++) {
        const x = x0 - 0.5 + (i + 0.5) / W;
        const a = ((q[1] - r[1]) * (x - r[0]) + (r[0] - q[0]) * (y - r[1])) / det;
        const b = ((r[1] - p[1]) * (x - r[0]) + (p[0] - r[0]) * (y - r[1])) / det;
        if (a >= 0 && b >= 0 && a + b <= 1) hits[j * W + i]++;
      }
    }
  }
  let inCap = 0, gaps = 0, outside = 0, overlaps = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const lat = (2 * Math.atan(Math.exp(Math.PI - 2 * Math.PI * (yLo + (j + 0.5) / W))) - Math.PI / 2) / DEG;
      const lon = (x0 - 0.5 + (i + 0.5) / W) * 360 - 180;
      const c = Math.sin(home.latitude * DEG) * Math.sin(lat * DEG) +
        Math.cos(home.latitude * DEG) * Math.cos(lat * DEG) * Math.cos((lon - home.longitude) * DEG);
      const inside = Math.acos(Math.min(1, c)) / DEG <= radiusDeg;
      const n = hits[j * W + i];
      if (inside) inCap++;
      if (inside && !n) gaps++;
      if (!inside && n) outside++;
      if (n > 1) overlaps++;
    }
  }
  return { inCap, gaps, outside, overlaps };
}

test("a cone around a pole gets a flat-map shape that fills its circle and nothing across the world", () => {
  const homes = [
    ["Longyearbyen", 78.22, 15.6, 10],
    ["Alert", 82.5, -62.35, 10],
    ["McMurdo", -77.85, 166.67, 10],
    ["Hammerfest, 0 deg mask", 70.66, 23.68, 0],
    ["80 N, 0 deg mask", 80, -40, 0],
  ];
  for (const [name, lat, lon, mask] of homes) {
    const home = { latitude: lat, longitude: lon };
    const radius = visibilityRadius(420, mask);
    const ring = circleRing(lat, lon, radius, 128);
    const layer = new SpaceLayer();
    layer.setCone(home, ring, ISS_M, radius);
    // The funnel for the globe is unchanged: one face per ring segment.
    assert.equal(layer._fills.get("cone").data.length, (ring.length - 1) * 12, name);
    const flat = layer._fills.get("coneFlat").data;
    assert.ok(flat.length > 0, `${name}: has a flat shape`);
    for (let t = 0; t < flat.length; t += 12) {
      const xs = [flat[t], flat[t + 4], flat[t + 8]];
      assert.ok(Math.max(...xs) - Math.min(...xs) < 0.5, `${name}: a face spans ${Math.max(...xs) - Math.min(...xs)} worlds`);
    }
    assert.ok(flat.every(Number.isFinite), name);
    const { inCap, gaps, outside, overlaps } = rasterise(flat, home, radius);
    assert.equal(overlaps, 0, `${name}: overlapping faces`);
    assert.ok(gaps / inCap < 0.003 && outside / inCap < 0.003, `${name}: gaps ${gaps}, outside ${outside} of ${inCap}`);
  }
});

test("a cone away from the poles keeps the fan on the flat map too", () => {
  for (const [lat, lon] of [[39.74, -104.99], [-36.85, 174.76], [60, 10]]) {
    const layer = new SpaceLayer();
    const radius = visibilityRadius(420, 10);
    layer.setCone({ latitude: lat, longitude: lon }, circleRing(lat, lon, radius, 128), ISS_M, radius);
    assert.equal(layer._fills.get("coneFlat").data.length, 0);
    const fan = layer._fills.get("cone").data;
    for (let t = 0; t < fan.length; t += 12) {
      const xs = [fan[t], fan[t + 4], fan[t + 8]];
      assert.ok(Math.max(...xs) - Math.min(...xs) < 0.5, `${lat}, ${lon}`);
    }
  }
});

test("the sky chart's gradient id can be chosen, for two charts in one page", () => {
  const args = { track: [], visibleStart: 0, visibleEnd: 1, formatTime: String };
  const plain = skyChartSvg(args);
  assert.match(plain, /<radialGradient id="sky"/);
  assert.match(plain, /fill="url\(#sky\)"/);
  const pop = skyChartSvg({ ...args, id: "sky-pop" });
  assert.match(pop, /<radialGradient id="sky-pop"/);
  assert.match(pop, /fill="url\(#sky-pop\)"/);
  assert.doesNotMatch(pop, /id="sky"/);
});

test("city lights: the bundled image first, then NASA's server, one image per width, retried after a failure", async () => {
  const requests = [];
  let fail = () => false;
  globalThis.Image = class {
    set src(url) {
      requests.push(url);
      this.naturalWidth = Number(/(\d+)\.jpg|WIDTH=(\d+)/.exec(url).slice(1).find(Boolean));
      setTimeout(() => (fail(url) ? this.onerror() : this.onload()));
    }
  };
  try {
    const small = await loadCityLights(2048);
    assert.ok(requests[0].endsWith("/frontend/img/black-marble-2016-2048.jpg"), requests[0]);
    assert.equal(small.naturalWidth, 2048);
    assert.equal(await loadCityLights(4096).then((img) => img.naturalWidth), 4096);
    assert.equal(loadCityLights(2048), loadCityLights(2048));
    assert.equal(requests.length, 2);

    // Without the bundled copy, NASA's map server.
    requests.length = 0;
    fail = (url) => url.includes("/img/");
    const fallback = await loadCityLights(1024);
    assert.equal(fallback.naturalWidth, 1024);
    assert.match(requests[1], /^https:\/\/gibs\.earthdata\.nasa\.gov\/.*WIDTH=1024&HEIGHT=512/);

    // Neither: null, and the next call tries again.
    requests.length = 0;
    fail = () => true;
    assert.equal(await loadCityLights(512), null);
    assert.equal(requests.length, 2);
    fail = () => false;
    assert.equal((await loadCityLights(512)).naturalWidth, 512);
    assert.equal(requests.length, 3);
  } finally {
    delete globalThis.Image;
  }
});

// -- rendering against a stand-in WebGL2 context --------------------------------

const GL = { VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, LINK_STATUS: 0x8b82, ACTIVE_UNIFORMS: 0x8b86 };
const COMPLETION_STATUS_KHR = 0x91b1;

/** Records calls; programs link (or not), and their uniforms are the ones their sources declare. */
function fakeGL({ linkOk = true, parallel = null, drawingBufferWidth = 1600 } = {}) {
  const calls = [];
  let next = 0;
  const base = {
    ...GL,
    drawingBufferWidth,
    drawingBufferHeight: 900,
    isContextLost: () => false,
    getExtension: (name) => (name === "KHR_parallel_shader_compile" ? parallel : null),
    createShader: (type) => ({ id: ++next, type, source: "" }),
    shaderSource: (shader, source) => (shader.source = source),
    createProgram: () => ({ id: ++next, shaders: [] }),
    attachShader: (program, shader) => program.shaders.push(shader),
    linkProgram: (program) => calls.push(["linkProgram", program.id]),
    getProgramParameter: (program, pname) => {
      calls.push(["getProgramParameter", pname]);
      const names = [...program.shaders.map((s) => s.source).join("\n").matchAll(/uniform\s+(?:highp\s+)?\w+\s+(\w+)/g)].map((m) => m[1]);
      if (pname === COMPLETION_STATUS_KHR) return parallel.done;
      if (pname === GL.LINK_STATUS) return linkOk;
      if (pname === GL.ACTIVE_UNIFORMS) return (program.names = [...new Set(names)]).length;
      return null;
    },
    getActiveUniform: (program, i) => ({ name: program.names[i] }),
    getUniformLocation: (program, name) => ({ name }),
    getProgramInfoLog: () => "link failed",
    getShaderInfoLog: () => "",
  };
  const gl = new Proxy(base, {
    get: (target, key) =>
      key in target ? target[key] : (...a) => {
        calls.push([key, ...a]);
        return { id: ++next };
      },
  });
  return { gl, calls };
}

function fakeMap({ lng = 0, west = -170, east = 170, cssWidth = 800 } = {}) {
  const map = {
    repaints: 0,
    getCenter: () => ({ lng }),
    getBounds: () => ({ getWest: () => west, getEast: () => east }),
    getRenderWorldCopies: () => true,
    getCanvas: () => ({ clientWidth: cssWidth }),
    triggerRepaint: () => map.repaints++,
  };
  return map;
}

const GLOBE_PRELUDE =
  "uniform mat4 u_projection_matrix;\nuniform highp vec4 u_projection_tile_mercator_coords;\nuniform highp vec4 u_projection_clipping_plane;\nuniform highp float u_projection_transition;\nuniform mat4 u_projection_fallback_matrix;";
const argsFor = (globe, transition = globe ? 1 : 0) => ({
  shaderData: globe
    ? { variantName: "globe", vertexShaderPrelude: GLOBE_PRELUDE, define: "#define GLOBE" }
    : { variantName: "mercator", vertexShaderPrelude: "uniform mat4 u_projection_matrix;", define: "#define PROJECTION_MERCATOR" },
  defaultProjectionData: {
    mainMatrix: IDENTITY,
    fallbackMatrix: IDENTITY,
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 1, -0.25],
    projectionTransition: transition,
  },
});

// SpaceLayer draws its sprites onto canvases.
const anything = () => new Proxy(function () {}, { get: () => anything(), apply: () => anything() });
globalThis.document ??= { createElement: () => ({ getContext: () => anything() }) };

function spaceState(extra = {}) {
  return {
    now: 0,
    pixelRatio: 2,
    showTrack: true,
    showCone: true,
    showFootprint: true,
    iss: { center: [0.5, 0.5, ISS_M], ahead: [0.51, 0.5, ISS_M], ground: [0.5, 0.5, 0], sunlit: true, size: 20 },
    ticks: [],
    ...extra,
  };
}

const draws = (calls) => calls.filter(([name]) => name === "drawArrays" || name === "drawElements");
const uniformValues = (calls, uniform) =>
  calls.filter(([name, loc]) => loc?.name === uniform && name.startsWith("uniform")).map(([, , ...v]) => v);

test("shaders: every compile and link starts in prerender, before any status is asked for", () => {
  const { gl, calls } = fakeGL();
  const night = new NightLayer({ getState: () => ({ visible: true, sun: [1, 0, 0], strength: 1, lightsMix: 1 }) });
  const space = new SpaceLayer();
  const map = fakeMap();
  night.onAdd(map);
  space.onAdd(map);
  const args = argsFor(true);
  night.prerender(gl, args);
  space.prerender(gl, args);
  assert.equal(calls.filter(([n]) => n === "linkProgram").length, 4);
  assert.equal(calls.filter(([n]) => n === "getProgramParameter").length, 0);
  space.setFrame(spaceState());
  night.render(gl, args);
  space.render(gl, args);
  assert.ok(draws(calls).length > 0);
  // A second frame builds nothing again.
  const links = calls.filter(([n]) => n === "linkProgram").length;
  night.prerender(gl, args);
  space.prerender(gl, args);
  assert.equal(calls.filter(([n]) => n === "linkProgram").length, links);
});

test("shaders: with parallel compiling a layer waits for the driver, without blocking, then draws", () => {
  const parallel = { COMPLETION_STATUS_KHR, done: false };
  const { gl, calls } = fakeGL({ parallel });
  const space = new SpaceLayer();
  const map = fakeMap();
  space.onAdd(map);
  space.setFrame(spaceState());
  const args = argsFor(true);
  space.prerender(gl, args);
  space.render(gl, args);
  assert.equal(draws(calls).length, 0);
  assert.equal(map.repaints, 1, "asks for another frame");
  assert.ok(!calls.some(([n, pname]) => n === "getProgramParameter" && pname === GL.LINK_STATUS), "no blocking query");
  parallel.done = true;
  space.render(gl, args);
  assert.ok(draws(calls).length > 0);
});

test("shaders: a program that fails to build is reported once and its layer is skipped, not retried", () => {
  const { gl, calls } = fakeGL({ linkOk: false });
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    const night = new NightLayer({ getState: () => ({ visible: true, sun: [1, 0, 0], strength: 1, lightsMix: 1 }) });
    const map = fakeMap();
    night.onAdd(map);
    const args = argsFor(false);
    for (let i = 0; i < 3; i++) {
      night.prerender(gl, args);
      night.render(gl, args);
    }
    assert.equal(errors.length, 1);
    assert.match(errors[0], /link failed/);
    assert.equal(draws(calls).length, 0);
    assert.equal(map.repaints, 0);
  } finally {
    console.error = original;
  }
});

test("widths and sizes follow the canvas's real pixel ratio, not the one asked for", () => {
  const { gl, calls } = fakeGL({ drawingBufferWidth: 4096 });
  const space = new SpaceLayer();
  space.onAdd(fakeMap({ cssWidth: 2560 })); // asked for 2x, clamped to 4096 px: 1.6
  space.setLine("orbit", [[0, 0, 0, 420, 1], [60, 1, 3, 420, 1]], 0);
  space.setFrame(spaceState({ pixelRatio: 2 }));
  space.render(gl, argsFor(false));
  const widths = uniformValues(calls, "u_width").map(([w]) => w);
  close(widths.at(-1), 2.4 * 1.6, 1e-9, "orbit line");
  close(uniformValues(calls, "u_size").at(-1)[0], 20 * 1.6, 1e-9, "station");
});

test("on the flat map every draw is repeated for each copy of the world in view", () => {
  const { gl, calls } = fakeGL();
  const night = new NightLayer({ getState: () => ({ visible: true, sun: [1, 0, 0], strength: 1, lightsMix: 1 }) });
  night.onAdd(fakeMap({ west: -300, east: 250 })); // copies -1, 0 and 1
  night.render(gl, argsFor(false));
  const matrices = calls.filter(([n, loc]) => n === "uniformMatrix4fv" && loc.name === "u_projection_matrix").map(([, , , m]) => m);
  assert.deepEqual(matrices.slice(1).map((m) => m[12]), [-1, 0, 1]); // M x translate(w, 0, 0)
  assert.equal(draws(calls).length, 3);
});

test("while the globe flattens, each piece goes on the copy nearest the centre", () => {
  const { gl, calls } = fakeGL();
  const night = new NightLayer({ getState: () => ({ visible: true, sun: [1, 0, 0], strength: 1, lightsMix: 1 }) });
  night.onAdd(fakeMap({ lng: 179 }));
  night.render(gl, argsFor(true, 0.5));
  // The night mesh starts half a world before the centre, on a cell boundary.
  const [offset] = uniformValues(calls, "u_offset").at(-1);
  const center = (179 + 180) / 360;
  assert.ok(offset <= center - 0.5 && offset > center - 0.5 - 1 / 96, `${offset}`);
  assert.equal(draws(calls).length, 1);

  // A line just east of the antimeridian is moved next to a centre just west of it.
  const space = new SpaceLayer();
  const s = fakeGL();
  space.onAdd(fakeMap({ lng: 179 }));
  space.setLine("orbit", [[0, 0, -179, 420, 1], [60, 1, -177, 420, 1]], 0);
  space.setFrame(spaceState({ showCone: false, showFootprint: false, iss: null }));
  space.render(s.gl, argsFor(true, 0.5));
  const firstDraw = s.calls.findIndex(([n]) => n === "drawArrays");
  const fallback = s.calls.slice(0, firstDraw).findLast(([n, loc]) => n === "uniformMatrix4fv" && loc.name === "u_projection_fallback_matrix");
  assert.equal(fallback[3][12], 1);
});

test("while the globe flattens, a cone around a pole is drawn on both sides of the meridian opposite home", () => {
  // 80 N 40 W with a 0 deg mask: the circle reaches 10 deg past the pole; the view is centred on 140 E.
  const home = { latitude: 80, longitude: -40 };
  const radius = visibilityRadius(420, 0);
  const space = new SpaceLayer();
  space.onAdd(fakeMap({ lng: 140 }));
  space.setCone(home, circleRing(80, -40, radius, 128), ISS_M, radius);
  space.setFrame(spaceState({ showTrack: false, showFootprint: false, iss: null }));
  const { gl, calls } = fakeGL();
  space.render(gl, argsFor(true, 0.5));
  // The flat half of every face drawn: moved by the fallback shift in force for its draw.
  const data = space._fills.get("coneFlat").data;
  const faces = [];
  let shift = 0;
  for (const [name, loc, ...a] of calls) {
    if (name === "uniformMatrix4fv" && loc.name === "u_projection_fallback_matrix") shift = a[1][12];
    if (name !== "drawArrays") continue;
    for (let v = a[0]; v < a[0] + a[1]; v += 3) {
      faces.push([0, 1, 2].map((k) => [data[(v + k) * 4] + shift, Math.min(1, Math.max(0, data[(v + k) * 4 + 1]))]));
    }
  }
  const inside = (x, y, [p, q, r]) => {
    const det = (q[1] - r[1]) * (p[0] - r[0]) + (r[0] - q[0]) * (p[1] - r[1]);
    if (Math.abs(det) < 1e-15) return false; // flattened onto the edge of the map
    const a = ((q[1] - r[1]) * (x - r[0]) + (r[0] - q[0]) * (y - r[1])) / det;
    const b = ((r[1] - p[1]) * (x - r[0]) + (p[0] - r[0]) * (y - r[1])) / det;
    return a >= 0 && b >= 0 && a + b <= 1;
  };
  const center = (140 + 180) / 360;
  for (const lon of [139, 139.75, 140.25, 141]) {
    const [x, y] = toMercator(83, lon);
    const near = x + Math.round(center - x);
    assert.equal(faces.filter((f) => inside(near, y, f)).length, 1, `83 N ${lon} E`);
  }
});

test("on the flat map the station's nose follows its track across the antimeridian", () => {
  const { gl, calls } = fakeGL();
  const space = new SpaceLayer();
  space.onAdd(fakeMap({ lng: 179.6 }));
  space.setFrame(spaceState({
    iss: { center: [0.9989, 0.45, ISS_M], ahead: [0.0011, 0.449, ISS_M], ground: [0.9989, 0.45, 0], sunlit: true, size: 20 },
  }));
  space.render(gl, argsFor(false));
  // The point ahead goes next to the station, not a world away to the west.
  const [x, y, z] = uniformValues(calls, "u_ahead").at(-1);
  close(x, 1.0011, 1e-9);
  assert.deepEqual([y, z], [0.449, ISS_M]);
});

test("the footprint is drawn only when it is switched on", () => {
  const space = new SpaceLayer();
  space.onAdd(fakeMap());
  space.setRing("footprint", circleRing(10, 60, 20), 0);
  const count = (showFootprint) => {
    const { gl, calls } = fakeGL();
    space.setFrame(spaceState({ showFootprint, showTrack: false, showCone: false, iss: null }));
    space.render(gl, argsFor(false));
    return draws(calls).length;
  };
  assert.equal(count(false), 0);
  assert.equal(count(true), 1);
});

test("city lights are decoded off the main thread, uploaded once and the old texture freed", async () => {
  const closed = [];
  globalThis.createImageBitmap = async (img, options) => {
    assert.deepEqual(options, { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "none" });
    return { from: img, close: () => closed.push(img) };
  };
  try {
    const { gl, calls } = fakeGL();
    const night = new NightLayer({ getState: () => ({ visible: true, sun: [1, 0, 0], strength: 1, lightsMix: 1 }) });
    const map = fakeMap();
    night.onAdd(map);
    const args = argsFor(false);
    night.setLights("first");
    await new Promise((r) => setTimeout(r));
    assert.equal(map.repaints, 1);
    night.render(gl, args);
    night.render(gl, args);
    const uploads = () => calls.filter(([n]) => n === "texImage2D").map((c) => c[6].from);
    assert.deepEqual(uploads(), ["first"]);
    assert.deepEqual(closed, ["first"]);
    night.setLights("second");
    await new Promise((r) => setTimeout(r));
    night.render(gl, args);
    assert.deepEqual(uploads(), ["first", "second"]);
    assert.equal(calls.filter(([n]) => n === "deleteTexture").length, 1);
    assert.deepEqual(closed, ["first", "second"]);
  } finally {
    delete globalThis.createImageBitmap;
  }
});

/** createImageBitmap that resolves when finish() is called; closed bitmaps are recorded. */
function heldDecode() {
  const held = { closed: [] };
  globalThis.createImageBitmap = (img) =>
    new Promise((resolve) => (held.finish = () => resolve({ from: img, close: () => held.closed.push(img) })));
  return held;
}

test("city lights released while still decoding are closed when the decode lands, not kept", async () => {
  const held = heldDecode();
  try {
    const night = new NightLayer({ getState: () => ({ visible: true, sun: [1, 0, 0], strength: 1, lightsMix: 1 }) });
    night.setLights("decoding");
    night.releaseLights();
    held.finish();
    await new Promise((r) => setTimeout(r));
    assert.deepEqual(held.closed, ["decoding"]);
    assert.equal(night._pendingLights, null);
  } finally {
    delete globalThis.createImageBitmap;
  }
});

test("city lights released while waiting for a frame are closed at once", async () => {
  const held = heldDecode();
  try {
    const night = new NightLayer({ getState: () => ({ visible: true, sun: [1, 0, 0], strength: 1, lightsMix: 1 }) });
    night.setLights("waiting");
    held.finish();
    await new Promise((r) => setTimeout(r));
    assert.ok(night._pendingLights);
    night.releaseLights();
    assert.deepEqual(held.closed, ["waiting"]);
    assert.equal(night._pendingLights, null);
  } finally {
    delete globalThis.createImageBitmap;
  }
});
