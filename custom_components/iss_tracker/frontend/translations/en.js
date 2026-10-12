/**
 * English text for the globe, the dashboard card and the sidebar panel.
 *
 * English is built in, so there is always something to show; every other
 * language is a JSON file beside this one with the same keys (a key it lacks
 * shows in English). {name} placeholders are filled in by the code. A value
 * with "one" and "other" is chosen by {count}; languages with more plural
 * forms add "few" and "many".
 */
export default {
  // The 16 compass points, clockwise from north, as the integration names
  // them. Translations follow Home Assistant's weather card.
  compass: ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"],
  card: {
    name: "ISS globe",
    description:
      "A 3D Earth with the International Space Station at its true altitude, its orbit and a countdown to when it next crosses your sky.",
    load_failed: "Could not load the ISS globe. Check the connection, or reload the page.",
  },
  // The card's settings in the dashboard editor.
  editor: {
    entry_id: "Location",
    entry_id_helper: "Leave empty to show the first location.",
    imagery: "Imagery",
    imagery_satellite: "Satellite (NASA Blue Marble, Sentinel-2 close up)",
    imagery_esri: "Satellite, high detail close up (Esri)",
    imagery_streets: "Street map close up (OpenStreetMap)",
    view: "Start view",
    view_home: "My location",
    view_follow: "Follow the ISS",
    view_chase: "Fly along with the ISS",
    labels: "Place names and borders",
    show_track: "Course lines",
    show_night: "Day and night",
    show_footprint: "Area that can see the ISS",
    show_home_zone: "Your visibility cone",
    show_countdown: "Countdown",
    show_stats: "Position and speed",
    cooperative_gestures: "Require two fingers or Ctrl to move the map",
    height: "Height (masonry dashboards)",
  },
  panel: {
    sidebar: "Sidebar",
    location: "Location",
  },
  globe: {
    name: "International Space Station",
    acquiring: "Acquiring the International Space Station…",
    reloading: "Reloading the globe…",
    reload: "Reload the page",
    // {error} is a technical message, usually in English.
    load_failed: "The ISS globe could not load ({error}). Reload the page to try again.",
    load_retrying: "The ISS globe could not load ({error}). It will try again; reloading the page also helps.",
    no_webgl: "This browser cannot show the 3D globe (WebGL 2 is needed): {error}",
    clock_off:
      "This device's clock does not match Home Assistant's, so the station cannot be placed. Check the date and time settings.",
    connection_lost: "connection lost",
    reconnecting: "Lost the connection to Home Assistant. Reconnecting…",
    not_set_up: "Set up the ISS Tracker integration to see the station here.",
    location_gone_panel: "This location no longer exists. Choose another one.",
    location_gone_card: "The location this card shows no longer exists. Edit the card and choose a location.",
    location_disabled:
      "This location is disabled. Enable it under Settings > Devices & services, or choose another location.",
    waiting: "Waiting for ISS orbit data…",
    waiting_because: "Waiting for ISS orbit data… ({reason})",
    position_failed: "Could not load the ISS position: {error}",
    preview_failed: "ISS preview unavailable: {error}",
    close: "Close",
  },
  // The buttons beside the map, and its imagery menu.
  controls: {
    home: "Show my location",
    follow: "Follow the ISS",
    chase: "Fly along with the ISS",
    flat: "Switch between globe and flat map",
    flat_label: "Flat map",
    imagery: "Change the imagery",
    imagery_menu: "Imagery",
    imagery_satellite: "Satellite (Sentinel-2)",
    imagery_esri: "Satellite, high detail (Esri)",
    imagery_streets: "Street map (OpenStreetMap)",
  },
  // The map's own buttons and hints (MapLibre).
  maplibre: {
    zoom_in: "Zoom in",
    zoom_out: "Zoom out",
    reset_bearing: "Drag to rotate map, click to reset north",
    fullscreen_enter: "Enter fullscreen",
    fullscreen_exit: "Exit fullscreen",
    attribution: "Toggle attribution",
    map: "Map",
    marker: "Map marker",
    ctrl_scroll: "Use Ctrl + scroll to zoom the map",
    cmd_scroll: "Use ⌘ + scroll to zoom the map",
    two_fingers: "Use two fingers to move the map",
  },
  // The countdown box. {direction} is a compass point.
  mission: {
    next_visible_pass: "Next visible pass",
    preview_next: "Preview · next visible pass",
    visible_now: "Visible now",
    preview_visible: "Preview · visible",
    confidence_high: "high confidence",
    confidence_medium: "medium confidence",
    confidence_low: "low confidence",
    look_up: "Look {direction}, {elevation}° up",
    look_towards: "Look {direction}",
    ends_in: "Ends in {countdown} in the {direction}",
    ends_in_shadow: "Ends in {countdown} · fades into Earth's shadow in the {direction}",
    bright_star: "Brightness {magnitude} · brighter than almost every star",
    brightness: "brightness {magnitude}",
    none_soon: "None soon",
    none_in_window: {
      one: "No visible passes in the next day",
      other: "No visible passes in the next {count} days",
    },
    sunlit_and_dark: "The ISS is only visible when it is sunlit and your sky is dark.",
    paused: "Predictions paused",
    paused_clock: "Orbit data out of date",
    paused_age: {
      one: "Orbit data is {count} day old",
      other: "Orbit data is {count} days old",
    },
    // {text} is one of the other messages; {error} why the download failed.
    with_error: "{text} ({error})",
    paused_detail: "Passes come back once fresh orbit data downloads. The station's position shown is approximate.",
    preview: "Preview the pass",
    preview_short: "Preview",
    preview_hint: "Fast-forward to the pass",
    look: "Where to look",
    look_short: "Look up",
    look_hint: "Sky chart of the pass",
  },
  // Passes over the location: the map's labels, and why one can or cannot be
  // seen. The short reasons also fill {reason}.
  pass: {
    pin_visible: "Visible · {time} · {elevation}°",
    pin_overhead: "Overhead · {time} · {reason}",
    preview_this: "Preview this pass",
    visible: "visible",
    visible_long: "The station can be seen on this pass",
    low: "visible, but low",
    low_up_to: "visible only up to {elevation}°",
    low_long: "Visible, below your {minimum}° minimum",
    low_up_to_long: "Visible only up to {elevation}°, below your {minimum}° minimum",
    brief: "visible only briefly",
    brief_long: "Visible for less than your {seconds} s minimum",
    twilight: "sky too bright",
    twilight_long: "The station is sunlit, but your sky is not dark enough (the Sun is above {elevation}°)",
    daylight: "daylight",
    daylight_long: "The station passes over you in daylight, so it cannot be seen",
    shadow: "in Earth's shadow",
    shadow_long: "The station passes over you in Earth's shadow, so it cannot be seen",
    hidden_long: "The station passes over you but cannot be seen (daylight or Earth's shadow)",
    not_visible: "not visible ({reason})",
    over_now: "Over your sky right now",
    next_over: "Next over your sky {time}",
    in: "in {duration}",
    orbits_away: {
      one: "{count} orbit away",
      other: "{count} orbits away",
    },
    up_to: "up to {elevation}°",
  },
  // The strip along the bottom. {value} and {distance} are shown in bold.
  telemetry: {
    altitude: "Altitude {value}",
    speed: "Speed {value}",
    approximate: "(approximate)",
    sunlit: "In sunlight",
    shadow: "In Earth's shadow",
    distance: "{distance} from {place}",
    above_horizon: "{elevation}° above your horizon",
  },
  // The sky chart. {start}, {peak} and {end} are compass points.
  sky: {
    chart: "Sky chart of the pass",
    // North, east, south and west around the chart: room for two letters.
    cardinals: ["N", "E", "S", "W"],
    sets: "Appears in the {start} {start_elevation}° up, climbs to {peak_elevation}° in the {peak}, sets in the {end}.",
    fades:
      "Appears in the {start} {start_elevation}° up, climbs to {peak_elevation}° in the {peak}, fades into Earth's shadow in the {end}.",
  },
  upcoming: {
    title: "Visible passes",
  },
  preview: {
    tag: "PREVIEW",
    back: "Back to live",
    slow: "{rate}× speed",
    fast: "fast forward",
  },
  // Countdowns ("1d 07:42:13") and durations ("2 h 14 min").
  time: {
    countdown_days: "{days}d {time}",
    under_minute: "under a minute",
    minutes: "{minutes} min",
    hours: "{hours} h",
    hours_minutes: "{hours} h {minutes} min",
    days_hours: "{days} d {hours} h",
  },
};
