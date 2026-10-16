// Tests for loading MapLibre: node --test "tests/js/*.test.mjs"
// A file of its own, as the loader keeps its state for the life of the page
// (here, of the test process).
import assert from "node:assert/strict";
import { test } from "node:test";

const { loadMapLibre, mapLibreNeedsReload } = await import("../../custom_components/iss_tracker/frontend/iss-globe.js");

test("MapLibre's entry module is asked for again under a new URL; a failed shared chunk needs a reload", async () => {
  const asked = [];
  let entryOk = false;
  let chunkOk = true;
  const fail = () => {
    throw new TypeError("Failed to fetch dynamically imported module");
  };
  const maplibre = { Map: class {} };
  const load = async (url) => {
    asked.push(url.slice(url.lastIndexOf("/") + 1));
    if (url.includes("shared")) return chunkOk ? {} : fail();
    // The entry module imports the chunk.
    return entryOk && chunkOk ? maplibre : fail();
  };
  await assert.rejects(loadMapLibre(load));
  assert.equal(mapLibreNeedsReload(), false);
  entryOk = true;
  chunkOk = false;
  await assert.rejects(loadMapLibre(load));
  assert.equal(mapLibreNeedsReload(), true, "the chunk's URL cannot change");
  assert.deepEqual(asked, ["maplibre-gl.mjs", "maplibre-gl-shared.mjs", "maplibre-gl.mjs?retry=1", "maplibre-gl-shared.mjs"]);
  // A browser that does fetch it again still gets the globe, and keeps it.
  chunkOk = true;
  assert.equal(await loadMapLibre(load), maplibre);
  assert.equal(await loadMapLibre(load), maplibre);
  assert.equal(asked.length, 6);
});
