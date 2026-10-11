/**
 * Dashboard card: the ISS globe in a card.
 *
 * Loaded on every Home Assistant page by the integration, so it stays tiny and
 * only pulls in the globe (and MapLibre) once a card is actually shown.
 */

const VERSION = new URL(import.meta.url).searchParams.get("v") || "";

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

const LABELS = {
  entry_id: "Location",
  imagery: "Imagery",
  view: "Start view",
  labels: "Place names and borders",
  show_track: "Course lines",
  show_night: "Day and night",
  show_footprint: "Area that can see the ISS",
  show_home_zone: "Your visibility cone",
  show_countdown: "Countdown",
  show_stats: "Position and speed",
  height: "Height (masonry dashboards)",
  cooperative_gestures: "Require two fingers or Ctrl to move the map",
};

const HELPERS = {
  entry_id: "Leave empty to show the first location.",
};

// Retry a failed module download at most this often.
const RETRY_MS = 30000;

class IssGlobeCard extends HTMLElement {
  static getConfigForm() {
    return {
      schema: [
        { name: "entry_id", selector: { config_entry: { integration: "iss_tracker" } } },
        {
          name: "imagery",
          selector: {
            select: {
              mode: "dropdown",
              options: [
                { value: "satellite", label: "Satellite (NASA Blue Marble, Sentinel-2 close up)" },
                { value: "esri", label: "Satellite, high detail close up (Esri)" },
                { value: "streets", label: "Street map close up (OpenStreetMap)" },
              ],
            },
          },
        },
        {
          name: "view",
          selector: {
            select: {
              mode: "dropdown",
              options: [
                { value: "home", label: "My location" },
                { value: "follow", label: "Follow the ISS" },
                { value: "chase", label: "Fly along with the ISS" },
              ],
            },
          },
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
      computeLabel: (schema) => LABELS[schema.name],
      computeHelper: (schema) => HELPERS[schema.name],
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
      this._card.innerHTML = `<div class="error">Could not load the ISS globe. Check the connection, or reload the page.</div>`;
      console.warn("ISS globe card:", err);
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

function register() {
  if (customElements.get("iss-globe-card")) return;
  customElements.define("iss-globe-card", IssGlobeCard);
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === "iss-globe-card")) {
    window.customCards.push({
      type: "iss-globe-card",
      name: "ISS globe",
      description: "A 3D Earth with the International Space Station at its true altitude, its orbit and a countdown to when it next crosses your sky.",
      documentationURL: "https://github.com/kedube/ha-iss-tracker",
    });
  }
}

// Home Assistant installs a scoped custom element registry while its app
// starts. This module is loaded early, and a card defined before that switch
// is invisible to dashboards ("Custom element doesn't exist"), so wait for the
// app's own element first. The timeout covers pages without it.
Promise.race([
  customElements.whenDefined("home-assistant"),
  new Promise((resolve) => setTimeout(resolve, 15000)),
]).then(register);
