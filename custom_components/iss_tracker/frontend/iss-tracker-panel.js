/**
 * Sidebar panel: the ISS globe full screen, with the list of upcoming passes.
 * Registered by the integration when "Show ISS Tracker in the sidebar" is on.
 */

const VERSION = new URL(import.meta.url).searchParams.get("v") || "";
const STORE = "iss-tracker:panel";
const MENU_ICON = "M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z";
// Retry a failed module download at most this often.
const RETRY_MS = 30000;
// Shown when the globe cannot load, in English if its text cannot load either.
const LOAD_FAILED = "Could not load the ISS globe. Check the connection, or reload the page.";

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) || {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORE, JSON.stringify(settings));
  } catch {
    // Private mode or storage disabled: settings just are not remembered.
  }
}

// The panel draws edge to edge and keeps clear of notches and home indicators itself.
const inset = (side) => `var(--safe-area-inset-${side}, env(safe-area-inset-${side}, 0px))`;

class IssTrackerPanel extends HTMLElement {
  set hass(hass) {
    this._hass = hass;
    this._languageReady = this._useLanguage();
    this._updateMenu();
    if (this._view) {
      this._view.hass = hass;
      // Opened while the locations were still starting up: look again.
      if (Date.now() >= (this._locationsRetryAt ?? Infinity)) this._reloadLocations();
    } else {
      this._render();
    }
  }

  set narrow(narrow) {
    this._narrow = narrow;
    this._updateMenu();
  }

  set panel(panel) {
    this._panel = panel;
  }

  connectedCallback() {
    this._render();
  }

  /** Load the panel's text in Home Assistant's language (the globe loads its own). */
  async _useLanguage() {
    const language = this._hass?.language || "en";
    if (language === this._language) return;
    this._language = language;
    try {
      const i18n = await import(`./iss-i18n.js${VERSION ? `?v=${VERSION}` : ""}`);
      const strings = await i18n.loadStrings(language);
      if (this._language !== language) return;
      this._strings = strings;
      this._applyStrings();
    } catch (err) {
      // Let the next update try again.
      this._language = undefined;
      console.warn("ISS Tracker:", err);
    }
  }

  _applyStrings() {
    const strings = this._strings;
    if (!strings || !this._menu) return;
    this._menu.title = strings.t("panel.sidebar");
    this._menu.setAttribute("aria-label", strings.t("panel.sidebar"));
    this._select.setAttribute("aria-label", strings.t("panel.location"));
    if (this._error) this._error.textContent = strings.t("card.load_failed");
  }

  /** The sidebar button, shown when Home Assistant would show its own. */
  _updateMenu() {
    const hass = this._hass;
    const sidebarHidden = this._narrow || hass?.dockedSidebar === "always_hidden";
    const external = hass?.auth?.external?.config?.hasSidebar === true;
    // Home Assistant's own test for a sidebar beside the panel, which keeps
    // clear of the notch on that side itself.
    this.toggleAttribute("docked", !sidebarHidden && !hass?.kioskMode && !external);
    this.toggleAttribute("rtl", document.dir === "rtl");
    if (!this._menu) return;
    this._menu.hidden = !(sidebarHidden && !hass?.kioskMode && !external);
  }

  async _render() {
    if (this._rendering || this._view || !this._hass || !this.isConnected) return;
    if (Date.now() < (this._retryAt || 0)) return;
    this._rendering = true;
    this._settings = loadSettings();
    // Start loading the globe while the locations are being looked up.
    const query = [VERSION && `v=${VERSION}`, this._attempt && `retry=${this._attempt}`].filter(Boolean).join("&");
    const globe = import(`./iss-globe.js${query ? `?${query}` : ""}`);
    globe.catch(() => {}); // Handled below.

    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        /* Clear of the notch on the sides that reach the screen's edge: not
           the one a docked sidebar covers. Home Assistant zeroes its left
           content inset beside the sidebar, whatever the text direction. */
        :host { display: flex; flex-direction: column; height: 100vh; height: 100dvh; background: #000;
          --iss-l: var(--safe-area-content-inset-left, ${inset("left")}); --iss-r: ${inset("right")}; }
        :host([rtl]) { --iss-l: ${inset("left")}; }
        :host([rtl][docked]) { --iss-r: 0px; }
        [hidden] { display: none !important; }
        header { display: flex; align-items: center; gap: 8px; flex: none; box-sizing: border-box;
          height: calc(var(--header-height, 56px) + ${inset("top")});
          padding: ${inset("top")} calc(12px + var(--iss-r)) 0 calc(12px + var(--iss-l));
          background: var(--app-header-background-color, var(--primary-color));
          color: var(--app-header-text-color, #fff);
          border-bottom: var(--app-header-border-bottom, none);
          font-family: var(--ha-font-family-body, Roboto, sans-serif); }
        header h1 { font-size: 20px; font-weight: 400; margin: 0 0 0 4px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        button.menu { background: none; border: 0; color: inherit; width: 40px; height: 40px; border-radius: 50%; cursor: pointer; display: grid; place-items: center; }
        button.menu:hover { background: rgba(255,255,255,.12); }
        button.menu svg { width: 24px; height: 24px; fill: currentColor; }
        select { font: inherit; font-size: 14px; color: inherit; background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.3); border-radius: 6px; padding: 4px 8px; max-width: 45vw; }
        select option { color: #000; }
        main { position: relative; flex: 1; min-height: 0; }
        iss-globe-view { position: absolute; inset: 0;
          --iss-safe-left: var(--iss-l); --iss-safe-right: var(--iss-r); --iss-safe-bottom: ${inset("bottom")}; }
        .error { padding: 24px; color: #cbd5e1; font-family: var(--ha-font-family-body, Roboto, sans-serif); }
      </style>
      <header>
        <button class="menu"><svg viewBox="0 0 24 24"><path d="${MENU_ICON}"/></svg></button>
        <h1>ISS Tracker</h1>
        <select class="location" hidden></select>
      </header>
      <main></main>`;

    this._menu = root.querySelector("button.menu");
    this._updateMenu();
    this._menu.addEventListener("click", () =>
      this.dispatchEvent(new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true }))
    );

    const select = (this._select = root.querySelector("select.location"));
    this._applyStrings();
    const entryId = await this._loadLocations();
    this._viewConfig = { imagery: this._settings.imagery || "satellite", view: "home", entry_id: entryId, panel: true };
    // Listen before the globe has loaded, so an early choice is not lost.
    select.addEventListener("change", () => {
      this._settings.entry_id = select.value;
      saveSettings(this._settings);
      this._configureView({ entry_id: select.value });
    });

    try {
      await globe;
    } catch (err) {
      // Browsers remember a failed module fetch, so the retry uses a new URL.
      this._attempt = (this._attempt || 0) + 1;
      this._retryAt = Date.now() + RETRY_MS;
      this._rendering = false;
      this._error = document.createElement("div");
      this._error.className = "error";
      this._error.textContent = this._strings?.t("card.load_failed") ?? LOAD_FAILED;
      root.querySelector("main").replaceChildren(this._error);
      console.warn("ISS Tracker:", err);
      return;
    }
    const view = document.createElement("iss-globe-view");
    view.setAttribute("show-upcoming", "");
    view.config = this._viewConfig;
    view.hass = this._hass;
    view.addEventListener("imagery-changed", (e) => {
      this._settings.imagery = e.detail;
      saveSettings(this._settings);
      this._viewConfig = { ...this._viewConfig, imagery: e.detail };
    });
    // The location shown was deleted: offer the ones left, and show the first.
    view.addEventListener("location-gone", () => this._reloadLocations());
    root.querySelector("main").replaceChildren(view);
    this._view = view;
    this._rendering = false;
  }

  _configureView(changes) {
    this._viewConfig = { ...this._viewConfig, ...changes };
    if (this._view) this._view.config = this._viewConfig;
  }

  /** Fill the location picker; returns the location to show. */
  async _loadLocations() {
    let locations = [];
    try {
      locations = await this._hass.callWS({ type: "iss_tracker/locations" });
    } catch {
      // The globe shows its own message when nothing is set up.
    }
    // The list is empty while locations are still starting up; look again later.
    this._locationsRetryAt = locations.length ? null : Date.now() + RETRY_MS;
    const shown = locations.filter((l) => l.show_in_sidebar);
    const choices = shown.length ? shown : locations;
    const select = this._select;
    select.replaceChildren(
      ...choices.map((l) => {
        const opt = document.createElement("option");
        opt.value = l.entry_id;
        opt.textContent = l.title;
        return opt;
      })
    );
    select.hidden = choices.length < 2;
    const entryId = choices.some((l) => l.entry_id === this._settings.entry_id)
      ? this._settings.entry_id
      : choices[0]?.entry_id;
    select.value = entryId ?? "";
    return entryId;
  }

  async _reloadLocations() {
    this._locationsRetryAt = Infinity; // One look at a time.
    const entryId = await this._loadLocations();
    if (entryId && entryId !== this._viewConfig?.entry_id) this._configureView({ entry_id: entryId });
  }
}

if (!customElements.get("iss-tracker-panel")) {
  customElements.define("iss-tracker-panel", IssTrackerPanel);
}
