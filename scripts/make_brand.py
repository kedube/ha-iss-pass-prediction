"""Draw the brand images in custom_components/iss_pass_prediction/brand/.

The icon and the logo, each for light and dark backgrounds, at 1x and 2x:
the Earth with its real coastlines, the station on its steep orbit (the gold
track it has flown, the dashed path ahead) and a home beacon looking up at it.
The station is drawn from above and to scale (measured from NASA's 3D model):
the truss with its eight solar wings and two radiators, and the modules.

usage:
  pip install playwright pillow && playwright install chromium
  python scripts/make_brand.py --land ne_110m_land.geojson --font SpaceGrotesk.ttf

Inputs (download once):
  coastlines  Natural Earth 110m land, public domain:
              https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_land.geojson
  font        Space Grotesk, SIL Open Font License 1.1:
              https://github.com/google/fonts/tree/main/ofl/spacegrotesk
"""

# The SVG markup reads better on one line per element.
# ruff: noqa: E501

import argparse
import base64
import itertools
import json
import math
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

_parser = argparse.ArgumentParser(
    description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
)
_parser.add_argument("--land", type=Path, required=True, help="Natural Earth ne_110m_land.geojson")
_parser.add_argument("--font", type=Path, required=True, help="SpaceGrotesk[wght].ttf")
_parser.add_argument(
    "--out",
    type=Path,
    default=Path(__file__).parents[1] / "custom_components/iss_pass_prediction/brand",
)
ARGS = _parser.parse_args()
OUT = ARGS.out
OUT.mkdir(parents=True, exist_ok=True)

# ---- geometry --------------------------------------------------------------
CX, CY, R = 236.0, 292.0, 170.0  # globe in a 512 x 512 design space
LON0, LAT0, SPIN = -22.0, 18.0, -14.0  # view centre and in-plane tilt (deg)
ORBIT_RX, ORBIT_RY, ORBIT_TILT = 226.0, 64.0, -46.0  # steep, like the ISS's 51.6 deg orbit
ISS_T = 4.0  # where on the orbit the station sits (deg), on the near side
STATION_SPAN = 130.0  # the truss, end to end, in design units
HOME = (-6.0, 38.0)  # lon, lat of the home beacon
D = math.pi / 180


def project(lon, lat):
    """Orthographic projection; returns (x, y, visible)."""
    lam, p, lam0, p0 = lon * D, lat * D, LON0 * D, LAT0 * D
    x = math.cos(p) * math.sin(lam - lam0)
    y = math.cos(p0) * math.sin(p) - math.sin(p0) * math.cos(p) * math.cos(lam - lam0)
    c = math.sin(p0) * math.sin(p) + math.cos(p0) * math.cos(p) * math.cos(lam - lam0)
    if c < 0:  # behind: pin to the limb so filled shapes close along it
        n = math.hypot(x, y) or 1.0
        x, y = x / n, y / n
    s, k = math.sin(SPIN * D), math.cos(SPIN * D)
    x, y = x * k - y * s, x * s + y * k
    return CX + R * x, CY - R * y, c >= 0


def densify(ring, step=1.0):
    out = []
    for (a, b), (c, d) in itertools.pairwise(ring):
        n = max(1, int(max(abs(c - a), abs(d - b)) / step))
        out += [(a + (c - a) * i / n, b + (d - b) * i / n) for i in range(n)]
    out.append(ring[-1])
    return out


def land_path():
    data = json.loads(ARGS.land.read_text())
    parts = []
    for feature in data["features"]:
        geom = feature["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for poly in polys:
            for ring in poly:
                pts = [project(lon, lat) for lon, lat in densify(ring)]
                if not any(v for _, _, v in pts):
                    continue
                parts.append("M" + "L".join(f"{x:.1f},{y:.1f}" for x, y, _ in pts) + "Z")
    return "".join(parts)


def graticule_path():
    lines = []
    for lon in range(-180, 180, 30):
        lines.append([(lon, lat) for lat in range(-90, 91, 2)])
    for lat in range(-60, 61, 30):
        lines.append([(lon, lat) for lon in range(-180, 181, 2)])
    parts = []
    for line in lines:
        run = []
        for lon, lat in line:
            x, y, v = project(lon, lat)
            if v:
                run.append(f"{x:.1f},{y:.1f}")
            elif run:
                parts.append("M" + "L".join(run))
                run = []
        if len(run) > 1:
            parts.append("M" + "L".join(run))
    return "".join(parts)


def orbit_point(t):
    a, k = ORBIT_TILT * D, t * D
    x, y = ORBIT_RX * math.cos(k), ORBIT_RY * math.sin(k)
    return CX + x * math.cos(a) - y * math.sin(a), CY + x * math.sin(a) + y * math.cos(a)


def orbit_arc(t0, t1, step=2.0):
    n = max(2, int(abs(t1 - t0) / step))
    pts = [orbit_point(t0 + (t1 - t0) * i / n) for i in range(n + 1)]
    return "M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in pts)


def heading(t):
    """Screen direction (deg, y down) the station flies in at t: t decreases along its path."""
    (x0, y0), (x1, y1) = orbit_point(t + 0.5), orbit_point(t - 0.5)
    return math.degrees(math.atan2(y1 - y0, x1 - x0))


# ---- the station -------------------------------------------------------------
# Seen from above, in metres: x to starboard, y aft (it flies towards -y), the
# truss along y = 0.
TRUSS = 55.0  # half its length
WINGS = (-49.2, -33.9, 33.9, 49.2)  # the four pairs of solar wings: P6, P4, S4, S6
TIP = 37.0  # how far the wings reach fore and aft of the truss
RADIATORS = (9.0, 13.15, 17.3)  # inner edge of each radiator panel, both sides
MODULES = (  # (x0, y0, x1, y1) of each, drawn back to front
    (-2.1, 22.9, 2.1, 36.0),  # Zvezda
    (-2.05, 10.2, 2.05, 22.8),  # Zarya
    (-1.3, 8.0, 1.3, 10.2),  # PMA-1
    (-8.5, 7.4, -5.0, 10.8),  # BEAM
    (-8.95, -4.2, -4.55, 2.9),  # Leonardo
    (-8.9, 2.9, -2.3, 7.4),  # Tranquility
    (2.3, 3.2, 7.7, 7.2),  # Quest
    (-2.3, 2.4, 2.3, 8.0),  # Unity
    (-2.2, -6.6, 2.2, 2.4),  # Destiny
    (-19.4, -12.8, -13.6, -7.4),  # Kibo's exposed facility
    (-13.4, -12.3, -2.2, -7.9),  # Kibo
    (2.2, -12.35, 9.1, -7.85),  # Columbus
    (-2.2, -13.6, 2.2, -6.6),  # Harmony
    (-1.3, -16.4, 1.3, -13.6),  # PMA-2
)
# The solar cells, from away from the sun to towards it.
GOLD = ("#f59e0b", "#fbbf24", "#fde68a", "#fcd34d")
CELLS = 8  # panels drawn along each blanket


def rect(x0, y0, x1, y1, fill, rx=0.0):
    x0, x1, y0, y1 = min(x0, x1), max(x0, x1), min(y0, y1), max(y0, y1)
    return f'<rect x="{x0:.2f}" y="{y0:.2f}" width="{x1 - x0:.2f}" height="{y1 - y0:.2f}" rx="{rx:g}" fill="{fill}"/>'


def wing(xc, s, t):
    """A solar wing, forward (s = -1) or aft (s = 1): two blankets either side of its mast."""
    blankets = ((xc - 5.8, xc - 1.05), (xc + 1.05, xc + 5.8))
    seams = "".join(
        f"M{x0:.2f},{s * (3 + (TIP - 4) * k / CELLS):.2f}H{x1:.2f}"
        for x0, x1 in blankets
        for k in range(1, CELLS)
    )
    return (
        "".join(rect(x0, s * 3, x1, s * (TIP - 1), "url(#st-gold)") for x0, x1 in blankets)
        + f'<path d="{seams}" stroke="rgba(146,64,14,.4)" stroke-width=".3"/>'
        + rect(xc - 0.25, s * 2, xc + 0.25, s * (TIP - 1), t["metal"][0])
        + rect(xc - 5.9, s * 2, xc + 5.9, s * 3, t["metal"][1], 0.3)
        + rect(xc - 5.9, s * (TIP - 1), xc + 5.9, s * TIP, t["metal"][1], 0.3)
    )


def station_svg(t, turn):
    """The station in its own frame (metres), lit for being turned `turn` deg on the page."""
    # The sun is at the top right of the page, as on the globe.
    a = (-45 - turn) * D
    lx, ly = math.cos(a), math.sin(a)
    sun = f'gradientUnits="userSpaceOnUse" x1="{-70 * lx:.1f}" y1="{-70 * ly:.1f}" x2="{70 * lx:.1f}" y2="{70 * ly:.1f}"'
    across_x = 'x1="0" x2="1" y1="0" y2="0"' if lx > 0 else 'x1="1" x2="0" y1="0" y2="0"'
    across_y = 'y1="0" y2="1" x1="0" x2="0"' if ly > 0 else 'y1="1" y2="0" x1="0" x2="0"'
    hull = "".join(
        f'<stop offset="{o}" stop-color="{c}"/>'
        for o, c in zip((0, 0.5, 0.82, 1), t["hull"], strict=True)
    )
    gold = "".join(
        f'<stop offset="{o}" stop-color="{c}"/>'
        for o, c in zip((0, 0.55, 0.8, 1), GOLD, strict=True)
    )
    defs = f"""
    <linearGradient id="st-gold" {sun}>{gold}</linearGradient>
    <linearGradient id="st-white" {sun}><stop offset="0" stop-color="{t["hull"][1]}"/><stop offset="1" stop-color="{t["hull"][2]}"/></linearGradient>
    <linearGradient id="st-hull-x" {across_x}>{hull}</linearGradient>
    <linearGradient id="st-hull-y" {across_y}>{hull}</linearGradient>"""
    # Each module is a cylinder lit across its axis.
    modules = "".join(
        rect(x0, y0, x1, y1, "url(#st-hull-x)" if x1 - x0 < y1 - y0 else "url(#st-hull-y)", 0.7)
        for x0, y0, x1, y1 in MODULES
    )
    zvezda_wings = "".join(rect(s * 2.1, 27.3, s * 15.6, 29.9, "url(#st-gold)") for s in (-1, 1))
    radiators = "".join(
        rect(s * x, 2, s * (x + 3.5), 23.6, "url(#st-white)") for x in RADIATORS for s in (-1, 1)
    )
    wings = "".join(wing(xc, s, t) for xc in WINGS for s in (-1, 1))
    truss = (
        rect(-TRUSS, -2, TRUSS, 2, "url(#st-hull-y)", 0.4)
        + f'<path d="M{1 - TRUSS},0H{TRUSS - 1}" stroke="{t["metal"][1]}" stroke-width=".5" stroke-opacity=".6"/>'
    )
    return f"<defs>{defs}</defs>{zvezda_wings}{modules}{radiators}{wings}{truss}"


def station_frame(x, y):
    """A point on the page in the station's own frame (metres)."""
    ix, iy = orbit_point(ISS_T)
    a, k = -(heading(ISS_T) + 90) * D, STATION_SPAN / (2 * TRUSS)
    dx, dy = x - ix, y - iy
    return (dx * math.cos(a) - dy * math.sin(a)) / k, (dx * math.sin(a) + dy * math.cos(a)) / k


def trail_end():
    """Where the track so far meets the station (t)."""
    t = ISS_T
    while True:
        x, y = station_frame(*orbit_point(t))
        if abs(x) > TRUSS or abs(y) > TIP:
            return t
        t += 0.25


# ---- palettes ----------------------------------------------------------------
THEMES = {
    "light": {
        "ocean": ("#2563eb", "#1e3a8a", "#0a1a45"),
        "land": ("#bae6fd", "#60a5fa", "#1d4ed8"),
        "grid": "rgba(191,219,254,.28)",
        "atmo": "rgba(56,189,248,.55)",
        "atmo_w": 5,
        "trail": ("#f59e0b", "#d97706"),
        "path": "#0284c7",
        "outline": "#0f172a",
        "shadow": 0.28,
        "home": "#fde68a",
        "hull": ("#64748b", "#cbd5e1", "#ffffff", "#e2e8f0"),  # shade to light
        "metal": ("#e2e8f0", "#64748b"),  # mast, ends of the wings
        "ink": "#0f172a",
        "ink2": "#1e40af",
    },
    "dark": {
        "ocean": ("#3b82f6", "#1e40af", "#0b1b4d"),
        "land": ("#e0f2fe", "#7dd3fc", "#2563eb"),
        "grid": "rgba(191,219,254,.32)",
        "atmo": "rgba(125,211,252,.9)",
        "atmo_w": 7,
        "trail": ("#fde68a", "#fbbf24"),
        "path": "#7dd3fc",
        "outline": "#0b1220",
        "shadow": 0.0,
        "home": "#fef3c7",
        "hull": ("#cbd5e1", "#f1f5f9", "#ffffff", "#f8fafc"),
        "metal": ("#f1f5f9", "#94a3b8"),
        "ink": "#f8fafc",
        "ink2": "#7dd3fc",
    },
}


def icon_svg(theme, land, grid):
    t = theme
    ix, iy = orbit_point(ISS_T)
    turn = heading(ISS_T) + 90  # the station's forward (-y) along its path
    hx, hy, _ = project(*HOME)
    # The line of sight stops short of the station.
    k = 1 - 0.2 * STATION_SPAN / math.hypot(ix - hx, iy - hy)
    sx, sy = hx + (ix - hx) * k, hy + (iy - hy) * k
    shadow = f'<filter id="drop" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="1.2" dy="2.4" stdDeviation="1.6" flood-color="#0f172a" flood-opacity="{t["shadow"]}"/></filter>'
    return f"""
  <defs>
    <radialGradient id="ocean" cx="68%" cy="26%" r="85%">
      <stop offset="0" stop-color="{t["ocean"][0]}"/><stop offset=".55" stop-color="{t["ocean"][1]}"/><stop offset="1" stop-color="{t["ocean"][2]}"/>
    </radialGradient>
    <radialGradient id="land" cx="68%" cy="26%" r="85%">
      <stop offset="0" stop-color="{t["land"][0]}"/><stop offset=".55" stop-color="{t["land"][1]}"/><stop offset="1" stop-color="{t["land"][2]}"/>
    </radialGradient>
    <radialGradient id="night" cx="18%" cy="88%" r="75%">
      <stop offset="0" stop-color="#020617" stop-opacity=".78"/><stop offset=".6" stop-color="#020617" stop-opacity=".25"/><stop offset="1" stop-color="#020617" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="shine" cx="70%" cy="22%" r="45%">
      <stop offset="0" stop-color="#fff" stop-opacity=".38"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="trail" gradientUnits="userSpaceOnUse" x1="{CX - ORBIT_RX}" y1="0" x2="{ix}" y2="0">
      <stop offset="0" stop-color="{t["trail"][1]}" stop-opacity="0"/><stop offset=".45" stop-color="{t["trail"][1]}" stop-opacity=".55"/><stop offset="1" stop-color="{t["trail"][0]}"/>
    </linearGradient>
    <clipPath id="globe"><circle cx="{CX}" cy="{CY}" r="{R}"/></clipPath>
    <filter id="blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6"/></filter>
    {shadow if t["shadow"] else ""}
  </defs>
  <!-- the path ahead, behind the globe -->
  <path d="{orbit_arc(ISS_T - 8, -186)}" fill="none" stroke="{t["path"]}" stroke-width="7" stroke-linecap="round" stroke-dasharray="2 17"/>
  <!-- atmosphere -->
  <circle cx="{CX}" cy="{CY}" r="{R + 2}" fill="none" stroke="{t["atmo"]}" stroke-width="{t["atmo_w"] * 2}" filter="url(#blur)"/>
  <g clip-path="url(#globe)">
    <circle cx="{CX}" cy="{CY}" r="{R}" fill="url(#ocean)"/>
    <path d="{grid}" fill="none" stroke="{t["grid"]}" stroke-width="1.6"/>
    <path d="{land}" fill="url(#land)" fill-rule="nonzero"/>
    <circle cx="{CX}" cy="{CY}" r="{R}" fill="url(#night)"/>
    <circle cx="{CX}" cy="{CY}" r="{R}" fill="url(#shine)"/>
  </g>
  <circle cx="{CX}" cy="{CY}" r="{R - 1}" fill="none" stroke="#e0f2fe" stroke-opacity=".5" stroke-width="2"/>
  <!-- home, with its line of sight to the station -->
  <line x1="{hx:.1f}" y1="{hy:.1f}" x2="{sx:.1f}" y2="{sy:.1f}" stroke="{t["home"]}" stroke-width="5" stroke-linecap="round" stroke-dasharray="0.1 11"/>
  <circle cx="{hx:.1f}" cy="{hy:.1f}" r="30" fill="none" stroke="{t["home"]}" stroke-opacity=".35" stroke-width="3"/>
  <circle cx="{hx:.1f}" cy="{hy:.1f}" r="19" fill="none" stroke="{t["home"]}" stroke-opacity=".75" stroke-width="3.5"/>
  <circle cx="{hx:.1f}" cy="{hy:.1f}" r="9" fill="#fbbf24" stroke="{t["outline"]}" stroke-width="3"/>
  <!-- the track so far, in front of the globe -->
  <path d="{orbit_arc(174, trail_end())}" fill="none" stroke="url(#trail)" stroke-width="11" stroke-linecap="round"/>
  <!-- the station -->
  <g{' filter="url(#drop)"' if t["shadow"] else ""}><g transform="translate({ix:.2f} {iy:.2f}) rotate({turn:.2f}) scale({STATION_SPAN / (2 * TRUSS):.4f})">{station_svg(t, turn)}</g></g>
"""


def font_face():
    data = base64.b64encode(ARGS.font.read_bytes()).decode()
    return f"@font-face {{ font-family: 'Space Grotesk'; src: url(data:font/ttf;base64,{data}) format('truetype'); font-weight: 300 700; }}"


PAGE = """<!doctype html><html><head><style>{font}
html, body {{ margin: 0; background: transparent; }} svg {{ display: block; }}</style></head>
<body>{svg}</body></html>"""


def render(page, svg_inner, view, size, path):
    vx, vy, vw, vh = view
    w, h = size
    svg = f'<svg id="s" xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="{vx:.2f} {vy:.2f} {vw:.2f} {vh:.2f}">{svg_inner}</svg>'
    page.set_viewport_size({"width": w, "height": h})
    page.set_content(PAGE.format(font=font_face(), svg=svg))
    page.evaluate("document.fonts.ready")
    page.locator("#s").screenshot(path=str(path), omit_background=True)


def alpha_bbox(path, threshold=10):
    im = Image.open(path).convert("RGBA")
    a = im.getchannel("A").point(lambda v: 255 if v > threshold else 0)
    return a.getbbox(), im.size


def measure(page, svg_inner, canvas=(2600, 1000), origin=(100, 700)):
    """Exact drawn bounds of some SVG placed at `origin`, in px (1 unit = 1 px)."""
    path = OUT / "_measure.png"
    w, h = canvas
    inner = f'<g transform="translate({origin[0]} {origin[1]})">{svg_inner}</g>'
    render(page, inner, (0, 0, w, h), (w, h), path)
    (x0, y0, x1, y1), _ = alpha_bbox(path, threshold=0)
    path.unlink()
    return x0 - origin[0], y0 - origin[1], x1 - origin[0], y1 - origin[1]


def fit_square(page, inner):
    """The smallest square view that holds everything drawn (rendered at 2 px per unit)."""
    probe = OUT / "_probe.png"
    render(page, inner, (-80, -80, 672, 672), (1344, 1344), probe)
    (x0, y0, x1, y1), _ = alpha_bbox(probe, threshold=0)
    probe.unlink()
    bx, by, bw, bh = x0 / 2 - 80, y0 / 2 - 80, (x1 - x0) / 2, (y1 - y0) / 2
    side = max(bw, bh)
    return (bx + bw / 2 - side / 2, by + bh / 2 - side / 2, side, side)


ISS_TEXT = '<text font-family="Space Grotesk" font-size="300" font-weight="700" letter-spacing="-4" fill="{c}">ISS</text>'
SUB_TEXT = '<text font-family="Space Grotesk" font-size="100" font-weight="500" letter-spacing="14" fill="{c}">PASS PREDICTION</text>'


def main():
    land, grid = land_path(), graticule_path()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        m1 = measure(page, ISS_TEXT.format(c="#000"))
        m2 = measure(page, SUB_TEXT.format(c="#000"))
        for name, theme in THEMES.items():
            prefix = "" if name == "light" else "dark_"
            inner = icon_svg(theme, land, grid)
            view = fit_square(page, inner)
            vx, vy, side, _ = view
            for size, suffix in ((256, ""), (512, "@2x")):
                render(page, inner, view, (size, size), OUT / f"{prefix}icon{suffix}.png")
            # Logo: "ISS" over "PASS PREDICTION", both lines the same width,
            # beside the icon and centred on it.
            cap = side * 0.36
            s1 = cap / (m1[3] - m1[1])
            width = (m1[2] - m1[0]) * s1
            s2 = width / (m2[2] - m2[0])
            sub_h = (m2[3] - m2[1]) * s2
            gap = side * 0.07
            block = cap + gap + sub_h
            left = vx + side * 1.08
            top = vy + (side - block) / 2
            text = (
                f'<g transform="translate({left - m1[0] * s1:.2f} {top - m1[1] * s1:.2f}) scale({s1:.5f})">'
                + ISS_TEXT.format(c=theme["ink"])
                + "</g>"
                + f'<g transform="translate({left - m2[0] * s2:.2f} {top + cap + gap - m2[1] * s2:.2f}) scale({s2:.5f})">'
                + SUB_TEXT.format(c=theme["ink2"])
                + "</g>"
            )
            logo_view = (vx, vy, left + width - vx, side)
            for h, suffix in ((256, ""), (512, "@2x")):
                w = round(h * logo_view[2] / logo_view[3])
                render(page, inner + text, logo_view, (w, h), OUT / f"{prefix}logo{suffix}.png")
        browser.close()
    for f in sorted(OUT.glob("*.png")):
        im = Image.open(f)
        im.save(f, optimize=True)
        print(f.name, im.size, f.stat().st_size)


main()
