/**
 * "Where to look" sky chart: the observer's sky as a dome seen from below,
 * north at the top and east to the right like a compass, with the pass drawn
 * across it. Returns an SVG string; pure, so it is unit tested in node.
 */

const DEG = Math.PI / 180;

/** Polar position of an azimuth/elevation on a dome of radius r centred at (c, c). */
export function skyXY(azimuth, elevation, r, c) {
  const rr = (Math.max(0, 90 - elevation) / 90) * r;
  return [c + rr * Math.sin(azimuth * DEG), c - rr * Math.cos(azimuth * DEG)];
}

function pathData(points, r, c) {
  return points
    .map((p, i) => {
      const [x, y] = skyXY(p.azimuth, p.elevation, r, c);
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join("");
}

/**
 * @param {object} o
 * @param {Array<{t:number, azimuth:number, elevation:number}>} o.track whole pass above the horizon
 * @param {number} o.visibleStart unix seconds the station becomes visible
 * @param {number} o.visibleEnd unix seconds it stops being visible
 * @param {{azimuth:number, elevation:number}|null} [o.live] where it is now, if overhead
 * @param {(t:number) => string} o.formatTime
 * @param {number} [o.size]
 * @param {string} [o.id] id of the dome's gradient; unique per chart in the same document
 */
export function skyChartSvg({ track, visibleStart, visibleEnd, live = null, formatTime, size = 220, id = "sky" }) {
  const c = size / 2;
  const r = c - 22;
  const above = (track || []).filter((p) => p.elevation >= 0);
  const visible = above.filter((p) => p.t >= visibleStart - 1 && p.t <= visibleEnd + 1);
  const rings = [0, 30, 60]
    .map((el) => {
      const rr = ((90 - el) / 90) * r;
      return `<circle cx="${c}" cy="${c}" r="${rr.toFixed(1)}" class="${el ? "ring" : "horizon"}"/>`;
    })
    .join("");
  const ringLabels = [30, 60]
    .map((el) => `<text x="${(c + 3).toFixed(1)}" y="${(c - ((90 - el) / 90) * r + 10).toFixed(1)}" class="rl">${el}°</text>`)
    .join("");
  const cardinals = [
    ["N", 0], ["E", 90], ["S", 180], ["W", 270],
  ]
    .map(([name, az]) => {
      const [x, y] = skyXY(az, -11, r, c);
      return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" class="card">${name}</text>`;
    })
    .join("");

  let pass = "";
  if (visible.length > 1) {
    const first = visible[0];
    const last = visible[visible.length - 1];
    const top = visible.reduce((a, b) => (b.elevation > a.elevation ? b : a));
    const [sx, sy] = skyXY(first.azimuth, first.elevation, r, c);
    const [ex, ey] = skyXY(last.azimuth, last.elevation, r, c);
    const [px, py] = skyXY(top.azimuth, top.elevation, r, c);
    // Arrow head pointing along the direction of travel at the end.
    const prev = visible[Math.max(0, visible.length - 3)];
    const [qx, qy] = skyXY(prev.azimuth, prev.elevation, r, c);
    const ang = Math.atan2(ey - qy, ex - qx);
    const head = (d, s) => `${(ex - 9 * Math.cos(ang + s * d)).toFixed(1)} ${(ey - 9 * Math.sin(ang + s * d)).toFixed(1)}`;
    pass = `
      <path d="${pathData(above, r, c)}" class="above"/>
      <path d="${pathData(visible, r, c)}" class="glow"/>
      <path d="${pathData(visible, r, c)}" class="vis"/>
      <path d="M${head(0.45, 1)}L${ex.toFixed(1)} ${ey.toFixed(1)}L${head(0.45, -1)}" class="arrow"/>
      <circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="4" class="pt"/>
      <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.5" class="pt peak"/>
      <text x="${sx.toFixed(1)}" y="${(sy - 8).toFixed(1)}" class="lbl">${formatTime(first.t)}</text>
      <text x="${px.toFixed(1)}" y="${(py + 15).toFixed(1)}" class="lbl peak">${Math.round(top.elevation)}°</text>
      <text x="${ex.toFixed(1)}" y="${(ey - 8).toFixed(1)}" class="lbl">${formatTime(last.t)}</text>`;
  }
  let dot = "";
  if (live && live.elevation > 0) {
    const [lx, ly] = skyXY(live.azimuth, live.elevation, r, c);
    dot = `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="9" class="live-halo"/>
      <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4.5" class="live"/>`;
  }
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Sky chart of the pass">
    <defs><radialGradient id="${id}" r="0.5"><stop offset="0" stop-color="#16244a"/><stop offset="1" stop-color="#070c1c"/></radialGradient></defs>
    <circle cx="${c}" cy="${c}" r="${r}" fill="url(#${id})"/>
    ${rings}
    <path d="M${c} ${c - r}V${c + r}M${c - r} ${c}H${c + r}" class="cross"/>
    ${ringLabels}${cardinals}${pass}${dot}
  </svg>`;
}

export const SKY_STYLE = `
.sky svg { display: block; }
.sky .horizon { fill: none; stroke: rgba(148,163,184,.55); stroke-width: 1.2; }
.sky .ring { fill: none; stroke: rgba(148,163,184,.25); stroke-dasharray: 3 3; }
.sky .cross { stroke: rgba(148,163,184,.14); }
.sky .rl { fill: rgba(203,213,225,.55); font-size: 9px; }
.sky .card { fill: #e2e8f0; font-size: 11px; font-weight: 700; text-anchor: middle; }
.sky .above { fill: none; stroke: rgba(226,232,240,.35); stroke-width: 1.4; stroke-dasharray: 2 3; }
.sky .glow { fill: none; stroke: rgba(251,191,36,.35); stroke-width: 8; stroke-linecap: round; }
.sky .vis { fill: none; stroke: #fcd34d; stroke-width: 3; stroke-linecap: round; }
.sky .arrow { fill: none; stroke: #fcd34d; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
.sky .pt { fill: #fcd34d; stroke: #78350f; stroke-width: 1.2; }
.sky .lbl { fill: #fef3c7; font-size: 10px; font-weight: 600; text-anchor: middle; paint-order: stroke; stroke: rgba(0,0,0,.7); stroke-width: 3px; }
.sky .live { fill: #fff; }
.sky .live-halo { fill: rgba(253,230,138,.35); }
@media (prefers-reduced-motion: no-preference) { .sky .live-halo { animation: sky-pulse 1.4s ease-in-out infinite; transform-box: fill-box; transform-origin: center; } }
@keyframes sky-pulse { 50% { transform: scale(1.6); opacity: .25; } }
`;
