/**
 * ISS globe: a photo-real Earth with day and night, the International Space
 * Station at its true altitude, its orbit, your location and a countdown to
 * when it next crosses your sky.
 *
 * Shared by the dashboard card (iss-globe-card.js) and the sidebar panel
 * (iss-tracker-panel.js). The orbit is computed by the integration in Python
 * and sent over the websocket API; this file only draws it.
 */

const VERSION = new URL(import.meta.url).search;
const MAPLIBRE_DIR = new URL("./vendor/maplibre-gl-6.11.2/", import.meta.url);

let maplibrePromise;
let maplibreAttempt = 0;
// MapLibre's entry module imports its shared chunk from a fixed URL. A retry
// can ask for the entry under a new URL but not the chunk, so once the chunk
// has failed, only reloading the page brings it back.
let maplibreChunkFailed = false;
export function loadMapLibre(load = (url) => import(url)) {
  // A failed import is not kept: the next start tries again under a new URL,
  // since browsers remember a failed module fetch for the rest of the page.
  // The chunk is asked for alongside the entry module rather than after it.
  maplibrePromise ??= Promise.allSettled([
    load(new URL(`maplibre-gl.mjs${maplibreAttempt ? `?retry=${maplibreAttempt}` : ""}`, MAPLIBRE_DIR).href),
    load(new URL("maplibre-gl-shared.mjs", MAPLIBRE_DIR).href),
  ])
    .then(([entry, chunk]) => {
      if (chunk.status === "rejected") maplibreChunkFailed = true;
      if (entry.status === "rejected") throw entry.reason;
      return entry.value;
    })
    .catch((err) => {
      maplibrePromise = null;
      maplibreAttempt++;
      throw err;
    });
  return maplibrePromise;
}

/** Whether MapLibre has failed in a way that only reloading the page can fix. */
export function mapLibreNeedsReload() {
  return maplibreChunkFailed || maplibreAttempt >= 3;
}

// Start the 1 MB MapLibre download now, alongside the helper modules below,
// rather than after them. Errors surface when a globe starts.
if (globalThis.window && globalThis.document) {
  loadMapLibre().catch(() => {});
}

const [geo, spaceModule, skyModule, i18n] = await Promise.all([
  import(`./iss-geo.js${VERSION}`),
  import(`./iss-space.js${VERSION}`),
  import(`./iss-sky.js${VERSION}`),
  import(`./iss-i18n.js${VERSION}`),
]);
const {
  bearing, circleRing, closestApproach, compass, currentVisiblePass, endedPass, esc, frameDelay,
  groundDistanceKm, lookAngles, numberLocale, orbitalSpeed, positionAt, previewTimeline, skyTrack,
  subsolarPoint, sunVector, uses12Hour, visibilityRadius, ISS_PERIOD_S,
} = geo;
const { NightLayer, SpaceLayer, loadCityLights, toMercator } = spaceModule;
const { skyChartSvg, skyDotTransform, skyDotXY, SKY_STYLE } = skyModule;
const { english, loadStrings, resolveLanguage } = i18n;

const DEG = Math.PI / 180;

// Zoomed out the map is a globe; zooming in morphs it into a flat map.
const GLOBE_PROJECTION = [
  "interpolate", ["linear"], ["zoom"], 4.5, "vertical-perspective", 6, "mercator",
];

const BLUE_MARBLE = {
  type: "raster",
  tiles: [
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
  ],
  tileSize: 256,
  maxzoom: 8,
  attribution:
    'NASA Blue Marble &amp; Black Marble via <a href="https://www.earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS</a>',
};

/** Close-up imagery; from space the globe is always NASA's Blue Marble. */
export const IMAGERY = {
  satellite: {
    tiles: [
      "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg",
    ],
    maxzoom: 15,
    attribution:
      '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2025)',
  },
  esri: {
    tiles: [
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    ],
    maxzoom: 19,
    attribution: "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community",
  },
  streets: {
    homeAssistantTiles: "/api/map_tiles/raster/{z}/{x}/{y}.png",
    maxzoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  },
};
// Names used by earlier versions of the card.
const IMAGERY_ALIASES = { sentinel: "satellite", blue_marble: "satellite" };

// MapLibre's own button titles and hints, by the translation that gives each.
const MAPLIBRE_TEXT = {
  "AttributionControl.ToggleAttribution": "maplibre.attribution",
  "CooperativeGesturesHandler.MacHelpText": "maplibre.cmd_scroll",
  "CooperativeGesturesHandler.MobileHelpText": "maplibre.two_fingers",
  "CooperativeGesturesHandler.WindowsHelpText": "maplibre.ctrl_scroll",
  "FullscreenControl.Enter": "maplibre.fullscreen_enter",
  "FullscreenControl.Exit": "maplibre.fullscreen_exit",
  "Map.Title": "maplibre.map",
  "Marker.Title": "maplibre.marker",
  "NavigationControl.ResetBearing": "maplibre.reset_bearing",
  "NavigationControl.ZoomIn": "maplibre.zoom_in",
  "NavigationControl.ZoomOut": "maplibre.zoom_out",
};

// Simulated seconds per real second while a preview plays the pass (previewTimeline's pace).
const PREVIEW_RATE = 30;
// How long a lost WebGL context may take to come back before the map is rebuilt.
const CONTEXT_RESTORE_MS = 5000;
// With the station out of sight the picture changes slowly (the trail fades,
// the terminator creeps), so it is redrawn this often rather than every frame.
const IDLE_REPAINT_MS = 5000;

const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));

/**
 * MapLibre light pointing at the real Sun, so the atmosphere glows on the day
 * side. Live updates apply at once; the preview eases its bigger jumps.
 */
function sunLight(date, transitionMs = 0) {
  const s = subsolarPoint(date);
  const lat = s.lat * DEG;
  const lon = s.lon * DEG;
  // A map-anchored light is expressed in a globe frame turned half a turn
  // about the poles from the one tiles are drawn in (found by rendering the
  // four candidate axis conventions over known day and night views).
  const v = [-Math.sin(lon) * Math.cos(lat), Math.sin(lat), -Math.cos(lon) * Math.cos(lat)];
  const polar = Math.acos(Math.max(-1, Math.min(1, v[2]))) / DEG;
  const az = (((Math.atan2(v[1], v[0]) / DEG - 90) % 360) + 360) % 360;
  return {
    anchor: "map",
    position: [1.5, az, polar],
    intensity: 0.5,
    "position-transition": { duration: transitionMs, delay: 0 },
  };
}

function prefersReducedMotion() {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Set text only when it changed (cheaper, and keeps screen readers calm). */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// ---------------------------------------------------------------------------

const ICONS = {
  home: "M10,20V14H14V20H19V12H22L12,3L2,12H5V20H10Z",
  follow:
    "M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8M3.05,13H1V11H3.05C3.5,6.83 6.83,3.5 11,3.05V1H13V3.05C17.17,3.5 20.5,6.83 20.95,11H23V13H20.95C20.5,17.17 17.17,20.5 13,20.95V23H11V20.95C6.83,20.5 3.5,17.17 3.05,13M12,5A7,7 0 0,0 5,12A7,7 0 0,0 12,19A7,7 0 0,0 19,12A7,7 0 0,0 12,5Z",
  chase:
    "M17,10.5V7A1,1 0 0,0 16,6H4A1,1 0 0,0 3,7V17A1,1 0 0,0 4,18H16A1,1 0 0,0 17,17V13.5L21,17.5V6.5L17,10.5Z",
  globe:
    "M17.9,17.39C17.64,16.59 16.89,16 16,16H15V13A1,1 0 0,0 14,12H8V10H10A1,1 0 0,0 11,9V7H13A2,2 0 0,0 15,5V4.59C17.93,5.77 20,8.64 20,12C20,14.08 19.2,15.97 17.9,17.39M11,19.93C7.05,19.44 4,16.08 4,12C4,11.38 4.08,10.78 4.21,10.21L9,15V16A2,2 0 0,0 11,18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z",
  layers:
    "M12,16L19.36,10.27L21,9L12,2L3,9L4.63,10.27M12,18.54L4.62,12.81L3,14.07L12,21.07L21,14.07L19.37,12.8L12,18.54Z",
  play: "M8,5.14V19.14L19,12.14L8,5.14Z",
  eye: "M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17M12,4.5C7,4.5 2.73,7.61 1,12C2.73,16.39 7,19.5 12,19.5C17,19.5 21.27,16.39 23,12C21.27,7.61 17,4.5 12,4.5Z",
};

const svgIcon = (key) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[key]}"/></svg>`;

const HOME_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS.home}"/></svg>`;

const STYLE = `
[hidden] { display: none !important; }
:host { display: block; position: relative; width: 100%; height: 100%; min-height: 240px;
  --glass: linear-gradient(160deg, rgba(15,23,42,.86), rgba(15,23,42,.66));
  --edge: rgba(148,163,184,.24); --ink: #f8fafc; --ink-2: #cbd5e1; --ink-3: #94a3b8;
  --sky: #7dd3fc; --gold: #fcd34d; --violet: #a78bfa;
  --safe-t: 0px; --safe-l: var(--iss-safe-left, 0px); --safe-r: var(--iss-safe-right, 0px); --safe-b: var(--iss-safe-bottom, 0px);
  font-family: var(--ha-font-family-body, Roboto, system-ui, sans-serif); }
.wrap { position: absolute; inset: 0; overflow: hidden; border-radius: inherit; color: var(--ink);
  background: radial-gradient(ellipse at 50% 42%, #0b1a3a 0%, #040814 58%, #000 100%); }
/* Fullscreen covers the whole screen, notch and status bar included (iPhones
   get MapLibre's pseudo-fullscreen, a fixed overlay). :is() keeps the rule if
   a browser does not know one of the selectors. */
.wrap:is(.maplibregl-pseudo-fullscreen, :fullscreen) { border-radius: 0;
  --safe-t: var(--safe-area-inset-top, env(safe-area-inset-top, 0px));
  --safe-l: var(--safe-area-inset-left, env(safe-area-inset-left, 0px));
  --safe-r: var(--safe-area-inset-right, env(safe-area-inset-right, 0px));
  --safe-b: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)); }
.wrap::before { content: ""; position: absolute; inset: 0; pointer-events: none; background-image: var(--iss-stars); opacity: .8; }
#map { position: absolute; inset: 0; }
.maplibregl-canvas { outline: none; }
.maplibregl-canvas:focus-visible { outline: 2px solid var(--sky); outline-offset: -2px; }
.labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 1; }
.flabel { position: absolute; left: 0; top: 0; white-space: nowrap; will-change: transform; }
.flabel.tick { font-size: 10.5px; font-weight: 600; color: #e0f2fe; text-shadow: 0 0 4px #000, 0 0 8px #000; transform-origin: 0 50%; }
.flabel.pin { font-size: 11.5px; font-weight: 600; color: #1c1404; background: linear-gradient(180deg, #fde68a, #f59e0b);
  padding: 4px 9px; border-radius: 999px; box-shadow: 0 4px 16px rgba(245,158,11,.45), 0 0 0 1px rgba(0,0,0,.25);
  pointer-events: auto; cursor: pointer; }
.flabel.pin.dim { color: #0f172a; background: linear-gradient(180deg, #e2e8f0, #94a3b8); box-shadow: 0 4px 14px rgba(148,163,184,.35); }
.flabel.pin::after { content: ""; position: absolute; left: 50%; bottom: -5px; margin-left: -5px; border: 5px solid transparent; border-bottom: 0; border-top-color: #f59e0b; }
.flabel.pin.dim::after { border-top-color: #94a3b8; }
.hud { position: absolute; z-index: 2; color: var(--ink); }
.glass { background: var(--glass); border: 1px solid var(--edge); border-radius: 16px;
  box-shadow: 0 12px 32px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.06);
  backdrop-filter: blur(10px) saturate(1.2); -webkit-backdrop-filter: blur(10px) saturate(1.2); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.mission { top: calc(12px + var(--safe-t)); left: calc(12px + var(--safe-l)); padding: 13px 16px 14px; box-sizing: border-box;
  width: min(406px, calc(100% - 64px - var(--safe-l) - var(--safe-r))); }
.mission .top { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--sky); }
.mission .top .live { --ping: 34,197,94; width: 7px; height: 7px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 0 rgba(var(--ping),.6); }
.mission.now .top { color: var(--gold); }
.mission.now .top .live { --ping: 252,211,77; background: var(--gold); }
.mission.preview .top { color: #f0abfc; }
.mission.preview .top .live { --ping: 240,171,252; background: #f0abfc; }
.mission.paused .top { color: var(--ink-3); }
.mission.paused .top .live { background: var(--ink-3); }
.mission .chip { margin-left: auto; font-size: 10px; letter-spacing: .06em; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; border: 1px solid currentColor; }
.chip.high { color: #4ade80; } .chip.medium { color: #fbbf24; } .chip.low { color: #94a3b8; }
.mission .clock { font-size: 36px; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; line-height: 1.1; margin-top: 4px; }
.mission.now .clock { font-size: 26px; color: var(--gold); }
.mission.paused .clock { font-size: 24px; color: var(--ink-2); }
.mission .when { font-size: 13.5px; color: #e2e8f0; margin-top: 3px; }
.mission .detail { font-size: 12.5px; color: var(--ink-2); margin-top: 3px; }
.mission .intercept { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; color: var(--ink-2); margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(148,163,184,.18); }
.mission .intercept b { color: #fef3c7; font-weight: 600; }
.mission .intercept .ring { flex: none; width: 10px; height: 10px; margin-top: 3px; border-radius: 50%; border: 2px solid var(--gold); box-shadow: 0 0 8px rgba(252,211,77,.6); }
.mission .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.btn { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12.5px; font-weight: 600; color: #e0f2fe;
  background: rgba(56,189,248,.14); border: 1px solid rgba(56,189,248,.45); border-radius: 999px; padding: 6px 12px 6px 10px; cursor: pointer;
  transition: background .15s, border-color .15s, transform .15s; }
.btn:hover { background: rgba(56,189,248,.26); border-color: rgba(125,211,252,.8); }
.btn:active { transform: scale(.97); }
.btn:focus-visible { outline: 2px solid var(--sky); outline-offset: 2px; }
.btn[disabled] { opacity: .45; cursor: default; }
.btn svg { width: 16px; height: 16px; fill: currentColor; }
.btn .short { display: none; }
:host([compact]) .btn .long { display: none; }
:host([compact]) .btn .short { display: inline; }
.btn.gold { color: #fef3c7; background: rgba(252,211,77,.14); border-color: rgba(252,211,77,.5); }
.btn.gold:hover { background: rgba(252,211,77,.26); border-color: rgba(253,230,138,.9); }
.side { top: calc(12px + var(--safe-t)); right: calc(56px + var(--safe-r)); width: 272px; max-height: calc(100% - 92px - var(--safe-t) - var(--safe-b)); display: flex; flex-direction: column; gap: 10px; }
.side .glass { padding: 12px 14px; }
.side h3 { margin: 0; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--sky); font-weight: 600; }
.side .sub { font-size: 12px; color: var(--ink-2); margin: 3px 0 6px; }
.sky { display: grid; justify-items: center; }
.sky .caption { font-size: 11.5px; color: var(--ink-2); margin-top: 6px; line-height: 1.4; text-align: center; }
.upcoming { overflow: auto; min-height: 0; }
.upcoming ol { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 8px; }
.upcoming li { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; font-size: 12px; padding-top: 8px; border-top: 1px solid rgba(148,163,184,.15); }
.upcoming li:first-child { border-top: 0; padding-top: 0; }
.upcoming li { cursor: pointer; border-radius: 8px; transition: background .15s; }
.upcoming li:hover { background: rgba(56,189,248,.1); }
.upcoming li:focus { outline: none; }
.upcoming li:focus-visible { outline: 2px solid var(--sky); outline-offset: 2px; }
.upcoming .t { color: var(--ink); font-weight: 600; }
.upcoming .el { color: var(--gold); font-weight: 650; font-variant-numeric: tabular-nums; text-align: right; }
.upcoming .d { grid-column: 1 / -1; color: var(--ink-2); }
.upcoming .c { grid-column: 1 / -1; color: var(--ink-3); font-size: 10.5px; }
.telemetry { left: calc(12px + var(--safe-l)); bottom: calc(34px + var(--safe-b)); padding: 7px 14px; font-size: 12px; color: var(--ink-2); display: flex; flex-wrap: wrap; gap: 4px 16px; max-width: calc(100% - 150px - var(--safe-l) - var(--safe-r)); }
.telemetry b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.telemetry .lit { color: #fde68a; } .telemetry .dark { color: #c4b5fd; }
/* One line on phones too: the speed label gives way first. */
.preview-bar { left: 50%; transform: translateX(-50%); bottom: calc(34px + var(--safe-b)); box-sizing: border-box;
  width: min(550px, calc(100% - 24px)); padding: 10px 14px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.preview-bar .row { display: flex; align-items: center; gap: 12px; white-space: nowrap; font-size: 12.5px; color: var(--ink-2); }
.preview-bar .pv-speed { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
:host([compact]) .preview-bar .row { gap: 8px; }
.preview-bar .row b { color: var(--ink); font-variant-numeric: tabular-nums; }
.preview-bar .tag { font-size: 10.5px; letter-spacing: .14em; color: #f0abfc; font-weight: 700; }
.preview-bar .btn { margin-left: auto; }
.preview-bar .bar { height: 4px; border-radius: 4px; background: rgba(148,163,184,.2); overflow: hidden; }
.preview-bar .fill { height: 100%; width: 0; background: linear-gradient(90deg, #f0abfc, #fcd34d); border-radius: 4px; }
.sky-pop { top: calc(12px + var(--safe-t)); right: calc(56px + var(--safe-r)); padding: 12px 14px; cursor: pointer; }
.sky-pop .close { position: absolute; top: 6px; right: 8px; width: 28px; height: 28px; border: 0; border-radius: 50%;
  background: rgba(148,163,184,.16); color: var(--ink); font-size: 18px; line-height: 1; cursor: pointer; }
.sky-pop .close:hover { background: rgba(148,163,184,.3); }
.loader { inset: 0; display: grid; place-items: center; text-align: center; color: var(--ink-2); font-size: 13.5px; pointer-events: none; padding: 0 24px; }
.loader .orbit { width: 64px; height: 64px; margin: 0 auto 14px; border-radius: 50%; border: 1px solid rgba(125,211,252,.35); position: relative;
  background: radial-gradient(circle at 40% 35%, #1d4ed8, #0b1a3a 70%); box-shadow: 0 0 24px rgba(56,189,248,.35); }
.loader .orbit::after { content: ""; position: absolute; top: -4px; left: 50%; width: 8px; height: 8px; margin-left: -4px; border-radius: 50%;
  background: #fde68a; box-shadow: 0 0 10px #fde68a; transform-origin: 4px 36px; animation: spin 2.2s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes ping { 0% { box-shadow: 0 0 0 0 rgba(var(--ping),.55); } 80%, 100% { box-shadow: 0 0 0 8px rgba(var(--ping),0); } }
/* box-shadow cannot be animated on the compositor, so pulse only briefly,
   and continuously only while the station is up or a preview is playing. */
@media (prefers-reduced-motion: no-preference) {
  .mission .top .live { animation: ping 2s ease-out 3; }
  .mission.now .top .live, .mission.preview .top .live { animation: ping 2s ease-out infinite; }
}
.home { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center;
  background: var(--primary-color, #03a9f4); border: 2px solid #fff; box-shadow: 0 0 0 5px rgba(3,169,244,.22), 0 2px 8px rgba(0,0,0,.55); }
.home svg { width: 15px; height: 15px; fill: #fff; }
.maplibregl-marker-covered { pointer-events: none; }
/* Above the HUD, so the imagery menu that opens beside the buttons is not covered. */
.maplibregl-ctrl-top-right { margin: var(--safe-t) var(--safe-r) 0 0; z-index: 3; }
.maplibregl-ctrl-bottom-right { margin: 0 var(--safe-r) var(--safe-b) 0; }
.maplibregl-ctrl-bottom-left { margin: 0 0 var(--safe-b) var(--safe-l); }
.maplibregl-ctrl-group { background: rgba(15,23,42,.78) !important; border: 1px solid var(--edge); box-shadow: 0 6px 18px rgba(0,0,0,.35) !important;
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border-radius: 10px !important; overflow: hidden; }
.maplibregl-ctrl-group button + button { border-top: 1px solid rgba(148,163,184,.18) !important; }
.maplibregl-ctrl-group button:not([aria-pressed="true"]):hover { background-color: rgba(56,189,248,.18) !important; }
.maplibregl-ctrl button .maplibregl-ctrl-icon { filter: invert(1) brightness(1.4); }
/* The view controls hold the imagery menu, so they round their buttons instead of clipping. */
.maplibregl-ctrl-group.ctrl { overflow: visible; }
.ctrl button { width: 29px; height: 29px; display: grid; place-items: center; }
.ctrl button:first-of-type { border-radius: 9px 9px 0 0; }
.ctrl button:last-of-type { border-radius: 0 0 9px 9px; }
.ctrl button svg { width: 18px; height: 18px; fill: #e2e8f0; }
.ctrl button[aria-pressed="true"] { background-color: var(--sky) !important; }
.ctrl button[aria-pressed="true"] svg { fill: #0f172a; }
.ctrl select { position: absolute; right: 34px; top: 0; font: inherit; font-size: 12px; padding: 5px; border-radius: 8px; background: #0f172a; color: var(--ink); border: 1px solid var(--edge); box-shadow: 0 6px 18px rgba(0,0,0,.45); }
/* Too short for the whole column: drop the fullscreen button rather than cover it. */
:host([short]) .maplibregl-ctrl-group:has(> .maplibregl-ctrl-fullscreen) { display: none; }
.loader .reload-btn { pointer-events: auto; margin-top: 12px; }
.maplibregl-ctrl-attrib { background: rgba(15,23,42,.62) !important; color: var(--ink-2) !important; }
.maplibregl-ctrl-attrib a { color: #e2e8f0 !important; }
.maplibregl-ctrl-attrib-button { filter: invert(1); }
:host([compact]) .mission { padding: 10px 12px; width: min(346px, calc(100% - 64px - var(--safe-l) - var(--safe-r))); }
:host([compact]) .mission .clock { font-size: 26px; }
:host([compact]) .mission.now .clock, :host([compact]) .mission.paused .clock { font-size: 20px; }
:host([compact]) .mission .detail { display: none; }
:host([compact]) .mission .intercept { font-size: 11.5px; margin-top: 8px; padding-top: 8px; }
:host([compact]) .mission .actions { margin-top: 8px; }
:host([compact]) .btn { padding: 4px 10px 4px 8px; font-size: 12px; }
:host([compact]) .side { display: none; }
:host([compact]) .telemetry { font-size: 11px; padding: 6px 10px; gap: 2px 10px; max-width: calc(100% - 70px - var(--safe-l) - var(--safe-r)); }
:host([compact]) .telemetry .opt { display: none; }
/* Touch screens with room for it: bigger map buttons. */
:host([roomy]) .maplibregl-ctrl-group button, :host([roomy]) .ctrl button { width: 40px; height: 40px; }
:host([roomy]) .ctrl select { right: 45px; }
:host([roomy]) .side, :host([roomy]) .sky-pop { right: calc(68px + var(--safe-r)); }
:host([roomy]) .mission { width: min(406px, calc(100% - 76px - var(--safe-l) - var(--safe-r))); }
:host([roomy][compact]) .mission { width: min(346px, calc(100% - 76px - var(--safe-l) - var(--safe-r))); }
@media (max-width: 760px) { .mission .clock { font-size: 28px; } .telemetry .opt { display: none; } .preview-bar .row { gap: 8px; } }
`;

let starsUrl;
function starField() {
  // A faint, fixed starfield drawn once per page; purely decorative. A
  // software canvas: the image is read back once, which stalls a GPU canvas.
  if (starsUrl) return starsUrl;
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  let seed = 25544;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 300; i++) {
    const r = rnd() < 0.07 ? 1.1 : 0.55;
    ctx.fillStyle = `rgba(${rnd() < 0.2 ? "200,220,255" : "255,255,255"},${0.2 + rnd() * 0.65})`;
    ctx.beginPath();
    ctx.arc(rnd() * 512, rnd() * 512, r, 0, 2 * Math.PI);
    ctx.fill();
  }
  starsUrl = `url(${c.toDataURL()})`;
  return starsUrl;
}

const BaseElement = globalThis.HTMLElement ?? class {};

export class IssGlobeView extends BaseElement {
  static get observedAttributes() {
    return ["compact"];
  }

  constructor() {
    super();
    this._config = {};
    this._mode = "free";
    this._flat = false;
    this._timers = [];
    this._labels = new Map();
    this._fmtCache = new Map();
    // What each sky chart element shows, so an unchanged chart is not drawn again.
    this._skyCharts = new WeakMap();
    this._numCache = new Map();
    // English until Home Assistant's language has loaded (see _useLanguage).
    this._strings = english;
    this._language = "en";
    this._languageReady = Promise.resolve();
    this._clockOffset = 0;
    this._gen = 0;
    // Home Assistant tiles to fetch again, by source: Map of "z/x/y" -> {x, y, z}.
    this._failedTiles = {};
    // Set by the card while Home Assistant shows it in an editor preview.
    this.editorPreview = false;
    // Set by the card: use the compact layout whenever the globe is narrow
    // (decided here, from the globe's own size, so fullscreen gets the full one).
    this.autoCompact = false;
    this._onVisibility = () => (document.hidden ? this._pause() : this._resume());
    // Work put off while the globe cannot be seen, by kind (see _whenShown).
    this._pendingShown = new Map();
    this._onReady = () =>
      this._whenShown("ready", () => {
        // Home Assistant is back after a restart or a dropped connection.
        this._staleDelay = this._staleRetryAt = 0;
        if (!this._map) {
          if (this.isConnected) this._start();
          return;
        }
        this._refreshMapToken(true);
        this._refresh();
      });
  }

  set hass(hass) {
    const old = this._hass;
    this._hass = hass;
    this._useLanguage(hass);
    // Home Assistant replaces the locale object only when a setting changes.
    const localeChanged =
      !!old && (hass?.locale !== old.locale || hass?.config?.time_zone !== old.config?.time_zone);
    if (localeChanged) {
      this._fmtCache.clear();
      this._numCache.clear();
    }
    if (this.isConnected) this._watchConnection();
    if (!old) {
      if (this.isConnected) this._start();
    } else if (localeChanged && this._loaded && this._payload) {
      for (const [key, el] of this._labels) {
        if (key.startsWith("tick-")) {
          el.remove();
          this._labels.delete(key);
        }
      }
      this._buildCourse();
      this._renderUpcoming();
      this._renderSky(true);
      this._tick();
    }
  }

  get hass() {
    return this._hass;
  }

  set config(config) {
    const previous = this._config;
    this._config = { ...config };
    const moved = previous.entry_id !== config.entry_id;
    if (moved) this._locationChanged();
    if (!this._map) {
      // Waiting to retry (or not started): try the new location straight away.
      if (moved && this._hass && this.isConnected) this._start();
      return;
    }
    // The camera flies to the new home when its data arrives (see _refresh).
    if (moved) this._refresh(true);
    if (previous.imagery !== config.imagery) this._setImagery(config.imagery);
  }

  attributeChangedCallback() {
    // A card toggles "compact" from its own size; lay out again a frame later.
    if (this._layoutFrame || !this._els) return;
    this._layoutFrame = requestAnimationFrame(() => {
      this._layoutFrame = null;
      this._applyLayout();
    });
  }

  connectedCallback() {
    clearTimeout(this._teardownTimer);
    document.addEventListener("visibilitychange", this._onVisibility);
    if (this._hass) {
      this._watchConnection();
      this._start();
    }
    this._observeVisibility();
    this._resume();
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this._onVisibility);
    this._unwatchConnection();
    this._pause();
    this._intersection?.disconnect();
    clearTimeout(this._retryTimer);
    clearTimeout(this._refreshTimer);
    clearTimeout(this._teardownTimer);
    // Coming back starts, or refreshes, whatever is needed then.
    this._pendingShown.clear();
    // Free the WebGL context if the view stays away (dashboards rebuild cards).
    // The card editor replaces its preview on every change and drops the old
    // card: let that go now. Masonry views in edit mode put their cards back
    // over several frames, so other previews get a moment rather than 30 s.
    const dropped = this.getRootNode?.().host?.parentNode === null;
    this._teardownTimer = setTimeout(
      () => !this.isConnected && this._teardown(),
      this.editorPreview ? (dropped ? 0 : 2000) : 30000
    );
  }

  // -- lifecycle ----------------------------------------------------------

  _buildDom() {
    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <link rel="stylesheet" href="${new URL("maplibre-gl.css", MAPLIBRE_DIR).href}">
      <style>${STYLE}${SKY_STYLE}</style>
      <div class="wrap" part="globe">
        <div id="map"></div>
        <div class="labels"></div>
        <section class="hud mission glass" hidden data-t-label="globe.name">
          <div class="top"><span class="live"></span><span class="label"></span><span class="chip" hidden></span></div>
          <div class="clock"></div>
          <div class="when"></div>
          <div class="detail"></div>
          <div class="intercept" hidden><span class="ring"></span><span class="txt"></span></div>
          <div class="actions">
            <button class="btn gold preview-btn" type="button" data-t-title="mission.preview_hint">${svgIcon("play")}<span class="long" data-t="mission.preview"></span><span class="short" data-t="mission.preview_short"></span></button>
            <button class="btn look-btn" type="button" data-t-title="mission.look_hint" aria-expanded="false">${svgIcon("eye")}<span class="long" data-t="mission.look"></span><span class="short" data-t="mission.look_short"></span></button>
          </div>
          <div class="sr-only announce" aria-live="polite"></div>
        </section>
        <aside class="hud side" hidden>
          <div class="glass sky"><h3 data-t="mission.look"></h3><div class="sub"></div><div class="chart"></div><div class="caption"></div></div>
          <div class="glass upcoming"><h3 data-t="upcoming.title"></h3><ol></ol></div>
        </aside>
        <div class="hud glass sky sky-pop" hidden role="dialog" data-t-label="mission.look">
          <button class="close" type="button" data-t-label="globe.close" data-t-title="globe.close">×</button>
          <h3 data-t="mission.look"></h3><div class="sub"></div><div class="chart"></div><div class="caption"></div></div>
        <div class="hud glass telemetry" hidden></div>
        <div class="hud glass preview-bar" hidden>
          <div class="row"><span class="tag" data-t="preview.tag"></span><span class="pv-time"></span><span class="pv-speed"></span>
            <button class="btn live-btn" type="button" data-t="preview.back"></button></div>
          <div class="bar"><div class="fill"></div></div>
        </div>
        <div class="hud loader"><div><div class="orbit"></div><div class="msg"></div>
          <button class="btn reload-btn" type="button" hidden data-t="globe.reload"></button></div></div>
      </div>`;
    const $ = (sel) => root.querySelector(sel);
    this._wrap = $(".wrap");
    this._wrap.style.setProperty("--iss-stars", starField());
    this._els = {
      map: $("#map"),
      labels: $(".labels"),
      mission: $(".mission"),
      label: $(".mission .label"),
      chip: $(".mission .chip"),
      clock: $(".mission .clock"),
      when: $(".mission .when"),
      detail: $(".mission .detail"),
      intercept: $(".mission .intercept"),
      interceptTxt: $(".mission .intercept .txt"),
      announce: $(".mission .announce"),
      previewBtn: $(".preview-btn"),
      lookBtn: $(".look-btn"),
      side: $(".side"),
      skySide: $(".side .sky"),
      skyPop: $(".sky-pop"),
      upcoming: $(".upcoming ol"),
      upcomingBox: $(".upcoming"),
      telemetry: $(".telemetry"),
      previewBar: $(".preview-bar"),
      liveBtn: $(".live-btn"),
      pvTime: $(".pv-time"),
      pvSpeed: $(".pv-speed"),
      pvFill: $(".preview-bar .fill"),
      loader: $(".loader"),
      loaderMsg: $(".loader .msg"),
      reloadBtn: $(".loader .reload-btn"),
    };
    this._els.loaderMsg.textContent = this._t("globe.acquiring");
    this._applyStrings();
    this._els.reloadBtn.addEventListener("click", () => location.reload());
    this._els.previewBtn.addEventListener("click", () => this._startPreview());
    this._els.lookBtn.addEventListener("click", () => {
      this._skyOpen = !this._skyOpen;
      this._renderSky(true);
    });
    this._els.liveBtn.addEventListener("click", () => this._stopPreview());
    // Tapping the popover (or its close button) puts it away again.
    this._els.skyPop.addEventListener("click", () => {
      this._skyOpen = false;
      this._renderSky(false);
    });
    // A tap anywhere else puts the imagery menu away.
    this._wrap.addEventListener(
      "pointerdown",
      (ev) => {
        const path = ev.composedPath();
        if (this._menu && !path.includes(this._menu) && !path.includes(this._buttons?.layers)) {
          this._toggleImageryMenu();
        }
      },
      true
    );
    // Escape closes the imagery menu or the sky chart, or ends a preview.
    this._wrap.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || ev.defaultPrevented) return;
      if (this._menu) {
        this._toggleImageryMenu();
      } else if (this._preview) {
        this._stopPreview();
      } else if (this._skyOpen && !this._els.skyPop.hidden) {
        this._skyOpen = false;
        this._renderSky(false);
        this._els.lookBtn.focus();
      } else {
        return;
      }
      ev.preventDefault();
      // A card shown inside a Home Assistant dialog must not close it too.
      ev.stopPropagation();
    });
  }

  /**
   * Switch to Home Assistant's language, downloading its text the first time;
   * what is on screen is reworded once it is in. If the download fails, the
   * text stays English and the language is tried again after a minute.
   */
  _useLanguage(hass) {
    const language = resolveLanguage(hass?.language || hass?.locale?.language);
    const retry = this._strings.language !== language && !(performance.now() - this._languageAt < 60000);
    if (language === this._language && !retry) return this._languageReady;
    this._language = language;
    this._languageAt = performance.now();
    this._languageReady = loadStrings(language)
      .then((strings) => {
        if (this._language !== language || strings === this._strings) return;
        this._strings = strings;
        this._applyStrings();
      })
      // Never rejects: starting the globe waits on it.
      .catch((err) => console.error("ISS Tracker: could not apply the language:", err));
    return this._languageReady;
  }

  /** Put the text into the page in the current language, and redraw what shows it. */
  _applyStrings() {
    const root = this.shadowRoot;
    if (!this._els || !root) return;
    for (const el of root.querySelectorAll("[data-t]")) setText(el, this._t(el.dataset.t));
    for (const el of root.querySelectorAll("[data-t-title]")) el.title = this._t(el.dataset.tTitle);
    for (const el of root.querySelectorAll("[data-t-label]")) el.setAttribute("aria-label", this._t(el.dataset.tLabel));
    // The imagery menu is worded when it opens.
    if (this._menu) this._toggleImageryMenu();
    if (!this._loaded || !this._payload) return;
    for (const id of ["label-country", "label-places"]) {
      if (this._map.getLayer(id)) this._map.setLayoutProperty(id, "text-field", this._placeNames());
    }
    this._buildCourse();
    this._renderUpcoming();
    this._renderSky(true);
    this._tick();
  }

  async _start() {
    if (this._starting || this._map) return;
    this._starting = true;
    clearTimeout(this._retryTimer);
    const maplibre = loadMapLibre();
    // Everything on screen in the user's language from the start.
    await this._useLanguage(this._hass);
    if (!this._els) this._buildDom();
    let gen = this._gen;
    try {
      const [ml] = await Promise.all([maplibre, this._refresh(), this._refreshMapToken()]);
      if (!this.isConnected || this._map) {
        // Taken off the page meanwhile; connectedCallback starts it again.
        this._starting = false;
        return;
      }
      const wanted = this._config.entry_id;
      if (gen !== this._gen || (wanted && this._payload && this._payload.location.entry_id !== wanted)) {
        // The location changed while this was loading, perhaps more than once.
        do {
          gen = this._gen;
          await this._refresh(true);
          if (!this.isConnected || this._map) {
            this._starting = false;
            return;
          }
        } while (gen !== this._gen);
      }
      this._ml = ml;
      const wantedNow = this._config.entry_id;
      if (!this._payload || (wantedNow && this._payload.location.entry_id !== wantedNow)) {
        // Not set up yet, or still starting: try again shortly. That includes
        // a location that could not be fetched yet, whose name must not go on
        // another one's data. A deleted location waits for a new one instead
        // (see set config). The start asks for the data itself.
        this._starting = false;
        clearTimeout(this._refreshTimer);
        if (!this._gone) this._retry(30000);
        return;
      }
      this._createMap();
    } catch (err) {
      this._starting = false;
      const why = this._errorMessage(err);
      if (mapLibreNeedsReload()) {
        // A file that keeps failing (or one the browser now refuses to fetch again).
        this._showMessage(this._t("globe.load_failed", { error: why }), { reload: true });
      } else {
        this._showMessage(this._t("globe.load_retrying", { error: why }));
        this._retry(30000 * 2 ** Math.max(0, maplibreAttempt - 1));
      }
    }
  }

  _retry(ms) {
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._whenShown("start", () => this._start()), ms);
  }

  /**
   * Run fn now if the globe can be seen, else once it can be: retries and the
   * like wait rather than keep asking Home Assistant for a hidden tab or a
   * card scrolled out of view. Only the latest fn of each kind is kept.
   */
  _whenShown(kind, fn) {
    if (this._shown()) fn();
    else this._pendingShown.set(kind, fn);
  }

  _shown() {
    return this.isConnected && !document.hidden && this._onScreen !== false;
  }

  _runPendingShown() {
    if (!this._shown()) return;
    const pending = [...this._pendingShown.values()];
    this._pendingShown.clear();
    for (const fn of pending) fn();
  }

  _teardown() {
    this._stopPreview(true);
    this._previewPending = null;
    this._pause();
    this._resizeObserver?.disconnect();
    clearTimeout(this._lightsTimer);
    clearTimeout(this._tilesTimer);
    clearTimeout(this._contextTimer);
    this._failedTiles = {};
    this._menu?.remove();
    this._menu = null;
    this._homeMarker?.remove();
    this._homeMarker = null;
    // Leave fullscreen with the map, or the next one would start covering the screen.
    if (this._wrap?.classList.contains("maplibregl-pseudo-fullscreen")) {
      this._wrap.classList.remove("maplibregl-pseudo-fullscreen");
    } else if (this._wrap && this.shadowRoot?.fullscreenElement === this._wrap) {
      document.exitFullscreen?.().catch(() => {});
    }
    this.removeAttribute("fullscreen");
    // map.remove() does not call the layers' onRemove: free the decoded lights here.
    this._night?.releaseLights();
    try {
      this._map?.remove();
    } catch {
      // Already gone.
    }
    this._map = null;
    this._loaded = false;
    this._starting = false;
    this._space = this._night = null;
    for (const el of this._labels.values()) el.remove();
    this._labels.clear();
  }

  _observeVisibility() {
    if (!globalThis.IntersectionObserver) return;
    this._intersection ??= new IntersectionObserver((entries) => {
      this._onScreen = entries[entries.length - 1].isIntersecting;
      if (this._onScreen) this._resume();
      else this._pause();
    });
    this._intersection.observe(this);
  }

  _watchConnection() {
    const connection = this._hass?.connection;
    if (!connection || connection === this._connection) return;
    this._unwatchConnection();
    this._connection = connection;
    connection.addEventListener?.("ready", this._onReady);
  }

  _unwatchConnection() {
    this._connection?.removeEventListener?.("ready", this._onReady);
    this._connection = null;
  }

  _resume() {
    this._runPendingShown();
    if (!this.isConnected || !this._map || !this._loaded || this._running || document.hidden || this._onScreen === false) {
      return;
    }
    this._running = true;
    this._timers.push(setInterval(() => this._tick(), 1000));
    this._timers.push(setInterval(() => this._refresh(), 5 * 60 * 1000));
    this._timers.push(setInterval(() => this._refreshMapToken(), 10 * 60 * 1000));
    this._timers.push(setInterval(() => this._updateLight(), 30 * 1000));
    // Back after a while: tiles tokens last 30-60 minutes, and passes move on.
    if (!(performance.now() - this._mapTokenAt < 10 * 60 * 1000)) this._refreshMapToken();
    // Also when the data is another location's: a switch that failed while
    // the globe was away (whose retry went with it) is tried again now.
    const elsewhere = !!this._config.entry_id && this._payload?.location.entry_id !== this._config.entry_id;
    if (elsewhere || !(performance.now() - this._payloadAt < 5 * 60 * 1000)) this._refresh();
    this._updateLight();
    this._map.resize();
    this._mapSize = [this._els.map.clientWidth, this._els.map.clientHeight];
    this._frame();
    this._scheduleFrames();
    this._tick();
  }

  _pause() {
    this._running = false;
    this._timers.forEach(clearInterval);
    this._timers = [];
    // Not while away: the first tick after resuming asks again if need be.
    clearTimeout(this._passRefreshTimer);
    this._refreshedAfter = null;
    clearTimeout(this._frameTimer);
    cancelAnimationFrame(this._raf);
    this._frameTimer = this._raf = null;
  }

  /** Redraw often enough for smooth motion, and no more. */
  _scheduleFrames() {
    clearTimeout(this._frameTimer);
    cancelAnimationFrame(this._raf);
    this._frameTimer = this._raf = null;
    if (!this._running) return;
    const run = () => {
      this._frameTimer = this._raf = null;
      this._frame();
      // _frame() may already have rescheduled (a preview that just ended).
      if (this._frameTimer === null && this._raf === null) this._scheduleFrames();
    };
    const delay = this._frameDelay();
    if (delay === 0) this._raf = requestAnimationFrame(run);
    else this._frameTimer = setTimeout(run, delay);
  }

  _frameDelay() {
    // Kept for _frame: 0 while the station is out of sight.
    this._speed = this._screenSpeed();
    return frameDelay(this._speed, { chase: this._mode === "chase", preview: !!this._preview });
  }

  /** How fast the station moves across the screen, in CSS pixels per second (0 when off screen). */
  _screenSpeed() {
    const rows = this._payload?.track;
    if (!rows || !this._space || !this._mapSize || this._preview) return 0;
    const t = this._simNow();
    const a = positionAt(rows, t);
    const b = positionAt(rows, t + 1);
    if (!a || !b) return 0;
    const [w, h] = this._mapSize;
    const pa = this._space.project(a.lat, a.lon, a.alt * 1000, w, h);
    const pb = this._space.project(b.lat, b.lon, b.alt * 1000, w, h);
    return pa && pb ? Math.hypot(pb.x - pa.x, pb.y - pa.y) : 0;
  }

  _showMessage(text, { spinner = false, reload = false } = {}) {
    if (!this._els) return;
    this._els.loaderMsg.textContent = text;
    this._els.loader.hidden = !text;
    this._els.loader.querySelector(".orbit").hidden = !spinner;
    this._els.reloadBtn.hidden = !reload;
  }

  /** Short notice from Home Assistant's own toast. */
  _notify(message) {
    this.dispatchEvent(
      new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true })
    );
  }

  // -- data -----------------------------------------------------------------

  /** Home Assistant's time, in ms; corrects a device clock that is off. */
  _now() {
    return Date.now() + this._clockOffset;
  }

  _syncClock(serverTime, sentMs, receivedMs) {
    if (typeof serverTime !== "number" || receivedMs - sentMs > 2000) return;
    const offset = serverTime * 1000 - (sentMs + receivedMs) / 2;
    // Most clocks agree to well under a second; only correct one that shows.
    // Once correcting, carry on until the clock is within a second, so one
    // about two seconds off does not make the countdown jump back and forth.
    const limit = this._clockOffset ? 1000 : 2000;
    this._clockOffset = Math.abs(offset) > limit ? offset : 0;
  }

  /** Fetch the track and passes; resolves true once fresh data is in. */
  async _refresh(force = false) {
    if (!this._hass || (this._fetching && !force)) return false;
    this._fetching = true;
    const gen = this._gen;
    const msg = { type: "iss_tracker/track" };
    if (this._config.entry_id) msg.entry_id = this._config.entry_id;
    let payload;
    let relocated;
    try {
      const sent = Date.now();
      payload = await this._hass.callWS(msg);
      if (gen !== this._gen) return false; // The location changed meanwhile.
      this._syncClock(payload.server_time, sent, Date.now());
      relocated = !!this._payload && payload.location.entry_id !== this._payload.location.entry_id;
      this._gone = false;
      this._payload = payload;
      this._payloadAt = performance.now();
      this._refreshDelay = 0;
      clearTimeout(this._refreshTimer);
    } catch (err) {
      if (gen !== this._gen) return false;
      const code = this._errorCode(err);
      // A deleted location does not come back: say so now (the old data stays
      // underneath), and let the panel pick another one.
      this._gone = code === "unknown_location";
      if (this._gone) this.dispatchEvent(new CustomEvent("location-gone", { detail: msg.entry_id }));
      // Otherwise keep showing what we have while it still covers the present,
      // unless it is a location that was just switched away from.
      const elsewhere = !!this._config.entry_id && !!this._payload && this._payload.location.entry_id !== this._config.entry_id;
      if (this._gone || !this._payload || elsewhere || !positionAt(this._payload.track, this._now() / 1000)) {
        this._showMessage(this._errorText(err), { spinner: code === "not_ready" || code === 3 });
      }
      if (elsewhere && !this._gone) this._retryRefresh();
      return false;
    } finally {
      if (gen === this._gen) this._fetching = false;
    }
    if (!this._loaded) return true;
    // Drawn apart from the request: a drawing bug is not a failed request, so
    // it is not shown as one, and the new data stays in.
    try {
      if (relocated && this._preview) {
        // A preview of the old location's pass.
        this._stopPreview(true);
        this._scheduleFrames();
        this._updateLight();
      }
      this._showMessage(positionAt(payload.track, this._now() / 1000) ? "" : this._t("globe.clock_off"));
      this._buildCourse();
      this._renderUpcoming();
      this._renderSky(true);
      this._tick();
      if (relocated) this._setMode("home");
    } catch (err) {
      console.error("ISS Tracker: could not draw the new data:", err);
    }
    return true;
  }

  /** Try the new location again soon, backing off while it keeps failing. */
  _retryRefresh() {
    clearTimeout(this._refreshTimer);
    this._refreshDelay = Math.min(Math.max(2 * (this._refreshDelay || 0), 3000), 5 * 60 * 1000);
    this._refreshTimer = setTimeout(() => this._whenShown("refresh", () => this._refresh()), this._refreshDelay);
  }

  // Errors from Home Assistant's websocket come as {code, message}; a dropped
  // connection can also come as a bare number (3) or wrapped in {error}.
  _errorCode(err) {
    const e = err?.error ?? err;
    return typeof e === "number" ? e : e?.code;
  }

  _errorMessage(err) {
    const e = err?.error ?? err;
    if (typeof e === "string") return e;
    if (e?.message) return e.message;
    const code = this._errorCode(err);
    if (code === 3) return this._t("globe.connection_lost");
    if (code !== undefined) return String(code);
    try {
      return JSON.stringify(e)?.slice(0, 200) ?? String(e);
    } catch {
      return String(e);
    }
  }

  _errorText(err) {
    switch (this._errorCode(err)) {
      case 3:
        return this._t("globe.reconnecting");
      case "not_found":
        return this._t("globe.not_set_up");
      case "unknown_location":
        return this._t(this._config.panel ? "globe.location_gone_panel" : "globe.location_gone_card");
      case "location_disabled":
        return this._t("globe.location_disabled");
      case "not_ready": {
        // The integration's own reason, unless it only says that it is waiting.
        const why = this._errorMessage(err);
        return why && !/^waiting/i.test(why) ? this._t("globe.waiting_because", { reason: why }) : this._t("globe.waiting");
      }
      default:
        return this._t("globe.position_failed", { error: this._errorMessage(err) });
    }
  }

  /** The track has run out: fetch a new one, backing off while that keeps failing. */
  _refreshStale() {
    const now = performance.now();
    if (now < (this._staleRetryAt || 0)) return;
    this._staleDelay = Math.min(Math.max(2 * (this._staleDelay || 0), 3000), 10 * 60 * 1000);
    this._staleRetryAt = now + this._staleDelay;
    this._refresh();
  }

  async _refreshMapToken(retryTiles = false) {
    if (!this._hass) return;
    try {
      const { token } = await this._hass.callWS({ type: "map_tiles/access_token" });
      this._mapToken = token;
      this._mapTokenAt = performance.now();
      if (retryTiles) {
        this._refreshHaTiles();
        // Requests already under way with the old token fail a moment later.
        clearTimeout(this._tilesTimer);
        this._tilesTimer = setTimeout(() => this._refreshHaTiles(), 2000);
      }
    } catch (err) {
      // Keep a token that may still be valid; only an older Home Assistant has none.
      if (this._errorCode(err) === "unknown_command") this._mapToken = null;
    }
  }

  /**
   * Fetch again the Home Assistant tiles that failed (an expired token, or a
   * restart). They are named one by one: refreshing a whole vector source
   * leaves its failed tiles waiting for a reply that never comes.
   */
  _refreshHaTiles() {
    const map = this._map;
    if (!map || !this._loaded) return;
    for (const [id, tiles] of Object.entries(this._failedTiles)) {
      if (!tiles.size || !map.getSource(id)) continue;
      try {
        map.refreshTiles(id, [...tiles.values()]);
      } catch {
        // The source changed meanwhile.
      }
      tiles.clear();
    }
  }

  _haTilesAvailable() {
    return !!this._mapToken || !!this._hass?.config?.components?.includes?.("map_tiles");
  }

  async _path(start, end, step) {
    const msg = { type: "iss_tracker/path", start: new Date(start * 1000).toISOString(), end: new Date(end * 1000).toISOString(), step };
    const entry = this._payload?.location?.entry_id ?? this._config.entry_id;
    if (entry) msg.entry_id = entry;
    return (await this._hass.callWS(msg)).track;
  }

  /** Approach to the next pass over home (the last part of the orbit leading into it). */
  async _loadApproach() {
    const next = this._payload?.next_pass;
    const now = this._now() / 1000;
    const rise = next ? Date.parse(next.rise) / 1000 : 0;
    if (!next || rise - now > 36 * 3600) {
      this._clearApproach();
      return;
    }
    if (this._approachFor === next.rise) return;
    this._approachFor = next.rise;
    if (rise <= now) {
      this._clearApproach();
      return;
    }
    const gen = this._gen;
    try {
      const rows = await this._path(Math.max(now, rise - 50 * 60), rise, 30);
      if (gen !== this._gen || this._approachFor !== next.rise) return;
      this._approach = rows;
      if (this._loaded && !this._preview) {
        this._space.setLine("approach", rows, this._baseT);
        this._courseChanged = true;
      }
    } catch {
      if (gen !== this._gen) return;
      // Ask again with the next refresh: the location may have been reloading.
      if (this._approachFor === next.rise) this._approachFor = null;
      this._clearApproach();
    }
  }

  _clearApproach() {
    this._approach = [];
    if (this._loaded && !this._preview && this._space) {
      this._space.setLine("approach", [], 0);
      this._courseChanged = true;
    }
  }

  /** A different location: drop everything that belonged to the old one. */
  _locationChanged() {
    this._gen++;
    this._fetching = false;
    this._gone = false;
    // The back-off was for the old location; the new one starts afresh.
    clearTimeout(this._refreshTimer);
    this._refreshDelay = 0;
    this._previewPending = null;
    this._approachFor = null;
    this._clearApproach();
    if (this._preview) {
      this._stopPreview(true);
      this._scheduleFrames();
      this._updateLight();
    }
  }

  _haUrl(path) {
    // Built by hand: URL() would escape the {z}/{x}/{y} placeholders.
    const base = this._hass?.hassUrl ? this._hass.hassUrl("") : location.origin;
    return base.replace(/\/+$/, "") + path;
  }

  // -- map ------------------------------------------------------------------

  _imageryKey() {
    let key = this._config.imagery || "satellite";
    key = IMAGERY_ALIASES[key] || key;
    if (!IMAGERY[key] || (IMAGERY[key].homeAssistantTiles && !this._haTilesAvailable())) return "satellite";
    return key;
  }

  _closeupSource(key) {
    const def = IMAGERY[key];
    return {
      type: "raster",
      tiles: def.homeAssistantTiles ? [this._haUrl(def.homeAssistantTiles)] : def.tiles,
      tileSize: 256,
      maxzoom: def.maxzoom,
      attribution: def.attribution,
    };
  }

  _labelsWanted() {
    return this._config.labels !== false && this._haTilesAvailable();
  }

  _buildStyle() {
    this._closeupKey = this._imageryKey();
    const sources = {
      bluemarble: BLUE_MARBLE,
      closeup: this._closeupSource(this._closeupKey),
    };
    const layers = [
      { id: "closeup", type: "raster", source: "closeup", minzoom: 4.4, paint: { "raster-fade-duration": 200 } },
      {
        id: "bluemarble", type: "raster", source: "bluemarble", maxzoom: 7,
        paint: {
          "raster-fade-duration": 200,
          "raster-opacity": ["interpolate", ["linear"], ["zoom"], 5, 1, 6.5, 0],
        },
      },
    ];
    const style = {
      version: 8,
      projection: { type: this._flat ? "mercator" : GLOBE_PROJECTION },
      light: sunLight(new Date(this._now())),
      sky: {
        "sky-color": "#04091c",
        "horizon-color": "#1e3a8a",
        "fog-color": "#0b1a3a",
        "sky-horizon-blend": 0.6,
        "horizon-fog-blend": 0.4,
        // Enough for a glowing limb without washing out the day side.
        "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.4, 5, 0.4, 7, 0],
      },
      sources,
      layers,
    };

    if (this._labelsWanted()) {
      style.glyphs = this._haUrl("/api/map_tiles/fonts/{fontstack}/{range}.pbf");
      sources.osm = {
        type: "vector",
        tiles: [this._haUrl("/api/map_tiles/vector/{z}/{x}/{y}.mvt")],
        maxzoom: 14,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      };
      layers.push(
        {
          id: "borders-country", type: "line", source: "osm", "source-layer": "boundaries",
          filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], true]],
          paint: {
            "line-color": "rgba(255,255,255,0.42)",
            "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.4, 6, 1.2],
          },
        },
        {
          id: "borders-state", type: "line", source: "osm", "source-layer": "boundaries", minzoom: 3.5,
          filter: ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], true]],
          paint: { "line-color": "rgba(255,255,255,0.26)", "line-width": 0.8, "line-dasharray": [3, 2] },
        },
        {
          id: "roads", type: "line", source: "osm", "source-layer": "streets", minzoom: 9,
          filter: ["in", ["get", "kind"], ["literal", ["motorway", "trunk", "primary", "secondary"]]],
          paint: {
            "line-color": "rgba(253, 230, 138, 0.42)",
            "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.6, 14, 2.2],
          },
        }
      );
      const halo = { "text-color": "#f8fafc", "text-halo-color": "rgba(0,0,0,0.85)", "text-halo-width": 1.4 };
      const name = this._placeNames();
      layers.push(
        {
          id: "label-country", type: "symbol", source: "osm", "source-layer": "boundary_labels",
          minzoom: 2, maxzoom: 7,
          filter: ["==", ["get", "admin_level"], 2],
          layout: {
            "text-field": name, "text-font": ["noto_sans_bold"], "text-transform": "uppercase",
            "text-letter-spacing": 0.1, "text-size": ["interpolate", ["linear"], ["zoom"], 2, 9.5, 6, 13],
            "text-max-width": 8,
          },
          paint: { ...halo, "text-color": "rgba(248,250,252,0.72)" },
        },
        {
          id: "label-places", type: "symbol", source: "osm", "source-layer": "place_labels", minzoom: 3,
          filter: [
            "any",
            ["in", ["get", "kind"], ["literal", ["capital", "state_capital"]]],
            ["all", [">=", ["zoom"], 5], ["==", ["get", "kind"], "city"]],
            ["all", [">=", ["zoom"], 8], ["==", ["get", "kind"], "town"]],
            ["all", [">=", ["zoom"], 11], ["in", ["get", "kind"], ["literal", ["village", "suburb"]]]],
          ],
          layout: {
            "text-field": name, "text-font": ["noto_sans_regular"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 3, 10, 10, 13],
            "symbol-sort-key": ["-", 0, ["coalesce", ["get", "population"], 0]],
          },
          paint: halo,
        }
      );
    }
    return style;
  }

  /** Place names in the user's language where the tiles have it (German), else in English. */
  _placeNames() {
    const language = this._strings.language.split("-")[0];
    const own = language === "en" ? [] : [["get", `name_${language}`]];
    return ["coalesce", ...own, ["get", "name_en"], ["get", "name"]];
  }

  _createMap() {
    const ml = this._ml;
    const home = this._payload.location;
    this._updateCompact();
    let map;
    try {
      map = new ml.Map({
        container: this._els.map,
        style: this._buildStyle(),
        center: [home.longitude, home.latitude],
        zoom: this.hasAttribute("compact") ? 1.25 : 1.65,
        maxPitch: 80,
        pixelRatio: Math.min(globalThis.devicePixelRatio || 1, 2),
        // Resizing is handled here, a frame later (see _resizeObserver).
        trackResize: false,
        attributionControl: { compact: true },
        cooperativeGestures: !!this._config.cooperative_gestures,
        locale: Object.fromEntries(Object.entries(MAPLIBRE_TEXT).map(([id, key]) => [id, this._t(key)])),
        transformRequest: (url) => {
          if (this._mapToken && url.startsWith(this._haUrl("/api/map_tiles/"))) {
            return { url, headers: { "X-Map-Tiles-Token": this._mapToken } };
          }
          return { url };
        },
      });
    } catch (err) {
      this._starting = false;
      this._showMessage(this._t("globe.no_webgl", { error: err?.message || err }));
      return;
    }
    this._map = map;
    this._showMessage(this._t("globe.acquiring"), { spinner: true });
    map.addControl(new ml.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(this._viewControl(), "top-right");
    const fullscreen = new ml.FullscreenControl({ container: this._wrap });
    // Tell the card, which lifts itself above the dashboard meanwhile.
    fullscreen.on("fullscreenstart", () => this.toggleAttribute("fullscreen", true));
    fullscreen.on("fullscreenend", () => this.toggleAttribute("fullscreen", false));
    map.addControl(fullscreen, "top-right");

    for (const ev of ["dragstart", "rotatestart", "pitchstart"]) {
      map.on(ev, (e) => {
        if (e.originalEvent && this._mode !== "free" && !this._preview) this._setMode("free");
      });
    }
    // Zooming changes how fast the station crosses the screen.
    map.on("zoomend", () => this._scheduleFrames());
    map.on("render", () => this._placeLabels());
    map.on("error", (e) => this._onMapError(e));
    this._watchContext(map);

    const homeEl = document.createElement("div");
    homeEl.className = "home";
    homeEl.innerHTML = HOME_SVG;
    homeEl.title = home.title;
    // Hidden, not faded, while home is round the far side of the globe.
    this._homeMarker = new ml.Marker({ element: homeEl, opacityWhenCovered: "0" })
      .setLngLat([home.longitude, home.latitude])
      .addTo(map);

    this._night = new NightLayer({ getState: () => this._nightState });
    this._space = new SpaceLayer();
    this._mapSize = [this._els.map.clientWidth, this._els.map.clientHeight];
    // The map element rather than the host: in fullscreen only the map grows.
    this._resizeObserver = new ResizeObserver(() => {
      if (this._resizePending) return;
      this._resizePending = true;
      requestAnimationFrame(() => {
        this._resizePending = false;
        if (!this._map) return;
        this._map.resize();
        this._mapSize = [this._els.map.clientWidth, this._els.map.clientHeight];
        this._applyLayout();
      });
    });
    this._resizeObserver.observe(this._els.map);
    this._loadLights(map);

    // The layers and the station go in as soon as the style is ready, without
    // waiting for every tile (the "load" event).
    map.once("style.load", () => {
      if (this._map !== map) return;
      map.addLayer(this._night, map.getLayer("borders-country") ? "borders-country" : undefined);
      map.addLayer(this._space);
      this._loaded = true;
      this._starting = false;
      if (this._closeupKey !== this._imageryKey()) this._setImagery();
      this._applyLayout();
      this._buildCourse();
      this._renderUpcoming();
      this._renderSky(true);
      this._frame();
      this._setMode(this._config.view || "home", true);
      this._resume();
      map.once("render", () => this._map === map && this._showMessage(""));
    });
    map.once("load", () => {
      // Collapse the imagery credits behind (i) on small screens.
      if (this._map === map && this.clientWidth < 720) {
        this.shadowRoot.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
      }
    });
  }

  /** Start a new map when the browser takes the WebGL context away for good. */
  _watchContext(map) {
    const rebuild = () => {
      if (this._map !== map) return;
      this._teardown();
      // Off the page meanwhile: connectedCallback starts it again.
      if (this.isConnected) this._start();
    };
    const canvas = map.getCanvas();
    canvas.addEventListener("webglcontextlost", () => {
      if (this._map !== map) return;
      this._showMessage(this._t("globe.reloading"), { spinner: true });
      // The browser restores a lost context when it can. One that stays lost
      // (the GPU was reset, or too many pages use WebGL) needs a new map.
      clearTimeout(this._contextTimer);
      this._contextTimer = setTimeout(rebuild, CONTEXT_RESTORE_MS);
    });
    canvas.addEventListener("webglcontextrestored", rebuild);
  }

  _onMapError(e) {
    const status = e?.error?.status;
    const url = String(e?.error?.url || "");
    const haTiles =
      url.startsWith(this._haUrl("/api/map_tiles/")) ||
      e?.sourceId === "osm" ||
      (e?.sourceId === "closeup" && !!IMAGERY[this._closeupKey]?.homeAssistantTiles);
    const tile = e?.tile?.tileID?.canonical;
    if (haTiles && tile && e.sourceId) {
      // Remember it, to fetch again with a fresh token or once Home Assistant is back.
      const { x, y, z } = tile;
      (this._failedTiles[e.sourceId] ??= new Map()).set(`${z}/${x}/${y}`, { x, y, z });
    }
    if (status === 403 && haTiles) {
      // Home Assistant's tiles token rotated: get a new one and fetch again.
      if (!(performance.now() - this._tokenRetryAt < 30000)) {
        this._tokenRetryAt = performance.now();
        this._refreshMapToken(true);
      } else if (this._mapTokenAt > this._tokenRetryAt) {
        // Sent with the old token just before the new one came: try once more.
        clearTimeout(this._tilesTimer);
        this._tilesTimer = setTimeout(() => this._refreshHaTiles(), 1000);
      }
      return;
    }
    // Tile errors (offline, blocked) are expected now and then; keep going.
    if (status) return;
    console.debug("ISS globe:", e?.error || e);
  }

  /** NASA's city lights for the night side; tried again later if the download fails. */
  _loadLights(map, attempt = 0) {
    if (this._config.show_night === false) return;
    const gl = map.getCanvas().getContext("webgl2");
    const maxTexture = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 2048;
    const width = maxTexture >= 4096 && this.clientWidth > 700 ? 4096 : 2048;
    loadCityLights(width).then((img) => {
      if (this._map !== map) return;
      if (img) this._night?.setLights(img);
      else if (attempt < 3) {
        this._lightsTimer = setTimeout(
          () => this._whenShown("lights", () => this._map === map && this._loadLights(map, attempt + 1)),
          [1, 5, 15][attempt] * 60000
        );
      }
    });
  }

  _viewControl() {
    const host = this;
    return {
      onAdd() {
        const div = document.createElement("div");
        div.className = "maplibregl-ctrl maplibregl-ctrl-group ctrl";
        // The keys of their text, so a change of language can reword them (see _applyStrings).
        const button = (key, title, onClick, label = title) => {
          const b = document.createElement("button");
          b.type = "button";
          b.dataset.tTitle = title;
          b.dataset.tLabel = label;
          b.title = host._t(title);
          b.setAttribute("aria-label", host._t(label));
          b.innerHTML = svgIcon(key);
          b.addEventListener("click", onClick);
          div.appendChild(b);
          return b;
        };
        host._buttons = {
          home: button("home", "controls.home", () => host._setMode("home")),
          follow: button("follow", "controls.follow", () => host._setMode(host._mode === "follow" ? "free" : "follow")),
          chase: button("chase", "controls.chase", () => host._setMode(host._mode === "chase" ? "free" : "chase")),
          flat: button("globe", "controls.flat", () => host._toggleFlat(), "controls.flat_label"),
          layers: button("layers", "controls.imagery", () => host._toggleImageryMenu()),
        };
        host._buttons.layers.setAttribute("aria-expanded", "false");
        host._controlDiv = div;
        host._syncControls();
        return div;
      },
      onRemove() {},
    };
  }

  /** Show which camera modes are on, to the eye and to assistive technology. */
  _syncControls() {
    const b = this._buttons;
    if (!b) return;
    for (const [key, on] of [["follow", this._mode === "follow"], ["chase", this._mode === "chase"], ["flat", this._flat]]) {
      b[key].classList.toggle("active", on);
      b[key].setAttribute("aria-pressed", String(on));
    }
  }

  _toggleImageryMenu() {
    if (this._menu) {
      const hadFocus = this.shadowRoot?.activeElement === this._menu;
      this._menu.remove();
      this._menu = null;
      this._buttons?.layers?.setAttribute("aria-expanded", "false");
      if (hadFocus) this._buttons?.layers?.focus();
      return;
    }
    if (!this._controlDiv) return;
    const select = document.createElement("select");
    select.setAttribute("aria-label", this._t("controls.imagery_menu"));
    for (const [key, def] of Object.entries(IMAGERY)) {
      if (def.homeAssistantTiles && !this._haTilesAvailable()) continue;
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = this._t(`controls.imagery_${key}`);
      opt.selected = key === this._imageryKey();
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      this._setImagery(select.value);
      this.dispatchEvent(new CustomEvent("imagery-changed", { detail: select.value, bubbles: true, composed: true }));
      this._toggleImageryMenu();
    });
    this._controlDiv.style.position = "relative";
    // Beside the layers button that opened it.
    select.style.top = `${this._buttons.layers.offsetTop}px`;
    this._controlDiv.appendChild(select);
    this._menu = select;
    this._buttons.layers.setAttribute("aria-expanded", "true");
    select.focus();
  }

  /** Switch the close-up imagery; before the style has loaded, the change waits for it. */
  _setImagery(key) {
    if (key) this._config = { ...this._config, imagery: key };
    if (!this._map || !this._loaded) return;
    const next = this._imageryKey();
    if (next === this._closeupKey) return;
    this._map.removeLayer("closeup");
    this._map.removeSource("closeup");
    this._map.addSource("closeup", this._closeupSource(next));
    this._map.addLayer(
      { id: "closeup", type: "raster", source: "closeup", minzoom: 4.4, paint: { "raster-fade-duration": 200 } },
      "bluemarble"
    );
    this._closeupKey = next;
  }

  _toggleFlat() {
    this._flat = !this._flat;
    this._map.setProjection({ type: this._flat ? "mercator" : GLOBE_PROJECTION });
    this._syncControls();
  }

  /**
   * Smaller overlays where the globe is short (a phone on its side, a low
   * card), and on cards that are narrow. Fullscreen gets the full layout.
   */
  _updateCompact() {
    if (!this._wrap) return;
    const width = this._wrap.clientWidth || this.clientWidth;
    const height = this._wrap.clientHeight || this.clientHeight;
    if (!width || !height) return;
    const compact = (this.autoCompact && width < 560) || height < 420;
    if (compact !== this.hasAttribute("compact")) this.toggleAttribute("compact", compact);
  }

  /** Safe-area insets (notches, home indicators) the panel passes in, in px. */
  _insets() {
    const px = (el, prop, base) => (el ? Math.max(0, (parseFloat(getComputedStyle(el)[prop]) || 0) - base) : 0);
    const controls = this._els.map.querySelector(".maplibregl-ctrl-top-right");
    return {
      top: px(controls, "marginTop", 0),
      left: px(this._els.mission, "left", 12),
      right: px(controls, "marginRight", 0),
      bottom: px(this._els.telemetry, "bottom", 34),
    };
  }

  /** Wide views show the sky chart and pass list beside the map; narrow ones use a popover. */
  _applyLayout() {
    if (!this._els) return;
    this._updateCompact();
    const width = this._wrap.clientWidth || this.clientWidth;
    const height = this._wrap.clientHeight || this.clientHeight;
    const inset = this._insets();
    // Room for both the countdown and the side column (a landscape phone has
    // the width but not the height), clear of any notch.
    const wide =
      !this.hasAttribute("compact") && width - inset.left - inset.right >= 760 && height - inset.bottom >= 480;
    const changed = wide !== this._wide;
    this._wide = wide;
    this._paddingCache = null;
    this._els.side.hidden = !wide;
    this._els.lookBtn.hidden = wide;
    const coarse = globalThis.matchMedia?.("(pointer: coarse)").matches ?? false;
    this.toggleAttribute("roomy", coarse && height >= 480);
    // The map buttons reach 297 px down, and the credits' (i) sits 34 px up
    // from the bottom: with less room, drop the fullscreen button rather than cover it.
    this.toggleAttribute("short", height - inset.top - inset.bottom < 336);
    if (changed && this._loaded) this._renderSky(false);
  }

  /** Camera padding so the subject stays in the part of the map the overlays leave free. */
  _padding() {
    if (this._paddingCache) return this._paddingCache;
    const width = this._wrap?.clientWidth || this.clientWidth;
    const height = this._wrap?.clientHeight || this.clientHeight;
    const side = this._els?.side;
    const right = side && !side.hidden ? side.offsetWidth + 64 : 48;
    const mission = this._els?.mission;
    const visible = mission && !mission.hidden;
    const top = visible ? (this.hasAttribute("compact") ? Math.min(mission.offsetHeight * 0.9, height * 0.45) : 40) : 0;
    this._paddingCache = { top, bottom: 40, left: 0, right: Math.min(right, width * 0.4) };
    return this._paddingCache;
  }

  /** "home" is a one-off camera move; "follow" and "chase" keep tracking the station. */
  _setMode(mode, initial = false) {
    const previous = this._mode;
    this._mode = mode === "home" ? "free" : mode;
    this._syncControls();
    const map = this._map;
    if (!map) return;
    const pos = this._position;
    const home = this._payload?.location;
    const duration = initial || prefersReducedMotion() ? 0 : 1600;
    const padding = this._padding();
    this._pendingCamera = null;
    if (mode === "home" && home) {
      map.flyTo({
        center: [home.longitude, home.latitude],
        zoom: initial ? map.getZoom() : Math.max(Math.min(map.getZoom(), 3), 1.8),
        pitch: 0,
        bearing: 0,
        padding,
        duration,
      });
    } else if (mode === "follow" || mode === "chase") {
      if (!pos) {
        // No position yet: the first frame with one moves the camera.
        this._pendingCamera = mode;
      } else if (mode === "follow") {
        map.easeTo({ center: [pos.lon, pos.lat], pitch: 0, bearing: 0, zoom: Math.min(map.getZoom(), 3.2), padding, duration });
      } else {
        map.easeTo({ center: [pos.lon, pos.lat], zoom: 3.3, pitch: 64, bearing: pos.heading, padding, duration });
      }
    }
    if (previous !== this._mode) this._scheduleFrames();
  }

  // -- course -------------------------------------------------------------

  _samePass(visible, next) {
    return !!(visible && next && Math.abs(Date.parse(visible.start) - Date.parse(next.rise)) < 20 * 60 * 1000);
  }

  /** Rebuild the orbit, passes and cone (when the data changes, not every frame). */
  _buildCourse() {
    const p = this._payload;
    if (!this._space || !p) return;
    const rows = this._preview ? this._preview.path : p.track;
    this._baseT = rows[0][0];
    const space = this._space;
    this._courseChanged = true;
    space.setLine("orbit", rows, this._baseT);

    // While previewing, the pass being previewed takes the place of the next one.
    const visible = this._preview ? this._preview.pass : p.next_visible_pass;
    const next = this._preview ? null : p.next_pass;
    const samePass = this._samePass(visible, p.next_pass);
    space.setLine("pass", visible?.path || [], this._baseT);
    space.setLine("overhead", next?.path && !samePass ? next.path : [], this._baseT);
    space.setLine("approach", this._preview ? [] : this._approach || [], this._baseT);

    const home = p.location;
    if (this._homeMarker) {
      this._homeMarker.setLngLat([home.longitude, home.latitude]);
      this._homeMarker.getElement().title = home.title;
    }
    const alt = rows.reduce((s, r) => s + r[3], 0) / rows.length;
    this._meanAlt = alt;
    const radius = visibilityRadius(alt, p.settings.min_elevation);
    const ring = circleRing(home.latitude, home.longitude, radius, 128);
    space.setCone(home, ring, alt * 1000, radius);
    space.setRing("coneRing", ring, alt * 1000);

    this._makePins(visible, next, samePass);
    this._loadApproach();
  }

  _makePins(visible, next, samePass) {
    const pins = [];
    if (visible?.path?.length) {
      const r = visible.path[0];
      pins.push({
        key: "pin-visible",
        cls: "pin",
        lat: r[1], lon: r[2], alt: r[3] * 1000,
        text: this._t("pass.pin_visible", {
          time: this._fmt(new Date(visible.start), { weekday: "short", hour: "numeric", minute: "2-digit" }),
          elevation: Math.round(visible.peak_elevation),
        }),
        title: this._t("pass.preview_this"),
        onClick: () => this._startPreview(),
      });
    }
    if (next?.path?.length && !samePass) {
      const r = next.path[0];
      const why = this._passVisibility(next);
      pins.push({
        key: "pin-overhead",
        cls: "pin dim",
        lat: r[1], lon: r[2], alt: r[3] * 1000,
        text: this._t("pass.pin_overhead", { time: this._fmt(new Date(next.rise), { hour: "numeric", minute: "2-digit" }), reason: why.short }),
        title: why.long,
        onClick: () => this._setMode("home"),
      });
    }
    this._pins = pins;
    for (const [key, el] of this._labels) {
      if (key.startsWith("pin") && !pins.some((p) => p.key === key)) {
        el.remove();
        this._labels.delete(key);
      }
    }
    for (const pin of pins) {
      let el = this._labels.get(pin.key);
      if (!el) {
        el = document.createElement("div");
        el.addEventListener("click", () => this._pins.find((p) => p.key === pin.key)?.onClick());
        this._els.labels.appendChild(el);
        this._labels.set(pin.key, el);
      }
      el.className = `flabel ${pin.cls}`;
      el.textContent = pin.text;
      el.title = pin.title;
    }
  }

  /**
   * Whether a pass over home can be seen and, if not, why: short text for the
   * map and the countdown card, and a longer one for tooltips.
   */
  _passVisibility(pass) {
    const s = this._payload.settings;
    // The options are whole degrees and seconds, except the Sun's half degrees.
    const value = (v) => this._num(v, Number.isInteger(v) ? 0 : 1);
    const reason = (key, visible, vars = {}) => ({
      visible,
      short: this._t(`pass.${key}`, vars),
      long: this._t(`pass.${key}_long`, vars),
    });
    switch (pass.reason) {
      case "visible":
        return reason("visible", true);
      case "low": {
        // The highest point while it can be seen, which is what is too low; the
        // pass itself may climb much higher while the station is in shadow.
        const peak = pass.visible_peak_elevation;
        const minimum = value(s.min_peak_elevation);
        return Number.isFinite(peak)
          ? reason("low_up_to", true, { elevation: Math.floor(peak), minimum })
          : reason("low", true, { minimum });
      }
      case "brief":
        return reason("brief", true, { seconds: value(s.min_visible_duration) });
      case "twilight":
        return reason("twilight", false, { elevation: value(s.max_sun_elevation) });
      case "daylight":
        return reason("daylight", false);
      case "shadow":
        return reason("shadow", false);
      default: {
        // An older integration without the reason field.
        if (pass.visible) return reason("visible", true);
        return { visible: false, short: this._invisibleReason(pass), long: this._t("pass.hidden_long") };
      }
    }
  }

  /** Why a pass over home cannot be seen: the sky is too bright, or the station is unlit. */
  _invisibleReason(pass) {
    const home = this._payload.location;
    const peak = new Date(pass.culmination);
    const sunEl = geo.sunElevation(home.latitude, home.longitude, subsolarPoint(peak));
    return this._t(sunEl > (this._payload.settings.max_sun_elevation ?? -6) ? "pass.daylight" : "pass.shadow");
  }

  _ticks(now) {
    if (this._preview || this._config.show_track === false) return [];
    const rows = this._payload.track;
    const step = 15 * 60;
    const out = [];
    for (let t = Math.ceil((now + 120) / step) * step; t <= Math.min(now + 95 * 60, rows[rows.length - 1][0]); t += step) {
      const pos = positionAt(rows, t);
      if (pos) out.push({ t, ...pos });
    }
    return out;
  }

  _simNow() {
    return this._simTime ?? this._now() / 1000;
  }

  /** Move the station, the camera and the lighting to the current moment. */
  _frame() {
    const p = this._payload;
    const map = this._map;
    if (!map || !this._loaded || !p) return;
    if (this._preview) this._advancePreview();
    const t = this._simNow();
    const rows = this._preview ? this._preview.path : p.track;
    const pos = positionAt(rows, t);
    if (!pos) {
      if (!this._preview) this._refreshStale();
      return;
    }
    this._staleDelay = this._staleRetryAt = 0;
    const ahead = positionAt(rows, t + 20) || pos;
    pos.heading = bearing(pos.lat, pos.lon, ahead.lat, ahead.lon);
    this._position = pos;
    if (this._pendingCamera) this._setMode(this._pendingCamera);

    const zoom = map.getZoom();
    const [mx, my] = toMercator(pos.lat, pos.lon);
    const [ax, ay] = toMercator(ahead.lat, ahead.lon);
    const ticks = this._ticks(t);
    this._tickList = ticks;
    const showFootprint = this._config.show_footprint !== false;
    if (showFootprint) {
      this._space.setRing("footprint", circleRing(pos.lat, pos.lon, visibilityRadius(pos.alt, 0)), 0);
    }
    this._space.setFrame({
      now: t - this._baseT,
      pixelRatio: map.getPixelRatio(),
      showTrack: this._config.show_track !== false,
      showCone: this._config.show_home_zone !== false,
      showFootprint,
      coneAlpha: lerp(0.16, 0.08, (zoom - 3) / 3),
      iss: {
        center: [mx, my, pos.alt * 1000],
        ahead: [ax, ay, ahead.alt * 1000],
        ground: [mx, my, 0],
        sunlit: pos.sunlit,
        size: Math.max(15, Math.min(34, 13 + zoom * 3.2)),
      },
      ticks: ticks.map((k) => [...toMercator(k.lat, k.lon), k.alt * 1000]),
    });
    this._space.setLine("drop", [[0, pos.lat, pos.lon, pos.alt, 1], [0, pos.lat, pos.lon, 0, 1]], 0);
    this._nightState = {
      visible: this._config.show_night !== false,
      sun: sunVector(new Date(t * 1000)),
      strength: lerp(0.95, 0.32, (zoom - 4.5) / 3.5),
      lightsMix: lerp(1, 0, (zoom - 4.5) / 2),
    };

    if (this._preview?.phase === "pass" && performance.now() - (this._skyAt || 0) > 120) {
      this._skyAt = performance.now();
      this._renderSky(false);
    }
    // Moving the camera repaints by itself; otherwise ask for one frame.
    let moved = false;
    if (!this._preview && !map.isMoving()) {
      if (this._mode === "follow") {
        map.jumpTo({ center: [pos.lon, pos.lat], padding: this._padding() });
        moved = true;
      } else if (this._mode === "chase") {
        map.jumpTo({ center: [pos.lon, pos.lat], bearing: pos.heading, padding: this._padding() });
        moved = true;
      }
    }
    if (!moved) {
      // Every frame while the station can be seen moving; otherwise now and
      // then, or as soon as the course changes.
      const idle = !this._preview && this._speed === 0;
      const now = performance.now();
      if (!idle || this._courseChanged || !(now - this._repaintAt < IDLE_REPAINT_MS)) {
        this._courseChanged = false;
        this._repaintAt = now;
        map.triggerRepaint();
      }
    }
  }

  _updateLight() {
    if (!this._map || !this._loaded) return;
    this._map.setLight(sunLight(new Date(this._simNow() * 1000)));
  }

  /** Floating labels at true 3D positions, after each rendered frame. */
  _placeLabels() {
    const space = this._space;
    if (!space || !this._els) return;
    const [w, h] = this._mapSize || [this._els.map.clientWidth, this._els.map.clientHeight];
    const show = (el, pt, dx, dy) => {
      if (!pt) {
        el.style.visibility = "hidden";
        return;
      }
      el.style.visibility = "visible";
      el.style.transform = `translate3d(${(pt.x + dx).toFixed(1)}px, ${(pt.y + dy).toFixed(1)}px, 0)`;
    };
    for (const pin of this._pins || []) {
      const el = this._labels.get(pin.key);
      if (!el) continue;
      if (!el._size || el._text !== el.textContent) {
        el._size = [el.offsetWidth, el.offsetHeight];
        el._text = el.textContent;
      }
      const pt = space.project(pin.lat, pin.lon, pin.alt, w, h);
      show(el, pt, -el._size[0] / 2, -el._size[1] - 12);
    }
    const ticks = this._tickList || [];
    const keep = new Set();
    for (const tk of ticks) {
      const key = `tick-${tk.t}`;
      keep.add(key);
      let el = this._labels.get(key);
      if (!el) {
        el = document.createElement("div");
        el.className = "flabel tick";
        el.textContent = this._fmt(new Date(tk.t * 1000), { hour: "numeric", minute: "2-digit" });
        this._els.labels.appendChild(el);
        this._labels.set(key, el);
      }
      show(el, space.project(tk.lat, tk.lon, tk.alt * 1000, w, h), 8, -7);
    }
    for (const [key, el] of this._labels) {
      if (key.startsWith("tick-") && !keep.has(key)) {
        el.remove();
        this._labels.delete(key);
      }
    }
  }

  /** The detailed record of a pass (only the soonest pass carries its path). */
  _passDetails(pass) {
    const p = this._payload;
    if (pass && p?.next_visible_pass && p.next_visible_pass.start === pass.start) return p.next_visible_pass;
    return pass;
  }

  // -- preview --------------------------------------------------------------

  async _startPreview(chosen = null) {
    const p = this._payload;
    if (!p || p.paused || this._preview || this._previewPending || !this._map) return;
    const realNow = this._now();
    let pass = this._passDetails(chosen || currentVisiblePass(p, realNow));
    if (!pass) return;
    const start = realNow / 1000;
    const passStart = Date.parse(pass.start) / 1000;
    const passEnd = Date.parse(pass.end) / 1000;
    if (passStart <= start) return;
    const token = (this._previewPending = {});
    const btn = this._els.previewBtn;
    const hadFocus = this.shadowRoot.activeElement === btn;
    btn.disabled = true;
    // Coarse for the fast-forward (the server widens long spans), finer for
    // the last hour before the pass, and finest for the pass itself.
    const tailFrom = Math.max(start, passStart - 3600);
    let coarse, tail, fine;
    try {
      [coarse, tail, fine] = await Promise.all([
        this._path(start, passEnd + 150, 30),
        this._path(tailFrom, passEnd + 150, 10),
        pass.path ? Promise.resolve(pass.path) : this._path(passStart, passEnd, 5),
      ]);
    } catch (err) {
      if (this._previewPending !== token) return;
      this._previewPending = null;
      btn.disabled = false;
      if (hadFocus) btn.focus();
      this._notify(this._t("globe.preview_failed", { error: this._errorMessage(err) }));
      return;
    }
    if (this._previewPending !== token || !this._map) return;
    this._previewPending = null;
    pass = { ...pass, path: fine };
    const merged = [
      ...coarse.filter((r) => r[0] < tailFrom),
      ...tail.filter((r) => r[0] < passStart || r[0] > passEnd),
      ...fine.filter((r) => r[0] > start),
    ].sort((a, b) => a[0] - b[0]);
    this._preview = {
      path: merged,
      pass,
      // Reduced motion: no sweep around the globe, just the pass itself.
      timeline: previewTimeline(start, passStart, passEnd, { skipApproach: prefersReducedMotion() }),
      began: performance.now(),
      phase: null,
      modeBefore: this._mode,
      viewBefore: { center: this._map.getCenter(), zoom: this._map.getZoom(), pitch: this._map.getPitch(), bearing: this._map.getBearing() },
    };
    this._els.previewBar.hidden = false;
    this._els.mission.classList.add("preview");
    if (hadFocus) this._els.liveBtn.focus();
    this._buildCourse();
    this._renderSky(true);
    this._tick();
    this._scheduleFrames();
  }

  _advancePreview() {
    const pv = this._preview;
    const state = pv.timeline.at(performance.now() - pv.began);
    this._simTime = state.sim;
    const map = this._map;
    if (state.phase !== pv.phase) {
      pv.phase = state.phase;
      const home = this._payload.location;
      const reduced = prefersReducedMotion();
      if (state.phase === "pass") {
        const pass = pv.pass;
        const path = pass.path || [];
        const top = path.length ? path[closestApproach(home, path)] : null;
        const peakAz = pass.peak_azimuth ?? 180;
        // Halfway between home and the point beneath the station at its highest.
        const center = top
          ? [home.longitude + 0.5 * geo.wrapLongitude(top[2] - home.longitude), (home.latitude + top[1]) / 2]
          : [home.longitude, home.latitude];
        map.flyTo({
          center, zoom: 3.15, pitch: 50, bearing: peakAz, padding: this._padding(),
          duration: reduced ? 0 : 2500, essential: true,
        });
        this._skyOpen = true;
      }
    }
    if (state.phase === "approach" && this._position && !map.isMoving()) {
      map.jumpTo({
        center: [this._position.lon, this._position.lat], zoom: Math.min(Math.max(map.getZoom(), 1.4), 2),
        pitch: 0, bearing: 0, padding: this._padding(),
      });
    }
    if (performance.now() - (pv.lastLight || 0) > 400) {
      pv.lastLight = performance.now();
      map.setLight(sunLight(new Date(state.sim * 1000), 300));
    }
    const total = pv.timeline.durationMs;
    this._els.pvFill.style.width = `${Math.min(100, ((performance.now() - pv.began) / total) * 100).toFixed(1)}%`;
    if (state.done) this._stopPreview();
  }

  _stopPreview(silent = false) {
    const pv = this._preview;
    if (!pv) return;
    this._preview = null;
    this._simTime = null;
    const liveHadFocus = !!this._els && this.shadowRoot?.activeElement === this._els.liveBtn;
    if (this._els) {
      this._els.previewBar.hidden = true;
      this._els.mission.classList.remove("preview");
      this._els.previewBtn.disabled = false;
    }
    if (silent || !this._map) return;
    this._mode = pv.modeBefore;
    this._syncControls();
    this._buildCourse();
    this._renderSky(true);
    this._map.setLight(sunLight(new Date(this._now()), 300));
    this._map.flyTo({ ...pv.viewBefore, duration: prefersReducedMotion() ? 0 : 1800 });
    this._scheduleFrames();
    this._tick();
    if (liveHadFocus) [this._els.previewBtn, this._els.lookBtn].find((b) => !b.hidden)?.focus();
  }

  // -- HUD ------------------------------------------------------------------

  /** Text in the user's language. */
  _t(key, vars) {
    return this._strings.t(key, vars);
  }

  /** The same as HTML; the values go in as they are, so escape them first. */
  _html(key, vars) {
    return this._strings.html(key, vars);
  }

  /** A compass point as the integration sends it ("SSW"), in the user's language. */
  _direction(point) {
    return this._strings.direction(point);
  }

  _confidence(level) {
    return ["high", "medium", "low"].includes(level) ? this._t(`mission.confidence_${level}`) : String(level);
  }

  /** "SW → NE · up to 67° · 6 min · brightness -3.4"; the list leaves out the height, shown beside it. */
  _passSummary(pass, height = false) {
    const parts = [`${this._direction(pass.start_direction)} → ${this._direction(pass.end_direction)}`];
    if (height) parts.push(this._t("pass.up_to", { elevation: Math.round(pass.peak_elevation) }));
    parts.push(this._t("time.minutes", { minutes: Math.round(pass.duration_seconds / 60) }));
    if (pass.magnitude != null) parts.push(this._t("mission.brightness", { magnitude: this._num(pass.magnitude, 1) }));
    return parts.join(" · ");
  }

  /** Why predictions are paused: worded here when the orbit data is too old, else as the integration puts it. */
  _pausedReason(p) {
    if (!Number.isFinite(p.paused_days)) return p.paused;
    const text = this._t("mission.paused_age", { count: p.paused_days });
    return p.paused_error ? this._t("mission.with_error", { text, error: p.paused_error }) : text;
  }

  _fmt(date, options) {
    const key = JSON.stringify(options);
    let f = this._fmtCache.get(key);
    if (!f) {
      const locale = this._hass?.locale;
      const opts = { ...options };
      if (locale?.time_zone === "server" && this._hass?.config?.time_zone) opts.timeZone = this._hass.config.time_zone;
      if (opts.hour) opts.hourCycle = uses12Hour(locale) ? "h12" : "h23";
      try {
        f = new Intl.DateTimeFormat(locale?.language || this._hass?.language || undefined, opts);
      } catch {
        f = new Intl.DateTimeFormat(undefined, opts);
      }
      this._fmtCache.set(key, f);
    }
    return f.format(date);
  }

  /** A number in the user's number format, with a fixed number of decimals. */
  _num(value, digits = 0) {
    let f = this._numCache.get(digits);
    if (!f) {
      const [locales, extra] = numberLocale(this._hass?.locale);
      const opts = { minimumFractionDigits: digits, maximumFractionDigits: digits, ...extra };
      try {
        f = new Intl.NumberFormat(locales, opts);
      } catch {
        f = new Intl.NumberFormat(undefined, opts);
      }
      this._numCache.set(digits, f);
    }
    return f.format(value);
  }

  /** The location's Units option, or Home Assistant's unit system when it is "auto". */
  _imperial() {
    const units = this._payload?.settings?.units;
    if (units === "metric" || units === "imperial") return units === "imperial";
    return this._hass?.config?.unit_system?.length === "mi";
  }

  _distance(km) {
    const v = this._imperial() ? km * 0.621371 : km;
    return `${this._num(Math.round(v))} ${this._imperial() ? "mi" : "km"}`;
  }

  _speed(kmh) {
    const v = this._imperial() ? kmh * 0.621371 : kmh;
    return `${this._num(Math.round(v))} ${this._imperial() ? "mph" : "km/h"}`;
  }

  _tick() {
    const p = this._payload;
    if (!p || !this._els || !this._loaded) return;
    const e = this._els;
    const realMs = this._now();
    const simMs = this._simNow() * 1000;
    const pos = this._position;
    const home = p.location;
    const look = pos ? lookAngles(home, pos) : null;
    e.mission.hidden = this._config.show_countdown === false;
    this._paddingCache = null;

    const paused = !!p.paused && !this._preview;
    const pass = paused ? null : this._preview ? this._preview.pass : currentVisiblePass(p, realMs);
    const nowMs = this._preview ? simMs : realMs;
    const visibleNow = !!pass && Date.parse(pass.start) <= nowMs;
    e.mission.classList.toggle("now", visibleNow);
    e.mission.classList.toggle("paused", paused);
    e.chip.hidden = !pass;
    if (pass) {
      const cls = `chip ${pass.confidence}`;
      if (e.chip.className !== cls) e.chip.className = cls;
      setText(e.chip, this._confidence(pass.confidence));
    }
    if (paused) {
      setText(e.label, this._t("mission.paused"));
      setText(e.clock, this._t("mission.paused_clock"));
      setText(e.when, this._pausedReason(p));
      setText(e.detail, this._t("mission.paused_detail"));
    } else if (visibleNow) {
      setText(e.label, this._t(this._preview ? "mission.preview_visible" : "mission.visible_now"));
      setText(
        e.clock,
        look && look.elevation > 0
          ? this._t("mission.look_up", { direction: this._direction(compass(look.azimuth)), elevation: Math.round(look.elevation) })
          : this._t("mission.look_towards", { direction: this._direction(pass.peak_direction) })
      );
      setText(
        e.when,
        this._t(pass.disappears_into_shadow ? "mission.ends_in_shadow" : "mission.ends_in", {
          countdown: this._strings.countdown(Date.parse(pass.end) - nowMs),
          direction: this._direction(pass.end_direction),
        })
      );
      setText(e.detail, pass.magnitude != null ? this._t("mission.bright_star", { magnitude: this._num(pass.magnitude, 1) }) : "");
    } else if (pass) {
      const start = new Date(pass.start);
      setText(e.label, this._t(this._preview ? "mission.preview_next" : "mission.next_visible_pass"));
      setText(e.clock, this._strings.countdown(start - nowMs));
      setText(e.when, this._fmt(start, { weekday: "long", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }));
      setText(e.detail, this._passSummary(pass, true));
    } else {
      setText(e.label, this._t("mission.next_visible_pass"));
      setText(e.clock, this._t("mission.none_soon"));
      setText(e.when, this._t("mission.none_in_window", { count: p.settings.forecast_days }));
      setText(e.detail, this._t("mission.sunlit_and_dark"));
    }
    this._announce(visibleNow ? `${e.label.textContent}. ${e.clock.textContent}` : `${e.label.textContent}: ${e.when.textContent}`, `${e.label.textContent}|${pass?.start ?? ""}`);

    const next = paused ? null : currentVisiblePass(p, realMs);
    const canPreview = !!next && Date.parse(next.start) > realMs;
    e.previewBtn.hidden = !canPreview && !this._preview;
    e.previewBtn.disabled = !!(this._preview || this._previewPending);
    e.lookBtn.hidden = !!this._wide || paused;
    e.lookBtn.setAttribute("aria-expanded", String(!!this._skyOpen && !e.skyPop.hidden));

    this._renderIntercept(realMs);
    this._renderTelemetry(pos, look);
    if (this._preview) {
      const html = `<b>${esc(this._fmt(new Date(simMs), { weekday: "short", hour: "numeric", minute: "2-digit", second: "2-digit" }))}</b>`;
      if (e.pvTime.innerHTML !== html) e.pvTime.innerHTML = html;
      setText(e.pvSpeed, this._preview.phase === "pass" ? this._t("preview.slow", { rate: PREVIEW_RATE }) : this._t("preview.fast"));
    }
    if (visibleNow) this._renderSky(false);
    this._refreshAfterPass(realMs);
  }

  /**
   * Once a pass in the data is over, ask for the ones after it, rather than
   * leave the next pass over home hidden until the five-minute refresh. Once
   * per pass; re-armed when the view resumes.
   */
  _refreshAfterPass(nowMs) {
    if (!this._running || this._preview) return;
    const over = endedPass(this._payload, nowMs);
    if (!over || over === this._refreshedAfter) return;
    this._refreshedAfter = over;
    clearTimeout(this._passRefreshTimer);
    // A moment after the end, so Home Assistant has moved on too; not if
    // another refresh has brought the next passes meanwhile.
    this._passRefreshTimer = setTimeout(() => {
      if (endedPass(this._payload, this._now()) === over) this._refresh();
    }, 2000);
  }

  /** Tell screen readers when the state changes, not every second. */
  _announce(text, key) {
    if (key === this._announcedKey) return;
    const first = this._announcedKey === undefined;
    this._announcedKey = key;
    if (!first) this._els.announce.textContent = text;
  }

  _renderIntercept(nowMs) {
    const e = this._els;
    const n = this._payload.next_pass;
    if (!n || this._preview || Date.parse(n.set) < nowMs) {
      e.intercept.hidden = true;
      return;
    }
    e.intercept.hidden = false;
    const rise = Date.parse(n.rise);
    const why = this._passVisibility(n);
    const visibility = why.visible ? why.short : this._t("pass.not_visible", { reason: why.short });
    let html;
    if (rise <= nowMs) {
      html = `<b>${esc(this._t("pass.over_now"))}</b> · ${esc(visibility)}`;
    } else {
      const orbits = Math.floor((rise - nowMs) / 1000 / ISS_PERIOD_S);
      const when = this._fmt(new Date(rise), { weekday: "short", hour: "numeric", minute: "2-digit" });
      const parts = [
        this._html("pass.next_over", { time: `<b>${esc(when)}</b>` }),
        esc(this._t("pass.in", { duration: this._strings.duration(rise - nowMs) })),
      ];
      if (orbits >= 1) parts.push(esc(this._t("pass.orbits_away", { count: orbits })));
      parts.push(esc(this._t("pass.up_to", { elevation: Math.round(n.culmination_elevation) })), esc(visibility));
      html = parts.join(" · ");
    }
    if (html !== this._interceptHtml) {
      e.interceptTxt.innerHTML = html;
      this._interceptHtml = html;
    }
  }

  _renderTelemetry(pos, look) {
    const el = this._els.telemetry;
    // During a preview its bar takes this place at the bottom.
    if (!pos || this._config.show_stats === false || this._preview) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const speed = orbitalSpeed(pos.alt) * 3600;
    const lat = `${this._num(Math.abs(pos.lat), 2)}° ${this._direction(pos.lat >= 0 ? "N" : "S")}`;
    const lon = `${this._num(Math.abs(pos.lon), 2)}° ${this._direction(pos.lon >= 0 ? "E" : "W")}`;
    const home = this._payload.location;
    const ground = groundDistanceKm(home.latitude, home.longitude, pos.lat, pos.lon);
    const approx = this._payload.paused && !this._preview ? ` ${esc(this._t("telemetry.approximate"))}` : "";
    let away = this._html("telemetry.distance", { distance: `<b>${this._distance(ground)}</b>`, place: esc(home.title) });
    if (look && look.elevation > 0) away += ` · ${esc(this._t("telemetry.above_horizon", { elevation: Math.round(look.elevation) }))}`;
    const html = `
      <span>${this._html("telemetry.altitude", { value: `<b>${this._distance(pos.alt)}</b>` })}</span>
      <span>${this._html("telemetry.speed", { value: `<b>${this._speed(speed)}</b>` })}</span>
      <span class="opt"><b>${esc(lat)}, ${esc(lon)}</b>${approx}</span>
      <span class="${pos.sunlit ? "lit" : "dark"}">${esc(this._t(pos.sunlit ? "telemetry.sunlit" : "telemetry.shadow"))}</span>
      <span class="opt">${away}</span>`;
    if (html !== this._telemetryHtml) {
      el.innerHTML = html;
      this._telemetryHtml = html;
    }
  }

  _renderSky(rebuild) {
    const p = this._payload;
    if (!p || !this._els) return;
    const paused = p.paused && !this._preview;
    const pass = paused ? null : this._preview ? this._preview.pass : this._passDetails(currentVisiblePass(p, this._now()));
    const wide = !!this._wide;
    const target = wide ? this._els.skySide : this._els.skyPop;
    this._els.skyPop.hidden = wide || !this._skyOpen || !pass;
    this._els.skySide.hidden = !pass;
    this._els.lookBtn.setAttribute("aria-expanded", String(!this._els.skyPop.hidden));
    if (!pass) return;
    if (target.hidden) {
      // Nothing to draw while no one can see it: opening it draws it, and
      // rebuilds then what was asked to be rebuilt meanwhile.
      if (rebuild) this._skyTrack = null;
      return;
    }
    const home = p.location;
    const start = Date.parse(pass.start) / 1000;
    const end = Date.parse(pass.end) / 1000;
    if (rebuild || !this._skyTrack || this._skyFor !== pass.start) {
      const rows = this._samePass(pass, p.next_pass) && p.next_pass.path ? p.next_pass.path : pass.path || [];
      // The exact moments the station appears, peaks and fades, not the nearest samples.
      const exact = ["start", "peak", "end"]
        .map((k) => ({ t: Date.parse(pass[k]) / 1000, azimuth: pass[`${k}_azimuth`], elevation: pass[`${k}_elevation`] }))
        .filter((q) => Number.isFinite(q.t) && Number.isFinite(q.azimuth) && Number.isFinite(q.elevation));
      const samples = skyTrack(home, rows).filter((q) => !(q.t > start - 1 && q.t < start) && !(q.t > end && q.t < end + 1));
      this._skyTrack = [...samples, ...exact].sort((a, b) => a.t - b.t);
      this._skyFor = pass.start;
    }
    const nowS = this._simNow();
    const inPass = nowS >= start && nowS <= end + 60;
    const live = inPass && this._position ? lookAngles(home, this._position) : null;
    const size = wide ? 232 : 200;
    // Without the live position: that only moves the dot (below).
    const svg = skyChartSvg({
      track: this._skyTrack,
      visibleStart: start,
      visibleEnd: end,
      formatTime: (t) => this._fmt(new Date(t * 1000), { hour: "numeric", minute: "2-digit" }),
      size,
      // Both charts can be in the page at once; each needs its own gradient.
      id: wide ? "sky-side" : "sky-pop",
      cardinals: this._strings.list("sky.cardinals"),
      label: this._t("sky.chart"),
    });
    const when = this._fmt(new Date(pass.start), { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    const caption = this._t(pass.disappears_into_shadow ? "sky.fades" : "sky.sets", {
      start: this._direction(pass.start_direction),
      start_elevation: Math.round(pass.start_elevation),
      peak: this._direction(pass.peak_direction),
      peak_elevation: Math.round(pass.peak_elevation),
      end: this._direction(pass.end_direction),
    });
    setText(target.querySelector(".sub"), when);
    const chart = target.querySelector(".chart");
    if (this._skyCharts.get(chart) !== svg) {
      chart.innerHTML = svg;
      this._skyCharts.set(chart, svg);
      // Keep the live dot's pulse in step across redraws instead of restarting it.
      const pulse = chart.querySelector(".live-halo")?.getAnimations?.()[0];
      if (pulse) pulse.startTime = 0;
    }
    const dot = chart.querySelector(".live-dot");
    const at = skyDotXY(live, size);
    if (at) {
      dot.setAttribute("transform", skyDotTransform(at));
      dot.removeAttribute("display");
    } else {
      dot.setAttribute("display", "none");
    }
    setText(target.querySelector(".caption"), caption);
  }

  _renderUpcoming() {
    const el = this._els.upcoming;
    const p = this._payload;
    const list = p.paused ? [] : p.upcoming_visible_passes || [];
    this._els.upcomingBox.hidden = !this.hasAttribute("show-upcoming") || !list.length;
    if (this._els.upcomingBox.hidden) return;
    const html = list
      .slice(0, 12)
      .map((q, i) => {
        const start = new Date(q.start);
        return `<li data-i="${i}" data-start="${esc(q.start)}" tabindex="0" role="button" title="${esc(this._t("pass.preview_this"))}"><span class="t">${esc(this._fmt(start, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}</span>
          <span class="el">${Math.round(q.peak_elevation)}°</span>
          <span class="d">${esc(this._passSummary(q))}</span>
          <span class="c">${esc(this._confidence(q.confidence))}</span></li>`;
      })
      .join("");
    // Rebuild only when something changed, and keep keyboard focus on the same pass.
    if (html !== this._upcomingHtml) {
      const focused = this.shadowRoot.activeElement?.closest?.("li[data-start]")?.dataset.start;
      el.innerHTML = html;
      this._upcomingHtml = html;
      if (focused) {
        const value = globalThis.CSS?.escape ? CSS.escape(focused) : focused;
        el.querySelector(`li[data-start="${value}"]`)?.focus({ preventScroll: true });
      }
    }
    if (!el._wired) {
      el._wired = true;
      const pick = (ev) => {
        const li = ev.target.closest("li[data-i]");
        if (!li) return;
        const q = (this._payload.upcoming_visible_passes || [])[Number(li.dataset.i)];
        if (q) this._startPreview(q);
      };
      el.addEventListener("click", pick);
      el.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault(); // Space would also scroll the list.
        if (!ev.repeat) pick(ev);
      });
    }
  }
}

if (globalThis.customElements && !customElements.get("iss-globe-view")) {
  customElements.define("iss-globe-view", IssGlobeView);
}
