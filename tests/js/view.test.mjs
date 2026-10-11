// Tests for the globe view's scheduling and state handling, with the real
// IssGlobeView driven by fake timers: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import { frameDelay, numberLocale, previewTimeline, uses12Hour } from "../../custom_components/iss_tracker/frontend/iss-geo.js";

const { IssGlobeView } = await import("../../custom_components/iss_tracker/frontend/iss-globe.js");

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
