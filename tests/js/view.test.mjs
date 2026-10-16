// Tests for the globe view's scheduling and state handling, with the real
// IssGlobeView driven by fake timers: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { frameDelay, numberLocale, previewTimeline, uses12Hour } from "../../custom_components/iss_tracker/frontend/iss-geo.js";

const { IssGlobeView } = await import("../../custom_components/iss_tracker/frontend/iss-globe.js");
const { Strings } = await import("../../custom_components/iss_tracker/frontend/iss-i18n.js");
const GERMAN = JSON.parse(readFileSync(new URL("../../custom_components/iss_tracker/frontend/translations/de.json", import.meta.url), "utf8"));

// ---- a fake clock with HTML-spec animation frames ---------------------------

function installClock(startMs) {
  const clock = { now: startMs, rafs: new Map(), timeouts: new Map(), seq: 0 };
  const saved = {
    dateNow: Date.now,
    performance: globalThis.performance,
    raf: globalThis.requestAnimationFrame,
    caf: globalThis.cancelAnimationFrame,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    document: globalThis.document,
  };
  Date.now = () => clock.now;
  Object.defineProperty(globalThis, "performance", { value: { now: () => clock.now - startMs }, configurable: true, writable: true });
  globalThis.requestAnimationFrame = (cb) => {
    const id = ++clock.seq;
    clock.rafs.set(id, cb);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => clock.rafs.delete(id);
  globalThis.setTimeout = (fn, ms = 0) => {
    const id = ++clock.seq;
    clock.timeouts.set(id, { fn, at: clock.now + ms });
    return id;
  };
  globalThis.clearTimeout = (id) => clock.timeouts.delete(id);
  const listeners = new Map();
  globalThis.document = {
    hidden: false,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
  };
  clock.listeners = listeners;
  /** Advance by one display frame: run that frame's callbacks, then due timeouts. */
  clock.step = (ms = 16) => {
    clock.now += ms;
    for (const [id, cb] of [...clock.rafs]) {
      if (!clock.rafs.has(id)) continue;
      clock.rafs.delete(id); // A running callback's handle is already gone, as in browsers.
      cb(clock.now);
    }
    for (const [id, t] of [...clock.timeouts]) {
      if (t.at <= clock.now && clock.timeouts.has(id)) {
        clock.timeouts.delete(id);
        t.fn();
      }
    }
  };
  clock.restore = () => {
    Date.now = saved.dateNow;
    Object.defineProperty(globalThis, "performance", { value: saved.performance, configurable: true, writable: true });
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.cancelAnimationFrame = saved.caf;
    globalThis.setTimeout = saved.setTimeout;
    globalThis.clearTimeout = saved.clearTimeout;
    globalThis.document = saved.document;
  };
  return clock;
}

const T0 = Date.parse("2026-10-10T22:00:00Z") / 1000;

/** Synthetic ground track rows [t, lat, lon, alt_km, sunlit]. */
function rows(start, end, step) {
  const out = [];
  for (let t = start; t <= end; t += step) {
    const phase = ((t - T0) / 5560) * 2 * Math.PI;
    out.push([t, 51.6 * Math.sin(phase), ((((t - T0) / 5560) * 360 - 71 + 540) % 360) - 180, 420, 1]);
  }
  return out;
}

function stubView(clock) {
  const view = new IssGlobeView();
  view.hasAttribute = () => false; // No DOM in node.
  const calls = { frame: 0, render: 0, flyTo: [] };
  view._map = {
    getZoom: () => 2,
    getPixelRatio: () => 1,
    isMoving: () => false,
    jumpTo() {},
    easeTo() {},
    flyTo(opts) {
      calls.flyTo.push(opts);
    },
    setLight() {},
    getCenter: () => ({ lng: -71, lat: 42 }),
    getPitch: () => 0,
    getBearing: () => 0,
    triggerRepaint() {
      calls.render++;
    },
  };
  view._space = { setFrame() {}, setLine() {}, setCone() {}, setRing() {}, project: () => null };
  const el = () => ({ hidden: false, disabled: false, style: {}, classList: { add() {}, remove() {}, toggle() {} }, focus() {} });
  view._els = { pvFill: el(), previewBar: el(), mission: el(), previewBtn: el(), lookBtn: el(), liveBtn: el() };
  view._loaded = true;
  view._mapSize = [800, 600];
  view._payload = {
    location: { entry_id: "a", title: "Home", latitude: 42.36, longitude: -71.06, elevation: 10 },
    settings: { min_elevation: 10, forecast_days: 10, max_sun_elevation: -6, min_peak_elevation: 20, min_visible_duration: 60 },
    track: rows(T0 - 600, T0 + 6 * 3600, 30),
    next_visible_pass: null,
    upcoming_visible_passes: [],
    next_pass: null,
  };
  view._baseT = view._payload.track[0][0];
  // DOM-only rendering, not part of the scheduling under test.
  view._buildCourse = () => {};
  view._renderSky = () => {};
  view._tick = () => {};
  const frame = view._frame.bind(view);
  view._frame = () => {
    calls.frame++;
    frame();
  };
  return { view, calls };
}

// ---- pure helpers -------------------------------------------------------------

test("reduced-motion preview starts at the lead-in instead of sweeping there", () => {
  const start = 1000;
  const passStart = start + 6 * 3600;
  const tl = previewTimeline(start, passStart, passStart + 360, { skipApproach: true });
  const first = tl.at(0);
  assert.equal(first.phase, "pass");
  assert.equal(first.sim, passStart - 240);
  // Without the option the preview sweeps from the start.
  assert.equal(previewTimeline(start, passStart, passStart + 360).at(0).phase, "approach");
});

test("redraw cadence follows the station's speed on screen", () => {
  assert.equal(frameDelay(0), 1000); // off screen: once a second
  assert.equal(frameDelay(0.4), 1000); // globe zoom: under half a pixel a second
  assert.equal(frameDelay(1), 500);
  assert.equal(frameDelay(1.2), 500 / 1.2);
  assert.equal(frameDelay(5), 350); // under 2 px a step
  assert.equal(frameDelay(6), 0); // fast enough to animate every frame
  assert.equal(frameDelay(0.55, { chase: true }), 500 / 1.375); // the usual chase view
  assert.equal(frameDelay(1, { chase: true }), 350);
  assert.equal(frameDelay(0, { preview: true }), 0);
  // Never between one display frame and 350 ms (MapLibre's label fade).
  for (let speed = 0; speed < 100; speed += 0.05) {
    const d = frameDelay(speed);
    assert.ok(d === 0 || (d >= 350 && d <= 1000), `${speed} px/s -> ${d} ms`);
  }
});

test("clock and number formats follow Home Assistant's settings", () => {
  assert.equal(uses12Hour({ language: "en", time_format: "24" }), false);
  assert.equal(uses12Hour({ language: "de", time_format: "12" }), true);
  assert.equal(uses12Hour({ language: "en-US", time_format: "language" }), true);
  assert.equal(uses12Hour({ language: "de", time_format: "language" }), false);
  assert.deepEqual(numberLocale({ language: "en", number_format: "decimal_comma" }), [["de", "es", "it"], {}]);
  assert.deepEqual(numberLocale({ language: "fr", number_format: "language" }), ["fr", {}]);
  assert.deepEqual(numberLocale({ language: "en", number_format: "none" })[1], { useGrouping: false });
  const [locales, extra] = numberLocale({ language: "en", number_format: "decimal_comma" });
  assert.equal(new Intl.NumberFormat(locales, { ...extra, minimumFractionDigits: 1 }).format(1234.5), "1.234,5");
});

test("distances and speeds follow the Units option, else Home Assistant's unit system", () => {
  const view = new IssGlobeView();
  const show = (units, length) => {
    view._hass = { config: { unit_system: { length } }, locale: { language: "en", number_format: "language" } };
    view._payload = { settings: { units } };
    return [view._distance(400), view._speed(27600)];
  };
  const metric = ["400 km", "27,600 km/h"];
  const imperial = ["249 mi", "17,150 mph"];
  assert.deepEqual(show("auto", "km"), metric);
  assert.deepEqual(show("auto", "mi"), imperial);
  assert.deepEqual(show(undefined, "mi"), imperial);
  assert.deepEqual(show("metric", "mi"), metric);
  assert.deepEqual(show("imperial", "km"), imperial);
});

// ---- the view -------------------------------------------------------------------

test("a preview that ends by itself leaves no animation-frame loop behind", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view, calls } = stubView(clock);
    const passStart = T0 + 3600;
    const passEnd = passStart + 360;
    view._preview = {
      path: rows(T0, passEnd + 150, 30),
      pass: { start: new Date(passStart * 1000).toISOString(), end: new Date(passEnd * 1000).toISOString(), path: rows(passStart, passEnd, 5) },
      timeline: previewTimeline(T0, passStart, passEnd),
      began: performance.now(),
      phase: null,
      modeBefore: "free",
      viewBefore: { center: [-71, 42], zoom: 1.65, pitch: 0, bearing: 0 },
    };
    view._running = true;
    view._scheduleFrames();
    assert.ok(view._raf, "a preview animates every frame");
    for (let i = 0; i < 5000 && view._preview; i++) clock.step();
    assert.equal(view._preview, null, "the preview finished");
    assert.equal(view._raf, null, "no animation frame is pending");
    assert.equal(clock.rafs.size, 0);
    assert.ok(view._frameTimer, "frames continue on a timer");
    // Back to the idle cadence: about one redraw a second, not one per display frame.
    const before = calls.frame;
    for (let i = 0; i < 125; i++) clock.step(); // 2 s
    assert.ok(calls.frame - before <= 3, `${calls.frame - before} frames in 2 s`);
    view._pause();
  } finally {
    clock.restore();
  }
});

test("the page visibility listener is removed when the view leaves the page", () => {
  const clock = installClock(T0 * 1000);
  try {
    const view = new IssGlobeView();
    const count = () => clock.listeners.get("visibilitychange")?.size ?? 0;
    view.connectedCallback();
    assert.equal(count(), 1);
    view.disconnectedCallback();
    assert.equal(count(), 0, "a detached view must not stay reachable from the document");
    view.connectedCallback();
    view.connectedCallback();
    assert.equal(count(), 1);
    view.disconnectedCallback();
  } finally {
    clock.restore();
  }
});

test("switching location moves the home marker and drops the old approach", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    delete view._buildCourse; // use the real one
    const lines = {};
    view._space.setLine = (name, r) => (lines[name] = r);
    const marker = { ll: null, el: { title: "" }, setLngLat(ll) { this.ll = ll; }, getElement() { return this.el; } };
    view._homeMarker = marker;
    view._makePins = () => {};
    view._approach = rows(T0, T0 + 600, 30);
    view._approachFor = "x";
    view._locationChanged();
    assert.deepEqual(view._approach, []);
    assert.deepEqual(lines.approach, []);
    view._payload = { ...view._payload, location: { entry_id: "b", title: "Cabin", latitude: 39.74, longitude: -104.99, elevation: 1600 } };
    view._buildCourse();
    assert.deepEqual(marker.ll, [-104.99, 39.74]);
    assert.equal(marker.el.title, "Cabin");
  } finally {
    clock.restore();
  }
});

test("an approach that fails to load is asked for again with the next refresh", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    const lines = {};
    view._space.setLine = (name, r) => (lines[name] = r);
    view._payload = { ...view._payload, next_pass: { rise: new Date((T0 + 1800) * 1000).toISOString() } };
    let calls = 0;
    view._path = async () => {
      if (++calls === 1) throw { code: "not_ready", message: "Starting up" };
      return rows(T0, T0 + 1800, 30);
    };
    await view._loadApproach();
    assert.deepEqual(lines.approach, []);
    await view._loadApproach();
    assert.equal(calls, 2);
    assert.equal(lines.approach.length, 61);
    await view._loadApproach();
    assert.equal(calls, 2, "a loaded approach is not asked for again");
  } finally {
    clock.restore();
  }
});

test("a new location's retries start quickly, however far the last one's backed off", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    for (let i = 0; i < 10; i++) view._retryRefresh();
    assert.equal(view._refreshDelay, 5 * 60 * 1000);
    view._locationChanged();
    assert.equal(clock.timeouts.size, 0, "the old location's retry is cancelled");
    view._retryRefresh();
    assert.equal(view._refreshDelay, 3000);
  } finally {
    clock.restore();
  }
});

test("the passes after one that is over are asked for once, however late the tick", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    view._running = true;
    let refreshes = 0;
    view._refresh = () => refreshes++;
    const iso = (t) => new Date(t * 1000).toISOString();
    view._payload = {
      ...view._payload,
      upcoming_visible_passes: [{ start: iso(T0 - 300), end: iso(T0 + 10) }],
      next_pass: { rise: iso(T0 - 400), set: iso(T0 + 60) },
    };
    view._refreshAfterPass(clock.now);
    clock.step(5000);
    assert.equal(refreshes, 0, "not while the pass is on");
    // The first tick after the end comes late (a busy page, a timer that slipped).
    clock.now = (T0 + 15) * 1000;
    view._refreshAfterPass(clock.now);
    view._refreshAfterPass(clock.now + 1000);
    clock.step(2000);
    assert.equal(refreshes, 1);
    // A pass over home that is not visible gets one too; none while the view
    // is away, and one when it is back.
    view._payload = { ...view._payload, upcoming_visible_passes: [] };
    clock.now = (T0 + 70) * 1000;
    view._refreshAfterPass(clock.now);
    view._pause();
    clock.step(5000);
    assert.equal(refreshes, 1);
    view._running = true;
    view._refreshAfterPass(clock.now);
    clock.step(2000);
    assert.equal(refreshes, 2);
    // Another refresh brings the next passes before this request goes out: none.
    view._pause();
    view._running = true;
    view._refreshAfterPass(clock.now);
    view._payload = { ...view._payload, next_pass: { rise: iso(T0 + 5400), set: iso(T0 + 5900) } };
    clock.step(2000);
    assert.equal(refreshes, 2);
  } finally {
    clock.restore();
  }
});

test("a globe does not open on another location's data while the one asked for cannot be fetched", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    Object.defineProperty(view, "isConnected", { value: true });
    view._map = null;
    view._loaded = false;
    view._els = null;
    view._buildDom = () => {};
    view._refreshMapToken = async () => {};
    let maps = 0;
    view._createMap = () => maps++;
    const messages = [];
    view._showMessage = (text) => messages.push(text);
    const error = { code: "not_ready", message: "Starting up" };
    view._hass = {
      callWS: async () => {
        throw error;
      },
    };
    // The data is still the last location's ("a"); this globe now shows "b".
    view._config = { entry_id: "b" };
    await view._start();
    assert.equal(maps, 0);
    assert.equal(messages.at(-1), view._errorText(error), "says why, and the message stays");
    assert.deepEqual([...clock.timeouts.values()].map((t) => t.at - clock.now), [30000], "one retry: the start's own");
  } finally {
    clock.restore();
  }
});

test("a WebGL context that stays lost gets a new map, and one that comes back gets just one", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    Object.defineProperty(view, "isConnected", { value: true });
    let starts = 0;
    view._start = () => starts++;
    view._teardown = () => (view._map = null);
    const messages = [];
    view._showMessage = (text) => messages.push(text);
    const newMap = () => {
      const canvas = { on: {}, addEventListener: (type, fn) => (canvas.on[type] = fn) };
      const map = { getCanvas: () => canvas, canvas };
      view._map = map;
      view._watchContext(map);
      return map;
    };
    const lost = newMap();
    lost.canvas.on.webglcontextlost();
    assert.equal(messages.at(-1), view._t("globe.reloading"));
    clock.step(4000);
    assert.equal(starts, 0, "the browser gets the chance to restore it");
    clock.step(1000);
    assert.equal(starts, 1);
    const back = newMap();
    back.canvas.on.webglcontextlost();
    clock.step(1000);
    back.canvas.on.webglcontextrestored();
    assert.equal(starts, 2);
    clock.step(5000);
    assert.equal(starts, 2);
  } finally {
    clock.restore();
  }
});

test("the sky chart is drawn when it can be seen, and then only its live dot moves", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    delete view._renderSky; // use the real one
    const el = () => ({
      hidden: false,
      textContent: "",
      attrs: {},
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
      removeAttribute(name) {
        delete this.attrs[name];
      },
    });
    const chart = () => {
      const c = {
        draws: 0,
        dot: null,
        set innerHTML(svg) {
          c.draws++;
          c.dot = el();
        },
        querySelector: (sel) => (sel === ".live-dot" ? c.dot : null),
      };
      return c;
    };
    const panel = () => {
      const parts = { ".sub": el(), ".chart": chart(), ".caption": el() };
      return { ...el(), parts, querySelector: (sel) => parts[sel] };
    };
    view._els = { ...view._els, skyPop: panel(), skySide: panel(), lookBtn: el() };
    const iso = (t) => new Date(t * 1000).toISOString();
    const pass = {
      start: iso(T0 + 60), peak: iso(T0 + 180), end: iso(T0 + 300),
      start_azimuth: 225, start_elevation: 10, start_direction: "SW",
      peak_azimuth: 150, peak_elevation: 60, peak_direction: "SSE",
      end_azimuth: 60, end_elevation: 10, end_direction: "ENE",
      disappears_into_shadow: false, confidence: "high", path: rows(T0, T0 + 360, 10),
    };
    view._payload = { ...view._payload, upcoming_visible_passes: [pass], next_visible_pass: pass };
    const pop = view._els.skyPop.parts[".chart"];
    view._renderSky(true);
    assert.equal(pop.draws, 0, "not while it is closed");
    view._skyOpen = true;
    view._renderSky(false);
    assert.equal(pop.draws, 1);
    assert.equal(pop.dot.attrs.display, "none", "the station is not up yet");
    // During the pass each tick moves the dot, and draws nothing else.
    clock.now = (T0 + 120) * 1000;
    view._position = { lat: 42.36, lon: -71.06, alt: 420 };
    view._renderSky(false);
    const overhead = pop.dot.attrs.transform;
    clock.now += 1000;
    view._position = { lat: 42.6, lon: -70.8, alt: 420 };
    view._renderSky(false);
    assert.equal(pop.draws, 1);
    assert.equal(pop.dot.attrs.display, undefined);
    assert.match(pop.dot.attrs.transform, /^translate\(/);
    assert.notEqual(pop.dot.attrs.transform, overhead);
  } finally {
    clock.restore();
  }
});

test("with the station out of sight the globe is redrawn now and then, and at once when its course changes", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view, calls } = stubView(clock);
    view._frameDelay(); // project() places it nowhere on screen: out of sight
    for (let i = 0; i < 10; i++) {
      view._frame();
      clock.now += 1000;
    }
    assert.equal(calls.render, 2, "every five seconds, not every second");
    delete view._buildCourse; // use the real one
    view._homeMarker = { el: {}, setLngLat() {}, getElement() { return this.el; } };
    view._makePins = () => {};
    view._buildCourse();
    view._frame();
    assert.equal(calls.render, 3);
    // In sight, every frame.
    view._space.project = (lat, lon) => ({ x: lon * 50, y: lat * 50 });
    view._frameDelay();
    view._frame();
    view._frame();
    assert.equal(calls.render, 5);
  } finally {
    clock.restore();
  }
});

test("nothing the view keeps hides one of its own methods", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    view._frameDelay();
    view._frame();
    const proto = IssGlobeView.prototype;
    const methods = Object.getOwnPropertyNames(proto).filter((name) => typeof Object.getOwnPropertyDescriptor(proto, name).value === "function");
    // The test's stubs are functions; state that took a method's name is not.
    assert.deepEqual(Object.keys(view).filter((key) => methods.includes(key) && typeof view[key] !== "function"), []);
  } finally {
    clock.restore();
  }
});

test("retries wait while the globe cannot be seen, and go as soon as it can", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    Object.defineProperty(view, "isConnected", { value: true });
    view._running = true; // only the retries are under test
    let refreshes = 0;
    view._refresh = () => refreshes++;
    document.hidden = true;
    view._retryRefresh();
    clock.step(3000);
    clock.step(60000);
    assert.equal(refreshes, 0, "not for a hidden tab");
    document.hidden = false;
    view._onVisibility();
    assert.equal(refreshes, 1);
    // Likewise for a card scrolled out of view.
    view._onScreen = false;
    view._retryRefresh();
    clock.step(6000);
    assert.equal(refreshes, 1);
    view._onScreen = true;
    view._resume();
    assert.equal(refreshes, 2);
  } finally {
    clock.restore();
  }
});

test("back on the page after a location switch failed, the new location is asked for at once", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    Object.defineProperty(view, "isConnected", { value: true });
    let refreshes = 0;
    view._refresh = () => refreshes++;
    view._refreshMapToken = () => {};
    view._map.resize = () => {};
    view._els.map = { clientWidth: 800, clientHeight: 600 };
    // Fresh data, but the last location's.
    view._payloadAt = performance.now();
    view._config = { entry_id: "b" };
    view._resume();
    view._pause();
    assert.equal(refreshes, 1);
  } finally {
    clock.restore();
  }
});

test("a drawing bug is not shown as a failed request, and the new data stays in", async () => {
  const clock = installClock(T0 * 1000);
  const saved = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    const { view } = stubView(clock);
    const messages = [];
    view._showMessage = (text) => messages.push(text);
    view._renderUpcoming = () => {};
    view._buildCourse = () => {
      throw new TypeError("pins is undefined");
    };
    const fresh = { ...view._payload, generated_at: "now" };
    view._hass = { callWS: async () => fresh };
    assert.equal(await view._refresh(), true);
    assert.equal(view._payload, fresh);
    assert.ok(!messages.some((m) => /pins is undefined/.test(m)), messages.join(" | "));
    assert.equal(errors.length, 1);
  } finally {
    console.error = saved;
    clock.restore();
  }
});

test("a language that fails to apply does not hold up the globe", async () => {
  const saved = { fetch: globalThis.fetch, error: console.error };
  const errors = [];
  console.error = (...args) => errors.push(args);
  globalThis.fetch = async () => ({ ok: true, json: async () => GERMAN });
  try {
    const view = new IssGlobeView();
    view._applyStrings = () => {
      throw new TypeError("no labels yet");
    };
    await view._useLanguage({ language: "de" }); // what starting the globe waits on
    assert.equal(errors.length, 1);
  } finally {
    globalThis.fetch = saved.fetch;
    console.error = saved.error;
  }
});

test("a clock about two seconds off is corrected steadily, not on and off", () => {
  const view = new IssGlobeView();
  // The server's clock, ahead of the device's by this much (round trip 100 ms).
  const ahead = (ms) => view._syncClock(2000 + ms / 1000, 1_999_950, 2_000_050);
  ahead(2500);
  assert.equal(view._clockOffset, 2500);
  ahead(1500); // the same clock, measured a little differently
  assert.equal(view._clockOffset, 1500);
  ahead(500);
  assert.equal(view._clockOffset, 0, "set right meanwhile");
  ahead(1500);
  assert.equal(view._clockOffset, 0, "a clock that agrees is not corrected for noise");
});

test("a device clock that is off is corrected from the server's time", () => {
  const view = new IssGlobeView();
  view._syncClock(1000, 2_000_000, 2_000_100); // 1000 s server time vs 2000 s device time
  assert.equal(view._clockOffset, 1_000_000 - 2_000_050);
  view._syncClock(2000.5, 2_000_000, 2_000_100); // half a second: left alone
  assert.equal(view._clockOffset, 0);
  view._syncClock(1000, 2_000_000, 2_005_000); // too slow a round trip to trust
  assert.equal(view._clockOffset, 0);
});

test("refreshes for a track that ran out back off while they fail", () => {
  const clock = installClock(T0 * 1000);
  try {
    const view = new IssGlobeView();
    let calls = 0;
    view._refresh = () => calls++;
    view._refreshStale();
    view._refreshStale();
    assert.equal(calls, 1, "one request, not one per frame");
    clock.now += 3000;
    view._refreshStale();
    assert.equal(calls, 2);
    clock.now += 3000;
    view._refreshStale();
    assert.equal(calls, 2, "the wait doubles");
    clock.now += 3000;
    view._refreshStale();
    assert.equal(calls, 3);
  } finally {
    clock.restore();
  }
});

test("passes over home say why they can or cannot be seen", () => {
  const view = new IssGlobeView();
  view._payload = { settings: { min_peak_elevation: 20, min_visible_duration: 60, max_sun_elevation: -6 }, location: { latitude: 42, longitude: -71 } };
  // Climbs to 67.6° in Earth's shadow; visible only after it leaves it, up to 15°.
  const pass = (reason, extra = {}) => ({ reason, culmination_elevation: 67.6, visible_peak_elevation: 15.0, ...extra });
  assert.equal(view._passVisibility(pass("visible")).visible, true);
  assert.equal(view._passVisibility(pass("low")).short, "visible only up to 15°");
  assert.doesNotMatch(view._passVisibility(pass("low")).short, /68/);
  assert.match(view._passVisibility(pass("low")).long, /below your 20° minimum/);
  assert.equal(view._passVisibility(pass("low", { visible_peak_elevation: 19.96 })).short, "visible only up to 19°");
  assert.equal(view._passVisibility(pass("low", { visible_peak_elevation: undefined })).short, "visible, but low");
  assert.equal(view._passVisibility(pass("shadow")).visible, false);
  assert.match(view._passVisibility(pass("twilight")).long, /-6°/);
  assert.equal(view._passVisibility(pass("daylight")).short, "daylight");
});

test("the view speaks Home Assistant's language once its text has loaded", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /translations\/de\.json$/);
    return { ok: true, json: async () => GERMAN };
  };
  try {
    const view = new IssGlobeView();
    assert.equal(view._errorText(3), "Lost the connection to Home Assistant. Reconnecting…");
    view.hass = { language: "de", locale: { language: "de", number_format: "language" } };
    await view._languageReady;
    assert.equal(view._strings.language, "de");
    assert.equal(view._errorText(3), "Verbindung zu Home Assistant verloren. Verbindung wird wiederhergestellt…");
    assert.equal(view._errorText({ code: "not_ready", message: "Starting up" }), "Warte auf ISS-Bahndaten… (Starting up)");
    view._payload = {
      settings: { min_peak_elevation: 20, min_visible_duration: 60, max_sun_elevation: -4.5 },
      location: { latitude: 42, longitude: -71 },
    };
    assert.equal(view._passVisibility({ reason: "low", visible_peak_elevation: 15.2 }).short, "nur bis 15° sichtbar");
    assert.match(view._passVisibility({ reason: "twilight" }).long, /höher als -4,5°/);
    const pass = { start_direction: "SE", end_direction: "ENE", peak_elevation: 67.4, duration_seconds: 372, magnitude: -3.42 };
    assert.equal(view._passSummary(pass, true), "SO → ONO · bis 67° · 6 Min. · Helligkeit -3,4");
    assert.equal(view._confidence("medium"), "mittlere Zuverlässigkeit");
    assert.equal(view._pausedReason({ paused: "x", paused_days: 16, paused_error: "celestrak: HTTP 503" }), "Die Bahndaten sind 16 Tage alt (celestrak: HTTP 503)");
    assert.equal(view._pausedReason({ paused: "Could not propagate ISS orbit: x", paused_days: null }), "Could not propagate ISS orbit: x");
    assert.deepEqual(view._placeNames(), ["coalesce", ["get", "name_de"], ["get", "name_en"], ["get", "name"]]);
    // The same language again downloads nothing.
    globalThis.fetch = () => assert.fail("downloaded again");
    view.hass = { language: "de", locale: view._hass.locale };
    await view._languageReady;
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("errors read as sentences, whatever shape the websocket gives them", () => {
  const view = new IssGlobeView();
  assert.match(view._errorText(3), /Lost the connection/);
  assert.match(view._errorText({ code: 3, message: "Connection lost" }), /Lost the connection/);
  assert.match(view._errorText({ error: { code: "not_found", message: "x" } }), /Set up the ISS Tracker/);
  assert.match(view._errorText({ code: "location_disabled", message: "x" }), /disabled/);
  assert.equal(view._errorText({ code: "not_ready", message: "Waiting for ISS orbital elements" }), "Waiting for ISS orbit data…");
  assert.equal(view._errorText({ code: "not_ready", message: "No ISS orbital elements: x" }), "Waiting for ISS orbit data… (No ISS orbital elements: x)");
  assert.doesNotMatch(view._errorText({ error: { foo: 1 } }), /object Object/);
  assert.equal(view._errorMessage({ code: "home_assistant_error", message: "Not ready" }), "Not ready");
});

test("a location switch that fails at first says so, then flies to the new home", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view, calls } = stubView(clock);
    Object.defineProperty(view, "isConnected", { value: true });
    const messages = [];
    view._showMessage = (text) => messages.push(text);
    view._renderUpcoming = () => {};
    view._padding = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
    const cabin = { ...view._payload, location: { entry_id: "b", title: "Cabin", latitude: 39.74, longitude: -104.99, elevation: 1600 } };
    let fail = true;
    view._hass = {
      callWS: async () => {
        if (fail) {
          fail = false;
          throw { code: 3, message: "Connection lost" };
        }
        return cabin;
      },
    };
    view._config = { entry_id: "a" };
    view.config = { entry_id: "b" };
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    await flush();
    assert.match(messages.at(-1), /Lost the connection/, "the old location is not shown as if nothing happened");
    assert.equal(calls.flyTo.length, 0);
    clock.step(3000); // the retry
    await flush();
    assert.equal(view._payload.location.entry_id, "b");
    assert.deepEqual(calls.flyTo.at(-1).center, [-104.99, 39.74]);
  } finally {
    clock.restore();
  }
});

test("a deleted location says so at once and tells the host, without retrying", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    Object.defineProperty(view, "isConnected", { value: true });
    const messages = [];
    const events = [];
    view._showMessage = (text) => messages.push(text);
    view.dispatchEvent = (ev) => events.push([ev.type, ev.detail]);
    view._config = { entry_id: "a" };
    let error = { code: "unknown_location", message: "This ISS Tracker location no longer exists" };
    view._hass = {
      callWS: async () => {
        throw error;
      },
    };
    // The cached track still covers the present, but the location is gone for good.
    await view._refresh();
    assert.match(messages.at(-1), /Edit the card/);
    assert.deepEqual(events, [["location-gone", "a"]]);
    assert.equal(clock.timeouts.size, 0, "nothing to retry");
    view._config = { entry_id: "a", panel: true };
    await view._refresh();
    assert.equal(messages.at(-1), "This location no longer exists. Choose another one.");
    // Passing trouble still keeps the cached track on screen, quietly.
    messages.length = events.length = 0;
    error = { code: "not_ready", message: "Starting up" };
    await view._refresh();
    assert.deepEqual(messages, []);
    assert.deepEqual(events, []);
    // Without anything to show, a deleted location waits for a new one.
    view._payload = null;
    view._map = null;
    view._els = null;
    view._buildDom = () => {};
    error = { code: "unknown_location", message: "gone" };
    globalThis.CustomEvent ??= class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    };
    await view._start();
    assert.ok(![...clock.timeouts.values()].some((t) => t.at - clock.now === 30000), "no 30 s retry");
  } finally {
    clock.restore();
  }
});

test("editor previews get a short grace, cards the editor dropped none", () => {
  const clock = installClock(T0 * 1000);
  try {
    const make = (cardParent) => {
      const view = new IssGlobeView();
      view.editorPreview = true;
      view.getRootNode = () => ({ host: { parentNode: cardParent } });
      let connected = false;
      Object.defineProperty(view, "isConnected", { get: () => connected });
      view.teardowns = 0;
      view._teardown = () => view.teardowns++;
      view._start = () => {};
      view.attach = () => {
        connected = true;
        view.connectedCallback();
      };
      view.detach = () => {
        connected = false;
        view.disconnectedCallback();
      };
      return view;
    };
    // A masonry view in edit mode takes its columns apart and puts the cards back a few frames later.
    const moved = make({});
    moved.attach();
    moved.detach();
    for (let i = 0; i < 6; i++) clock.step();
    moved.attach();
    clock.step(3000);
    assert.equal(moved.teardowns, 0, "a card put back soon keeps its globe");
    moved.detach();
    clock.step(2000);
    assert.equal(moved.teardowns, 1, "a preview that stays away goes after 2 s");
    // The editor rebuilt its preview: the old card is out of the page for good.
    const dropped = make(null);
    dropped.attach();
    dropped.detach();
    clock.step();
    assert.equal(dropped.teardowns, 1);
    // Outside the editor, views wait 30 s.
    const card = make({});
    card.editorPreview = false;
    card.attach();
    card.detach();
    clock.step(29000);
    assert.equal(card.teardowns, 0);
    clock.step(1000);
    assert.equal(card.teardowns, 1);
  } finally {
    clock.restore();
  }
});

test("tearing the map down frees the city lights first", () => {
  const clock = installClock(T0 * 1000);
  try {
    const view = new IssGlobeView();
    const order = [];
    view.removeAttribute = () => {};
    view._night = { releaseLights: () => order.push("lights") };
    view._map = { remove: () => order.push("map") };
    view._teardown();
    assert.deepEqual(order, ["lights", "map"]);
    assert.equal(view._night, null);
    assert.equal(view._map, null);
  } finally {
    clock.restore();
  }
});
