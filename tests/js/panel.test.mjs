// Tests for the sidebar panel's location picker and sidebar handling, with
// just enough DOM to run it in node: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.hidden = false;
    this.children = [];
    this.listeners = {};
    this.textContent = "";
    this._value = "";
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  // As a <select>: only one of its options can be chosen.
  set value(value) {
    this._value = this.tagName !== "select" || this.children.some((o) => o.value === value) ? value : "";
  }
  get value() {
    return this._value;
  }
}

const definitions = {};
globalThis.HTMLElement = class {
  constructor() {
    this.isConnected = true;
    this.attributes = new Set();
  }
  attachShadow() {
    const els = { "button.menu": new FakeElement("button"), "select.location": new FakeElement("select"), main: new FakeElement("main") };
    this.shadowRoot = { set innerHTML(_) {}, querySelector: (sel) => els[sel] };
    return this.shadowRoot;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  toggleAttribute(name, force) {
    if (force) this.attributes.add(name);
    else this.attributes.delete(name);
  }
  dispatchEvent() {
    return true;
  }
};
globalThis.customElements = { get: (name) => definitions[name], define: (name, cls) => (definitions[name] = cls) };
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
globalThis.document = {
  dir: "ltr",
  createElement(tag) {
    if (tag !== "iss-globe-view") return new FakeElement(tag);
    // Records what the panel asks of the globe.
    const view = new FakeElement(tag);
    view.configs = [];
    view.setAttribute = () => {};
    view.fire = (type) => (view.listeners[type] || []).forEach((fn) => fn({ type }));
    Object.defineProperty(view, "config", { set: (c) => view.configs.push(c), get: () => view.configs.at(-1) });
    return view;
  },
};

await import("../../custom_components/iss_tracker/frontend/iss-tracker-panel.js");
const IssTrackerPanel = definitions["iss-tracker-panel"];

const HOME = { entry_id: "home", title: "Home", show_in_sidebar: true };
const CABIN = { entry_id: "cabin", title: "Cabin", show_in_sidebar: true };
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("a deleted location makes the panel switch to one that is left", async () => {
  store.set("iss-tracker:panel", JSON.stringify({ entry_id: "cabin" }));
  let locations = [HOME, CABIN];
  const panel = new IssTrackerPanel();
  panel.hass = { callWS: async () => locations };
  await settle();
  assert.equal(panel._view.config.entry_id, "cabin");
  assert.equal(panel._view.config.panel, true, "the globe words its messages for the panel");
  assert.equal(panel._select.hidden, false);
  locations = [HOME];
  panel._view.fire("location-gone");
  await settle();
  assert.equal(panel._view.config.entry_id, "home");
  assert.deepEqual(panel._select.children.map((o) => o.value), ["home"]);
  assert.equal(panel._select.hidden, true, "no picker for a single location");
});

test("the panel knows when Home Assistant's sidebar sits beside it", () => {
  const panel = new IssTrackerPanel();
  panel._render = () => {};
  const docked = (hass, narrow = false) => {
    panel.narrow = narrow;
    panel.hass = hass;
    return panel.hasAttribute("docked");
  };
  assert.equal(docked({ dockedSidebar: "docked" }), true);
  assert.equal(docked({ dockedSidebar: "auto" }), true, "collapsed to icons, still beside the panel");
  assert.equal(docked({ dockedSidebar: "docked" }, true), false, "narrow screens slide it over the panel");
  assert.equal(docked({ dockedSidebar: "always_hidden" }), false);
  assert.equal(docked({ dockedSidebar: "docked", kioskMode: true }), false);
  assert.equal(docked({ dockedSidebar: "docked", auth: { external: { config: { hasSidebar: true } } } }), false);
  assert.equal(panel.hasAttribute("rtl"), false);
  document.dir = "rtl";
  docked({ dockedSidebar: "docked" });
  assert.equal(panel.hasAttribute("rtl"), true);
  document.dir = "ltr";
});
