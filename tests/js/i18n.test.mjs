// Tests for the globe's translations: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  LANGUAGES,
  Strings,
  english,
  loadStrings,
  peekStrings,
  resolveLanguage,
} from "../../custom_components/iss_tracker/frontend/iss-i18n.js";
import EN from "../../custom_components/iss_tracker/frontend/translations/en.js";

const FRONTEND = new URL("../../custom_components/iss_tracker/frontend/", import.meta.url);
const TRANSLATIONS = new URL("translations/", FRONTEND);
const translation = (lang) => JSON.parse(readFileSync(new URL(`${lang}.json`, TRANSLATIONS), "utf8"));
const OTHERS = LANGUAGES.filter((l) => l !== "en");

const placeholders = (text) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
const isPlural = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Every leaf of a table: [key, value], plural forms and lists kept whole. */
function* leaves(table, prefix = "") {
  for (const [key, value] of Object.entries(table)) {
    const path = `${prefix}${key}`;
    if (isPlural(value) && !("other" in value)) yield* leaves(value, `${path}.`);
    else yield [path, value];
  }
}

/** The plural forms a language uses for whole numbers. */
function pluralForms(lang) {
  const rules = new Intl.PluralRules(lang);
  return new Set([...Array(1000).keys()].map((n) => rules.select(n)));
}

test("there is a translation file for every language, and no other", () => {
  const files = readdirSync(TRANSLATIONS).sort();
  assert.deepEqual(files, ["en.js", ...OTHERS.map((l) => `${l}.json`)].sort());
});

for (const lang of OTHERS) {
  test(`the ${lang} translation has every English key, with the same placeholders`, () => {
    const table = translation(lang);
    const ours = new Map(leaves(table));
    const theirs = new Map(leaves(EN));
    assert.deepEqual([...ours.keys()].sort(), [...theirs.keys()].sort());
    for (const [key, en] of theirs) {
      const value = ours.get(key);
      if (Array.isArray(en)) {
        assert.ok(Array.isArray(value) && value.length === en.length, `${key}: ${en.length} names`);
        assert.ok(value.every((v) => typeof v === "string" && v.trim()), key);
        assert.equal(new Set(value).size, value.length, `${key}: names repeat`);
      } else if (isPlural(en)) {
        assert.ok(isPlural(value), `${key} has plural forms`);
        const known = new Set(Object.values(en).flatMap((t) => [...placeholders(t)]));
        for (const form of pluralForms(lang)) assert.ok(typeof value[form] === "string", `${key}.${form}`);
        for (const [form, text] of Object.entries(value)) {
          for (const name of placeholders(text)) assert.ok(known.has(name), `${key}.${form}: {${name}}`);
        }
        assert.deepEqual(placeholders(value.other), placeholders(en.other), `${key}.other`);
      } else {
        assert.equal(typeof value, "string", key);
        assert.ok(value.trim(), `${key} is empty`);
        assert.deepEqual(placeholders(value), placeholders(en), key);
      }
    }
  });
}

test("a compass point that ends in a full stop never makes two", () => {
  // Polish abbreviates them ("wsch."), and does not double the stop at the end of a sentence.
  const points = ["direction", "start", "peak", "end"];
  for (const lang of OTHERS) {
    const strings = new Strings(lang, translation(lang));
    for (const [key, value] of leaves(translation(lang))) {
      if (typeof value !== "string" && !isPlural(value)) continue;
      for (const point of strings.list("compass")) {
        const vars = { count: 2 };
        for (const name of points) vars[name] = point;
        assert.doesNotMatch(strings.t(key, vars), /\.\./, `${lang} ${key} with ${point}`);
      }
    }
  }
});

test("every key the frontend uses has English text", () => {
  const defined = (key) => key.split(".").reduce((v, part) => v?.[part], EN) !== undefined;
  const groups = Object.keys(EN).join("|");
  const keyPattern = new RegExp(`["'\`]((?:${groups})\\.[a-z_]+)["'\`]`, "g");
  const missing = [];
  for (const file of ["iss-globe.js", "iss-globe-card.js", "iss-tracker-panel.js"]) {
    const source = readFileSync(new URL(file, FRONTEND), "utf8");
    for (const [, key] of source.matchAll(keyPattern)) {
      if (!defined(key)) missing.push(`${file}: ${key}`);
    }
  }
  // Keys the code puts together.
  const built = [
    ...["visible", "low", "low_up_to", "brief", "twilight", "daylight", "shadow"].flatMap((r) => [`pass.${r}`, `pass.${r}_long`]),
    ...["high", "medium", "low"].map((c) => `mission.confidence_${c}`),
    ...["satellite", "esri", "streets"].flatMap((i) => [`controls.imagery_${i}`, `editor.imagery_${i}`]),
    ...["home", "follow", "chase"].map((v) => `editor.view_${v}`),
    ...["entry_id", "imagery", "view", "labels", "show_track", "show_night", "show_footprint", "show_home_zone",
      "show_countdown", "show_stats", "cooperative_gestures", "height"].map((n) => `editor.${n}`),
  ];
  for (const key of built) if (!defined(key)) missing.push(key);
  assert.deepEqual(missing, []);
});

test("Home Assistant's language picks the translation", () => {
  assert.equal(resolveLanguage("de"), "de");
  assert.equal(resolveLanguage("de-CH"), "de");
  assert.equal(resolveLanguage("pt-BR"), "pt-BR");
  assert.equal(resolveLanguage("pt"), "pt-BR");
  assert.equal(resolveLanguage("es-419"), "es");
  assert.equal(resolveLanguage("en-GB"), "en");
  assert.equal(resolveLanguage("nb"), "en");
  assert.equal(resolveLanguage("zh-Hans"), "en");
  assert.equal(resolveLanguage(undefined), "en");
});

test("text is filled in, counted and escaped", () => {
  const de = new Strings("de", translation("de"));
  assert.equal(de.t("mission.look_up", { direction: "SSW", elevation: 45 }), "Schau nach SSW, 45° hoch");
  assert.equal(de.t("pass.orbits_away", { count: 1 }), "1 Umlauf entfernt");
  assert.equal(de.t("pass.orbits_away", { count: 3 }), "3 Umläufe entfernt");
  assert.equal(english.t("mission.none_in_window", { count: 1 }), "No visible passes in the next day");
  assert.equal(english.t("mission.none_in_window", { count: 10 }), "No visible passes in the next 10 days");
  const pl = new Strings("pl", translation("pl"));
  assert.deepEqual(
    [1, 2, 5, 22].map((count) => pl.t("pass.orbits_away", { count })),
    ["za 1 okrążenie", "za 2 okrążenia", "za 5 okrążeń", "za 22 okrążenia"]
  );
  // A key a translation lacks shows in English, an unknown one as itself.
  const partial = new Strings("de", { mission: { visible_now: "Jetzt sichtbar" } });
  assert.equal(partial.t("mission.visible_now"), "Jetzt sichtbar");
  assert.equal(partial.t("mission.none_soon"), "None soon");
  assert.equal(partial.t("pass.orbits_away", { count: 2 }), "2 orbits away");
  assert.equal(partial.t("no.such_key"), "no.such_key");
  // HTML: the text is escaped, the values are not.
  const fr = new Strings("fr", translation("fr"));
  assert.equal(fr.html("pass.next_over", { time: "<b>lun. 21:14</b>" }), "Prochain passage dans votre ciel <b>lun. 21:14</b>");
  assert.equal(fr.html("telemetry.distance", { distance: "<b>1 234 km</b>", place: "Maison" }), "À <b>1 234 km</b> de Maison");
  assert.equal(new Strings("en", { telemetry: { sunlit: "<i>&</i>" } }).html("telemetry.sunlit"), "&#60;i&#62;&#38;&#60;/i&#62;");
});

test("compass points, countdowns and durations are translated", () => {
  const de = new Strings("de", translation("de"));
  assert.equal(de.direction("SE"), "SO");
  assert.equal(de.direction("WSW"), "WSW");
  assert.equal(new Strings("sv", translation("sv")).direction("E"), "Ö");
  assert.equal(de.direction("XYZ"), "XYZ");
  assert.deepEqual(de.list("sky.cardinals"), ["N", "O", "S", "W"]);
  // An incomplete list falls back to English.
  assert.equal(new Strings("de", { compass: ["N", "O"] }).direction("E"), "E");
  assert.equal(de.countdown(93_784_000), "1 T 02:03:04");
  assert.equal(de.duration(134 * 60_000), "2 Std. 14 Min.");
  assert.equal(new Strings("fr", translation("fr")).duration(26 * 3600_000), "1 j 2 h");
  assert.equal(new Strings("nl", translation("nl")).duration(20_000), "minder dan een minuut");
});

test("a translation is downloaded once, and English stands in while it cannot be", async () => {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const asked = [];
  let fail = true;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    if (fail) throw new TypeError("Failed to fetch");
    return { ok: true, json: async () => translation("it") };
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    let now = realNow();
    Date.now = () => now;
    assert.equal(peekStrings("it"), null);
    assert.equal(await loadStrings("it"), english);
    assert.equal(await loadStrings("it-CH"), english, "no second attempt straight away");
    assert.equal(asked.length, 1);
    assert.match(asked[0], /translations\/it\.json$/);
    fail = false;
    now += 61_000;
    const [a, b] = await Promise.all([loadStrings("it"), loadStrings("it")]);
    assert.equal(a, b, "one download for both");
    assert.equal(asked.length, 2);
    assert.equal(a.language, "it");
    assert.equal(a.t("upcoming.title"), "Passaggi visibili");
    assert.equal(peekStrings("it"), a);
    assert.equal(await loadStrings("it"), a);
    assert.equal(await loadStrings("en"), english);
    assert.equal(asked.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
    console.warn = warn;
  }
});
