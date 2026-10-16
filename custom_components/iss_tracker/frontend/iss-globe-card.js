/**
 * Dashboard card: the ISS globe in a card.
 *
 * Loaded on every Home Assistant page by the integration, so it stays tiny and
 * only pulls in the globe (and MapLibre) once a card is actually shown.
 */

const VERSION = new URL(import.meta.url).searchParams.get("v") || "";
const QUERY = VERSION ? `?v=${VERSION}` : "";

const DEFAULTS = {
  imagery: "satellite",
  view: "home",
  labels: true,
  show_track: true,
  show_night: true,
  show_footprint: true,
  show_home_zone: true,
  show_countdown: true,
  show_stats: true,
  height: 420,
};

const SWITCHES = [
  "labels", "show_track", "show_night", "show_footprint",
  "show_home_zone", "show_countdown", "show_stats", "cooperative_gestures",
];

// Retry a failed module download at most this often.
const RETRY_MS = 30000;
// The card editor waits no longer than this for its text, then opens in English.
const FORM_TEXT_WAIT_MS = 3000;

// The text in the user's language comes from iss-i18n.js, loaded only when
// it is needed; until then (and if it cannot load) these stay English.
const CARD_NAME = "ISS globe";
const CARD_DESCRIPTION =
  "A 3D Earth with the International Space Station at its true altitude, its orbit and a countdown to when it next crosses your sky.";
const LOAD_FAILED = "Could not load the ISS globe. Check the connection, or reload the page.";

let i18nModule;
// The module once it is in, for English while a translation is slow to come.
let i18nLoaded = null;
function loadI18n() {
  // A failed import is not kept, so the next use tries again.
  i18nModule ??= import(`./iss-i18n.js${QUERY}`).then(
    (module) => (i18nLoaded = module),
    (err) => {
      i18nModule = null;
      throw err;
    }
  );
  return i18nModule;
}

/** The text for Home Assistant's language, which it puts on the page; null if it cannot load. */
async function pageStrings() {
  try {
    return await (await loadI18n()).loadStrings(document.documentElement.lang);
  } catch {
    return null;
  }
}

/** pageStrings, but after waitMs whatever there is: English once the module is in, else null. */
function pageStringsWithin(waitMs) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(i18nLoaded?.english ?? null), waitMs);
  });
  return Promise.race([pageStrings(), late]).finally(() => clearTimeout(timer));
}

class IssGlobeCard extends HTMLElement {
  // Home Assistant waits for the form, so the editor opens in the user's
  // language, or in English if that is slow to come.
  static async getConfigForm() {
    const strings = await pageStringsWithin(FORM_TEXT_WAIT_MS);
    const text = (key) => strings?.t(`editor.${key}`);
    const options = (name, values) => values.map((value) => ({ value, label: text(`${name}_${value}`) ?? value }));
    return {
      schema: [
        { name: "entry_id", selector: { config_entry: { integration: "iss_tracker" } } },
        {
          name: "imagery",
          selector: { select: { mode: "dropdown", options: options("imagery", ["satellite", "esri", "streets"]) } },
        },
        {
          name: "view",
          selector: { select: { mode: "dropdown", options: options("view", ["home", "follow", "chase"]) } },
        },
        {
          type: "grid",
          name: "",
          // The defaults let the switches show what the card actually does.
          schema: SWITCHES.map((name) => ({ name, default: DEFAULTS[name] === true, selector: { boolean: {} } })),
        },
        {
          name: "height",
          default: DEFAULTS.height,
          selector: { number: { min: 340, max: 1200, step: 10, mode: "box", unit_of_measurement: "px" } },
        },
      ],
      computeLabel: (schema) => (schema.name ? text(schema.name) : undefined),
      computeHelper: (schema) => (schema.name === "entry_id" ? text("entry_id_helper") : undefined),
    };
  }

  static getStubConfig() {
    return { imagery: DEFAULTS.imagery, view: DEFAULTS.view };
  }

  setConfig(config) {
    this._config = { ...DEFAULTS, ...config };
    if (this._view) this._view.config = this._config;
    this._applyHeight();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._view) this._view.hass = hass;
    else this._ensure();
  }

  set layout(layout) {
    this._layout = layout;
    this._applyHeight();
  }

  /** Home Assistant sets this on cards shown in the editor. */
  set preview(preview) {
    this._editorPreview = !!preview;
    if (this._view) this._view.editorPreview = this._editorPreview;
  }

  connectedCallback() {
    this._ensure();
  }

  getCardSize() {
    return Math.max(4, Math.round((this._config?.height ?? DEFAULTS.height) / 50));
  }

  getGridOptions() {
    // The countdown, the map controls and the telemetry need a full section width.
    return { columns: 12, rows: 8, min_columns: 12, min_rows: 6 };
  }

  async _ensure() {
    if (this._loading || this._view || !this._hass || !this.isConnected) return;
    if (Date.now() < (this._retryAt || 0)) return;
    this._loading = true;
    if (!this._card) {
      const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      root.innerHTML = `
        <style>
          :host { display: block; height: 100%; }
          ha-card { overflow: hidden; height: 100%; min-height: 240px; isolation: isolate; }
          /* Fullscreen without the browser's fullscreen (iPhones) is a fixed
             overlay: lift the card above the dashboard's header and cards, and
             drop a theme's backdrop filter, which would hold it inside the card. */
          ha-card:has(> iss-globe-view[fullscreen]) { position: relative; z-index: 10000;
            backdrop-filter: none; -webkit-backdrop-filter: none; }
          iss-globe-view { border-radius: var(--ha-card-border-radius, 12px); }
          .error { padding: 16px; color: var(--secondary-text-color); }
        </style>
        <ha-card></ha-card>`;
      this._card = root.querySelector("ha-card");
      this._applyHeight();
    }
    const query = [VERSION && `v=${VERSION}`, this._attempt && `retry=${this._attempt}`].filter(Boolean).join("&");
    try {
      await import(`./iss-globe.js${query ? `?${query}` : ""}`);
    } catch (err) {
      // Browsers remember a failed module fetch, so the retry uses a new URL.
      this._attempt = (this._attempt || 0) + 1;
      this._retryAt = Date.now() + RETRY_MS;
      const message = document.createElement("div");
      message.className = "error";
      message.textContent = LOAD_FAILED;
      this._card.replaceChildren(message);
      console.warn("ISS globe card:", err);
      pageStrings().then((strings) => {
        if (strings && message.isConnected) message.textContent = strings.t("card.load_failed");
      });
      return;
    } finally {
      this._loading = false;
    }
    if (this._view || !this.isConnected) return;
    this._card.replaceChildren();
    const view = document.createElement("iss-globe-view");
    view.editorPreview = !!this._editorPreview;
    // Smaller overlays on narrow cards; the globe decides from its own size.
    view.autoCompact = true;
    view.config = this._config;
    view.hass = this._hass;
    this._card.appendChild(view);
    this._view = view;
  }

  _applyHeight(settled = false) {
    if (!this._card) return;
    if (this._layout === "grid" || this._layout === "panel") {
      // Sections grids and panel views give the card its size.
      this._card.style.height = "100%";
      return;
    }
    if (!settled) {
      // Home Assistant tells a card its layout just after creating it; wait
      // a frame rather than flip heights and make the view re-layout.
      cancelAnimationFrame(this._heightFrame);
      this._heightFrame = requestAnimationFrame(() => this._applyHeight(true));
      return;
    }
    this._card.style.height = `${this._config?.height ?? DEFAULTS.height}px`;
  }
}

// The card picker's entry, in the user's language once its text has loaded.
let pickerStrings = null;

/** Load the picker's text when Home Assistant's language is not English (it sets <html lang>). */
function preparePicker() {
  const language = document.documentElement.lang;
  if (!language || /^en\b/i.test(language)) {
    pickerStrings = null;
    return;
  }
  pageStrings().then((strings) => {
    if (document.documentElement.lang === language) pickerStrings = strings;
  });
}

function register() {
  if (customElements.get("iss-globe-card")) return;
  customElements.define("iss-globe-card", IssGlobeCard);
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === "iss-globe-card")) {
    window.customCards.push({
      type: "iss-globe-card",
      // Read when the card picker opens.
      get name() {
        return pickerStrings?.t("card.name") ?? CARD_NAME;
      },
      get description() {
        return pickerStrings?.t("card.description") ?? CARD_DESCRIPTION;
      },
      documentationURL: "https://github.com/kedube/ha-iss-tracker",
    });
  }
  preparePicker();
  new MutationObserver(preparePicker).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
}

// Home Assistant installs a scoped custom element registry while its app
// starts. This module is loaded early, and a card defined before that switch
// is invisible to dashboards ("Custom element doesn't exist"), so wait for the
// app's own element first. The timeout covers pages without it.
Promise.race([
  customElements.whenDefined("home-assistant"),
  new Promise((resolve) => setTimeout(resolve, 15000)),
]).then(register);
