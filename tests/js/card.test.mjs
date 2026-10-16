// Tests for the dashboard card, with just enough of a page to load it in node:
// node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

// Timers run fast, so none keeps the process waiting. They stay referenced: a
// test that waits on one must keep the event loop alive until it fires.
const realSetTimeout = setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, Math.min(ms ?? 0, 20), ...args);

const definitions = {};
globalThis.HTMLElement = class {};
globalThis.customElements = {
  get: (name) => definitions[name],
  define: (name, cls) => (definitions[name] = cls),
  whenDefined: async () => {},
};
globalThis.window = globalThis;
globalThis.MutationObserver = class {
  observe() {}
};
globalThis.document = { documentElement: { lang: "de" } };
// The German text never arrives.
globalThis.fetch = () => new Promise(() => {});

await import("../../custom_components/iss_tracker/frontend/iss-i18n.js");
await import("../../custom_components/iss_tracker/frontend/iss-globe-card.js");
await new Promise((resolve) => setImmediate(resolve));
const IssGlobeCard = definitions["iss-globe-card"];

test("the card editor opens in English when its translation is slow to come", async () => {
  const form = await IssGlobeCard.getConfigForm();
  assert.equal(form.computeLabel({ name: "entry_id" }), "Location");
  assert.equal(form.computeHelper({ name: "entry_id" }), "Leave empty to show the first location.");
});
