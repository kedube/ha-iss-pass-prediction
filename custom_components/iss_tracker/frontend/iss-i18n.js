/**
 * The globe's text in the user's language: the dashboard card, the sidebar
 * panel and the globe itself all take theirs from here.
 *
 * English is built in (translations/en.js). The other languages are JSON
 * files beside it, downloaded the first time they are needed; a key one of
 * them lacks, or one that cannot be downloaded, shows in English.
 */

const VERSION = new URL(import.meta.url).search;
const { default: EN } = await import(`./translations/en.js${VERSION}`);

/** Languages with a translation, as Home Assistant names them. */
export const LANGUAGES = ["en", "de", "es", "fr", "it", "nl", "pl", "pt-BR", "sv"];

// After a failed download, show English for this long before trying again.
const RETRY_MS = 60000;

/** The translation for a Home Assistant language: "de-CH" gets German, "pt" Brazilian Portuguese. */
export function resolveLanguage(language) {
  const code = String(language || "");
  if (LANGUAGES.includes(code)) return code;
  const base = code.split(/[-_]/)[0].toLowerCase();
  return LANGUAGES.find((l) => l.split("-")[0] === base) ?? "en";
}

function lookup(table, key) {
  let value = table;
  for (const part of key.split(".")) {
    value = value?.[part];
    if (value === undefined) return undefined;
  }
  return value;
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));

export class Strings {
  constructor(language, table) {
    this.language = language;
    this._table = table;
    this._plural = new Intl.PluralRules(language);
  }

  _template(key, vars) {
    for (const [table, plural] of [[this._table, this._plural], [EN, englishPlural]]) {
      let value = lookup(table, key);
      // Plural forms, chosen by {count}.
      if (value && typeof value === "object" && !Array.isArray(value)) {
        value = value[plural.select(Number(vars.count))] ?? value.other;
      }
      if (typeof value === "string") return value;
    }
    return key;
  }

  /** The text for a key, with its {placeholders} filled in. */
  t(key, vars = {}) {
    return fill(this._template(key, vars), vars);
  }

  /** The same as HTML: the text is escaped, the values go in as they are (escape them first). */
  html(key, vars = {}) {
    return fill(escapeHtml(this._template(key, vars)), vars);
  }

  /** A list of names, such as the compass points; English if the translation's is not complete. */
  list(key) {
    const names = lookup(this._table, key);
    const english = lookup(EN, key);
    return Array.isArray(names) && names.length === english.length ? names : english;
  }

  /** A compass point as the integration names it ("SSW"), in this language. */
  direction(point) {
    const i = EN.compass.indexOf(point);
    return i >= 0 ? this.list("compass")[i] : point;
  }

  /** "1d 07:42:13", "07:42:13" or "42:13". */
  countdown(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (v) => String(v).padStart(2, "0");
    const time = days || h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    return days ? this.t("time.countdown_days", { days, time }) : time;
  }

  /** "2 h 14 min", "14 min", "under a minute". */
  duration(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return this.t("time.under_minute");
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const rest = minutes % 60;
    if (days) return this.t("time.days_hours", { days, hours });
    if (hours) return rest ? this.t("time.hours_minutes", { hours, minutes: rest }) : this.t("time.hours", { hours });
    return this.t("time.minutes", { minutes: rest });
  }
}

const englishPlural = new Intl.PluralRules("en");
export const english = new Strings("en", EN);

const loaded = new Map([["en", english]]);
const loading = new Map();
const failedAt = new Map();

/** The translation for a language if it has been downloaded already, else null. */
export function peekStrings(language) {
  return loaded.get(resolveLanguage(language)) ?? null;
}

/** Download the translation for a language; resolves to English when that fails. */
export function loadStrings(language) {
  const lang = resolveLanguage(language);
  if (loaded.has(lang)) return Promise.resolve(loaded.get(lang));
  if (Date.now() - (failedAt.get(lang) ?? -Infinity) < RETRY_MS) return Promise.resolve(english);
  if (!loading.has(lang)) {
    const url = new URL(`./translations/${lang}.json${VERSION}`, import.meta.url);
    const download = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((table) => {
        const strings = new Strings(lang, table);
        loaded.set(lang, strings);
        return strings;
      })
      .catch((err) => {
        failedAt.set(lang, Date.now());
        console.warn(`ISS Tracker: could not load the ${lang} text (${err?.message || err}); showing English`);
        return english;
      })
      .finally(() => loading.delete(lang));
    loading.set(lang, download);
  }
  return loading.get(lang);
}
