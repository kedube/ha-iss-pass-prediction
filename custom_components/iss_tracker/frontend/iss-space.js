/**
 * WebGL layers drawn inside MapLibre, on the globe and on the flat map alike:
 *
 *  - NightLayer: the night side of the Earth from the real Sun position, with
 *    NASA's Black Marble city lights and a warm band along the terminator.
 *  - SpaceLayer: the station at its true altitude, its orbit as a glowing
 *    ribbon in space (with a faint ground track below), the cone above the
 *    observer inside which the station is visible, and the predicted pass.
 *
 * Both use MapLibre's projection prelude, so they follow the globe-to-map
 * transition. Everything is in MapLibre "mercator units" (0..1) plus an
 * altitude in metres. Shaders are compiled in prerender(); other GL resources
 * are created lazily inside render(), where MapLibre restores its own GL state
 * afterwards.
 */

const DEG = Math.PI / 180;
const GLOBE_RADIUS_M = 6371008.8;
const MERCATOR_MAX_LAT = 85.051129;

function mercator(lat, lon) {
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  return [
    (((((lon + 180) % 360) + 360) % 360)) / 360,
    0.5 - Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2)) / (2 * Math.PI),
  ];
}

// Shared by every shader: project a mercator point at an altitude. On the
// globe the altitude is real; as the globe flattens into a map everything
// settles onto the ground. Points beyond the mercator limit (towards a pole)
// sit on the edge of the flat map.
const PROJECT_GLSL = `
uniform vec2 u_viewport;
vec4 projectAlt(vec2 p, float elevation) {
  vec2 onMap = vec2(p.x, clamp(p.y, 0.0, 1.0));
#ifdef GLOBE
  vec3 sphere = projectToSphere(p);
  float k = 1.0 + elevation / GLOBE_RADIUS;
  vec3 lifted = sphere * k;
  vec4 globePos = u_projection_matrix * vec4(lifted, 1.0);
  // MapLibre's clipping plane is the horizon of the surface (k = 1). Higher up a
  // point stays in view past the limb, up to acos(d) + acos(1 / k) from the
  // direction of the camera, d being 1 / its distance in globe radii.
  float d = -u_projection_clipping_plane.w;
  float limit = d - sqrt(max(1.0 - d * d, 0.0)) * sqrt(max(k * k - 1.0, 0.0));
  globePos.z = (1.0 - (dot(lifted, u_projection_clipping_plane.xyz) - limit)) * globePos.w;
  if (u_projection_transition > 0.999) return globePos;
  vec4 flatPos = u_projection_fallback_matrix * vec4(onMap, 0.0, 1.0);
  vec4 result = globePos;
  result.xyw = mix(flatPos.xyw, globePos.xyw, u_projection_transition);
  result.z = mix(0.0, globePos.z, clamp((u_projection_transition - 0.2) / 0.8, 0.0, 1.0));
  return result;
#else
  return u_projection_matrix * vec4(onMap, 0.0, 1.0);
#endif
}`;

/**
 * Programs for each projection variant. prepare() only starts compiling and
 * linking, so the driver can work on every program at once; get() finishes a
 * program on first use. With KHR_parallel_shader_compile it does not wait for
 * the driver: get() returns null until the program is ready. A program that
 * fails to build is reported once, and get() keeps returning null for it.
 */
class ProgramCache {
  constructor(vertexBody, fragmentSource, attributes) {
    this._vertexBody = vertexBody;
    this._fragmentSource = fragmentSource;
    this._attributes = attributes;
    this._byVariant = new Map();
  }

  prepare(gl, shaderData) {
    if (this._byVariant.has(shaderData.variantName)) return;
    if (this._parallel === undefined) this._parallel = gl.getExtension("KHR_parallel_shader_compile");
    const program = gl.createProgram();
    const shaders = [
      [
        gl.VERTEX_SHADER,
        `#version 300 es\n${shaderData.vertexShaderPrelude}\n${shaderData.define}\n${PROJECT_GLSL}\n${this._vertexBody}`,
      ],
      [gl.FRAGMENT_SHADER, `#version 300 es\nprecision highp float;\n${this._fragmentSource}`],
    ].map(([type, source]) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      return shader;
    });
    this._attributes.forEach((name, i) => gl.bindAttribLocation(program, i, name));
    gl.linkProgram(program);
    this._byVariant.set(shaderData.variantName, { program, shaders, uniforms: null, failed: false });
  }

  /** The program for this variant and its uniform locations; null while it is being built or if it failed. */
  get(gl, shaderData) {
    this.prepare(gl, shaderData);
    const prog = this._byVariant.get(shaderData.variantName);
    if (prog.uniforms) return prog;
    if (prog.failed || gl.isContextLost()) return null;
    if (this._parallel && !gl.getProgramParameter(prog.program, this._parallel.COMPLETION_STATUS_KHR)) return null;
    const logs = gl.getProgramParameter(prog.program, gl.LINK_STATUS)
      ? null
      : [gl.getProgramInfoLog(prog.program), ...prog.shaders.map((s) => gl.getShaderInfoLog(s))];
    prog.shaders.forEach((s) => gl.deleteShader(s));
    prog.shaders = [];
    if (logs) {
      prog.failed = true;
      console.error(`ISS globe: a shader failed to build, so part of the globe is not drawn.\n${logs.filter(Boolean).join("\n")}`);
      return null;
    }
    prog.uniforms = {};
    const count = gl.getProgramParameter(prog.program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(prog.program, i).name;
      prog.uniforms[name] = gl.getUniformLocation(prog.program, name);
    }
    return prog;
  }

  /** Whether the program for this variant is still being built, so a later frame should look again. */
  pending(shaderData) {
    const prog = this._byVariant.get(shaderData.variantName);
    return !!prog && !prog.uniforms && !prog.failed;
  }

  destroy(gl) {
    for (const prog of this._byVariant.values()) {
      prog.shaders.forEach((s) => gl.deleteShader(s));
      gl.deleteProgram(prog.program);
    }
    this._byVariant.clear();
  }
}

/**
 * The programs a layer draws with, or null to skip the layer this frame: while
 * one is still being built (another frame is requested), or for good once one
 * has failed to build.
 */
function programsFor(layer, gl, shaderData, caches) {
  const progs = caches.map((cache) => cache.get(gl, shaderData));
  if (progs.every(Boolean)) return progs;
  if (caches.some((cache) => cache.pending(shaderData))) layer._map?.triggerRepaint();
  return null;
}

// How far beyond its own extent a shape can be seen, in worlds: line widths and sprites.
const COPY_MARGIN = 0.1;

/**
 * How this frame puts the world on screen. The flat map repeats the world
 * sideways and MapLibre draws every copy in view (wraps -3..3), so there a
 * shape is drawn once for each copy it is in view on. While the globe flattens
 * into the map, each shape is instead placed on the copy nearest the centre of
 * the view, as MapLibre does with its tiles.
 */
function viewOf(map, args) {
  const data = args.defaultProjectionData;
  const globe = args.shaderData.define.includes("GLOBE");
  const center = map ? (map.getCenter().lng + 180) / 360 : 0.5;
  let west = 0;
  let east = 1;
  let repeats = false;
  if (!globe && map && map.getRenderWorldCopies() !== false) {
    const bounds = map.getBounds();
    west = (bounds.getWest() + 180) / 360;
    east = (bounds.getEast() + 180) / 360;
    repeats = Number.isFinite(west) && Number.isFinite(east);
  }
  // The whole-world shifts at which a shape within `reach` of mercator x is in view.
  const copies = (x, reach) => {
    if (!repeats) return [0];
    const lo = Math.max(-3, Math.ceil(west - x - reach));
    const hi = Math.min(3, Math.floor(east - x + reach));
    return Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i);
  };
  // m x translate(dx, 0, 0): the same matrix for the copy of the world dx worlds to the side.
  const shifted = new Map();
  const matrix = (m, which, dx) => {
    const key = `${which}${dx}`;
    let out = shifted.get(key);
    if (!out) {
      out = new Float32Array(m);
      for (let i = 0; i < 4; i++) out[12 + i] = m[12 + i] + dx * m[i];
      shifted.set(key, out);
    }
    return out;
  };
  return {
    data,
    globe,
    center,
    copies,
    main: (dx = 0) => matrix(data.mainMatrix, "m", dx),
    fallback: (dx = 0) => matrix(data.fallbackMatrix, "f", dx),
  };
}

/** Set MapLibre's projection uniforms (the ones a variant does not declare are skipped). */
function setProjectionUniforms(gl, prog, view) {
  const p = view.data;
  const u = prog.uniforms;
  gl.uniformMatrix4fv(u.u_projection_matrix, false, view.main());
  if (u.u_projection_fallback_matrix) gl.uniformMatrix4fv(u.u_projection_fallback_matrix, false, view.fallback());
  if (u.u_projection_tile_mercator_coords) gl.uniform4f(u.u_projection_tile_mercator_coords, ...p.tileMercatorCoords);
  if (u.u_projection_clipping_plane) gl.uniform4f(u.u_projection_clipping_plane, ...p.clippingPlane);
  if (u.u_projection_transition) gl.uniform1f(u.u_projection_transition, p.projectionTransition);
  if (u.u_viewport) gl.uniform2f(u.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
}

/**
 * Run draw() for a shape within `reach` of mercator x: on the flat map once for
 * each copy of the world it is in view on; on the globe once, with the flat
 * half of the transition on the copy nearest the centre.
 */
function drawCopies(gl, prog, view, x, reach, draw) {
  const u = prog.uniforms;
  if (!view.globe) {
    for (const w of view.copies(x, reach)) {
      gl.uniformMatrix4fv(u.u_projection_matrix, false, view.main(w));
      draw();
    }
    return;
  }
  if (u.u_projection_fallback_matrix && view.data.projectionTransition <= 0.999) {
    gl.uniformMatrix4fv(u.u_projection_fallback_matrix, false, view.fallback(Math.round(view.center - x)));
  }
  draw();
}

// ---------------------------------------------------------------------------
// Night side and city lights
// ---------------------------------------------------------------------------

const NIGHT_GRID = 96; // cells across and down the night mesh

const NIGHT_VERTEX = `
in vec2 a_merc;
in float a_pole;
uniform float u_offset;
out vec2 v_merc;
void main() {
  // The mesh is one world wide and starts at u_offset, which keeps its seam on
  // the far side while the globe flattens into the map.
  vec2 p = vec2(a_merc.x + u_offset, a_merc.y);
  // Rows beyond the mercator limit are pinned to the poles, as MapLibre does for tiles.
  if (a_pole < -0.5) {
    gl_Position = projectTile(vec2(p.x, 0.0), vec2(0.0, -32768.0));
    v_merc = vec2(p.x, -0.5);
  } else if (a_pole > 0.5) {
    gl_Position = projectTile(vec2(p.x, 1.0), vec2(0.0, 32768.0));
    v_merc = vec2(p.x, 1.5);
  } else {
    gl_Position = projectTile(p);
    v_merc = p;
  }
}`;

const NIGHT_FRAGMENT = `
in vec2 v_merc;
uniform vec3 u_sun;
uniform sampler2D u_lights;
uniform float u_has_lights;
uniform float u_strength;
uniform float u_lights_mix;
out vec4 fragColor;
const float PI = 3.141592653589793;
void main() {
  float lon = v_merc.x * 2.0 * PI - PI;
  float lat = 2.0 * atan(exp(PI - 2.0 * PI * v_merc.y)) - 0.5 * PI;
  vec3 n = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat));
  float el = degrees(asin(clamp(dot(n, u_sun), -1.0, 1.0)));
  // Daylight above +0.8 deg, full night once the Sun is 12 deg down.
  float t = clamp((el - 0.8) / -12.8, 0.0, 1.0);
  float night = t * t * (3.0 - 2.0 * t);
  vec3 dark = vec3(0.01, 0.018, 0.045);
  vec3 col = dark;
  if (u_has_lights > 0.5) {
    vec3 lights = texture(u_lights, vec2(v_merc.x, 0.5 - lat / PI)).rgb;
    col = mix(dark, lights * 1.15, u_lights_mix);
  }
  float a = night * u_strength;
  // Warm glow where the Sun is just below the horizon (x * x, as pow() is undefined for x < 0).
  float x = (el + 2.0) / 3.2;
  float twilight = exp(-x * x) * (1.0 - 0.6 * night) * u_strength;
  vec3 glow = vec3(0.95, 0.45, 0.18) * twilight * 0.22;
  fragColor = vec4(col * a + glow, a);
}`;

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

const lightsByWidth = new Map();
/**
 * NASA Black Marble 2016 as one equirectangular image, 4096 or 2048 pixels
 * wide, shared by every globe on the page. The copy that comes with the
 * integration is tried first (the browser caches it), then NASA's map server.
 * Resolves null if neither loads; a later call then tries again.
 */
export function loadCityLights(width) {
  let promise = lightsByWidth.get(width);
  if (!promise) {
    promise = loadImage(new URL(`img/black-marble-2016-${width}.jpg`, import.meta.url).href)
      .then(
        (img) =>
          img ||
          loadImage(
            "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0" +
              `&LAYERS=VIIRS_Black_Marble&TIME=2016-01-01&STYLES=&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=${width}&HEIGHT=${width / 2}&FORMAT=image/jpeg`
          )
      )
      .then((img) => {
        if (!img && lightsByWidth.get(width) === promise) lightsByWidth.delete(width);
        return img;
      });
    lightsByWidth.set(width, promise);
  }
  return promise;
}

export class NightLayer {
  constructor({ id = "iss-night", getState }) {
    this.id = id;
    this.type = "custom";
    this.renderingMode = "2d";
    this._getState = getState;
    this._programs = new ProgramCache(NIGHT_VERTEX, NIGHT_FRAGMENT, ["a_merc", "a_pole"]);
  }

  onAdd(map) {
    this._map = map;
  }

  onRemove(map, gl) {
    this._programs.destroy(gl);
    if (this._vao) gl.deleteVertexArray(this._vao);
    if (this._buffers) this._buffers.forEach((b) => gl.deleteBuffer(b));
    if (this._texture) gl.deleteTexture(this._texture);
    this._vao = this._buffers = this._texture = null;
    this.releaseLights();
  }

  /**
   * Drop city lights still waiting for a frame and any decode still running.
   * MapLibre's map.remove() does not call onRemove, so the view calls this
   * when it tears the map down.
   */
  releaseLights() {
    this._lightsRequest = null;
    if (this._pendingLights?.owned) this._pendingLights.image.close();
    this._pendingLights = null;
  }

  /**
   * The city lights: an image or an ImageBitmap. An image is decoded off the
   * main thread first; the texture is made once, on the next frame, replacing
   * any earlier one.
   */
  setLights(image) {
    if (!image) return;
    const request = (this._lightsRequest = {});
    const decoded =
      typeof createImageBitmap === "function" && !(typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap)
        ? createImageBitmap(image, { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "none" }).then(
            (bitmap) => ({ image: bitmap, owned: true }),
            () => ({ image, owned: false })
          )
        : Promise.resolve({ image, owned: false });
    decoded.then((lights) => {
      if (request !== this._lightsRequest) {
        // Replaced by a later call, or the lights were released.
        if (lights.owned) lights.image.close();
        return;
      }
      if (this._pendingLights?.owned) this._pendingLights.image.close();
      this._pendingLights = lights;
      this._map?.triggerRepaint();
    });
  }

  prerender(gl, args) {
    this._programs.prepare(gl, args.shaderData);
  }

  _mesh(gl) {
    // A grid over the mercator world plus a row pinned to each pole.
    const n = NIGHT_GRID;
    const rows = n + 3;
    const verts = new Float32Array(rows * (n + 1) * 3);
    let k = 0;
    for (let j = -1; j <= n + 1; j++) {
      for (let i = 0; i <= n; i++) {
        verts[k++] = i / n;
        verts[k++] = Math.max(0, Math.min(1, j / n));
        verts[k++] = j < 0 ? -1 : j > n ? 1 : 0;
      }
    }
    const idx = new Uint16Array((rows - 1) * n * 6);
    k = 0;
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        idx.set([a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1], k);
        k += 6;
      }
    }
    this._vao = gl.createVertexArray();
    gl.bindVertexArray(this._vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this._buffers = [vb, ib];
    this._count = idx.length;
  }

  _uploadLights(gl, image) {
    if (this._texture) gl.deleteTexture(this._texture);
    this._texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
  }

  render(gl, args) {
    const state = this._getState();
    if (!state || !state.visible) return;
    const progs = programsFor(this, gl, args.shaderData, [this._programs]);
    if (!progs) return;
    const [prog] = progs;
    if (!this._vao) this._mesh(gl);
    if (this._pendingLights) {
      this._uploadLights(gl, this._pendingLights.image);
      if (this._pendingLights.owned) this._pendingLights.image.close();
      this._pendingLights = null;
    }
    const view = viewOf(this._map, args);
    gl.useProgram(prog.program);
    setProjectionUniforms(gl, prog, view);
    const u = prog.uniforms;
    gl.uniform3f(u.u_sun, ...state.sun);
    gl.uniform1f(u.u_strength, state.strength);
    gl.uniform1f(u.u_lights_mix, state.lightsMix);
    gl.uniform1f(u.u_has_lights, this._texture ? 1 : 0);
    // On the globe the mesh starts half a world before the centre of the view (on a cell boundary).
    const offset = view.globe ? Math.floor((view.center - 0.5) * NIGHT_GRID) / NIGHT_GRID : 0;
    gl.uniform1f(u.u_offset, offset);
    if (this._texture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texture);
      gl.uniform1i(u.u_lights, 0);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this._vao);
    drawCopies(gl, prog, view, offset + 0.5, 0.5, () => gl.drawElements(gl.TRIANGLES, this._count, gl.UNSIGNED_SHORT, 0));
    gl.bindVertexArray(null);
  }
}

// ---------------------------------------------------------------------------
// Station, orbit, visibility cone
// ---------------------------------------------------------------------------

const RIBBON_VERTEX = `
in vec2 a_pos;
in float a_elev;
in vec3 a_prev;
in vec3 a_next;
in float a_side;
in float a_t;
in float a_lit;
uniform float u_width;
uniform float u_elev_scale;
out float v_side;
out float v_t;
out float v_lit;
void main() {
  vec4 c = projectAlt(a_pos, a_elev * u_elev_scale);
  vec4 p = projectAlt(a_prev.xy, a_prev.z * u_elev_scale);
  vec4 n = projectAlt(a_next.xy, a_next.z * u_elev_scale);
  vec2 halfVp = u_viewport * 0.5;
  vec2 d = (n.xy / n.w - p.xy / p.w) * halfVp;
  if (dot(d, d) < 1e-10) d = vec2(1.0, 0.0);
  vec2 normal = normalize(vec2(-d.y, d.x));
  vec2 offset = normal * a_side * u_width * 0.5 / halfVp;
  gl_Position = vec4(c.xy + offset * c.w, c.z, c.w);
  v_side = a_side;
  v_t = a_t;
  v_lit = a_lit;
}`;

const RIBBON_FRAGMENT = `
in float v_side;
in float v_t;
in float v_lit;
uniform int u_mode;
uniform vec4 u_color;
uniform vec4 u_color2;
uniform vec4 u_color_past;
uniform float u_now;
uniform float u_past_span;
uniform float u_future_span;
uniform float u_dash;
uniform float u_soft;
out vec4 fragColor;
void main() {
  float x = abs(v_side);
  float edge = mix(1.0 - smoothstep(0.55, 1.0, x), (1.0 - x) * (1.0 - x), u_soft);
  vec4 col = u_color;
  if (u_mode == 0) {
    float dt = v_t - u_now;
    if (dt < 0.0) {
      float f = clamp(1.0 + dt / u_past_span, 0.0, 1.0);
      col = u_color_past;
      col.a *= f * f;
    } else {
      col = mix(u_color2, u_color, v_lit);
      // Bright just ahead, fading out about one orbit on.
      col.a *= mix(1.0, 0.35, clamp(dt / u_future_span, 0.0, 1.0)) * (1.0 - smoothstep(0.75, 1.0, dt / u_future_span));
    }
  } else if (u_mode == 2) {
    col.a *= step(0.42, fract(v_t / u_dash));
  }
  float a = col.a * edge;
  fragColor = vec4(col.rgb * a, a);
}`;

const SPRITE_VERTEX = `
in vec2 a_corner;
uniform vec3 u_center;
uniform vec3 u_ahead;
uniform float u_size;
uniform float u_orient;
out vec2 v_uv;
void main() {
  vec4 c = projectAlt(u_center.xy, u_center.z);
  vec2 halfVp = u_viewport * 0.5;
  vec2 up = vec2(0.0, 1.0);
  if (u_orient > 0.5) {
    vec4 a = projectAlt(u_ahead.xy, u_ahead.z);
    vec2 d = (a.xy / a.w - c.xy / c.w) * halfVp;
    if (dot(d, d) > 1e-8) up = normalize(d);
  }
  vec2 right = vec2(up.y, -up.x);
  vec2 off = (right * a_corner.x + up * a_corner.y) * u_size / halfVp;
  gl_Position = vec4(c.xy + off * c.w, c.z, c.w);
  v_uv = vec2(a_corner.x * 0.5 + 0.5, 0.5 - a_corner.y * 0.5);
}`;

const SPRITE_FRAGMENT = `
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
uniform vec3 u_tint;
out vec4 fragColor;
void main() {
  vec4 t = texture(u_tex, v_uv);
  fragColor = vec4(t.rgb * u_tint, t.a) * u_opacity;
}`;

const FILL_VERTEX = `
in vec2 a_pos;
in float a_elev;
in float a_alpha;
out float v_alpha;
void main() {
  gl_Position = projectAlt(a_pos, a_elev);
  v_alpha = a_alpha;
}`;

const FILL_FRAGMENT = `
in float v_alpha;
uniform vec4 u_color;
out vec4 fragColor;
void main() {
  float a = u_color.a * v_alpha;
  fragColor = vec4(u_color.rgb * a, a);
}`;

const RIBBON_STRIDE = 12; // floats per vertex

/**
 * Turn a polyline of [mercX, mercY, elevation, t, lit] into ribbon vertices.
 * It is split where it crosses the antimeridian, so the flat map never draws a
 * line across the world, and where it crosses the prime meridian, so each
 * piece spans at most half a world and can be put on the copy of the world
 * nearest the centre of the view. Returns {data, segments: [first, count, midX, halfWidth]}.
 */
export function buildRibbon(points) {
  const runs = [];
  let run = [];
  for (const p of points) {
    const prev = run[run.length - 1];
    if (prev && Math.abs(p[0] - prev[0]) > 0.5) {
      const unwrapped = p[0] + (prev[0] > 0.5 ? 1 : -1);
      const edge = prev[0] > 0.5 ? 1 : 0;
      const f = (edge - prev[0]) / (unwrapped - prev[0]);
      const mid = (i) => prev[i] + f * (p[i] - prev[i]);
      run.push([edge, mid(1), mid(2), mid(3), prev[4]]);
      runs.push(run);
      run = [[1 - edge, mid(1), mid(2), mid(3), p[4]]];
    } else if (prev && (prev[0] < 0.5) !== (p[0] < 0.5)) {
      const f = (0.5 - prev[0]) / (p[0] - prev[0]);
      const mid = (i) => prev[i] + f * (p[i] - prev[i]);
      run.push([0.5, mid(1), mid(2), mid(3), prev[4]]);
      runs.push(run);
      run = [[0.5, mid(1), mid(2), mid(3), p[4]]];
    }
    run.push(p);
  }
  if (run.length > 1) runs.push(run);

  const total = runs.reduce((n, r) => n + (r.length > 1 ? r.length * 2 : 0), 0);
  const data = new Float32Array(total * RIBBON_STRIDE);
  const segments = [];
  let v = 0;
  for (const r of runs) {
    if (r.length < 2) continue;
    const xs = r.map((q) => q[0]);
    const [lo, hi] = [Math.min(...xs), Math.max(...xs)];
    segments.push([v, r.length * 2, (lo + hi) / 2, (hi - lo) / 2]);
    for (let i = 0; i < r.length; i++) {
      const cur = r[i];
      const prev = r[Math.max(0, i - 1)];
      const next = r[Math.min(r.length - 1, i + 1)];
      for (const side of [-1, 1]) {
        data.set(
          [cur[0], cur[1], cur[2], prev[0], prev[1], prev[2], next[0], next[1], next[2], side, cur[3], cur[4]],
          v * RIBBON_STRIDE
        );
        v++;
      }
    }
  }
  return { data, segments };
}

function rowsToPoints(rows, baseT, elevationM = null) {
  return rows.map((r) => {
    const [x, y] = mercator(r[1], r[2]);
    return [x, y, elevationM ?? r[3] * 1000, r[0] - baseT, r[4] ?? 1];
  });
}

/** Angular distance between two places, in degrees. */
function arcDeg(lat1, lon1, lat2, lon2) {
  const c =
    Math.sin(lat1 * DEG) * Math.sin(lat2 * DEG) + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon2 - lon1) * DEG);
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

/** Whether a ring of [lon, lat] goes around a pole: its longitude turns a full circle. */
function aroundPole(ring) {
  let turn = 0;
  for (let i = 1; i < ring.length; i++) {
    const d = ring[i][0] - ring[i - 1][0];
    turn += d - 360 * Math.round(d / 360);
  }
  return Math.abs(turn) > 180;
}

/**
 * The cone's footprint for the flat map when the circle around home contains a
 * pole. On the map that circle is a curve from one side of the world to the
 * other, and the area it encloses lies between it and the map's edge at the
 * pole. That area is filled in strips from the edge down to home's latitude and
 * on to the ring, plus a fan from the pole itself (flat on the map; it covers
 * the polar cap while the globe flattens into the map). Alpha and height grow
 * with the distance from home, as on the funnel. Triangles of
 * [x, y, elevation, alpha]; `split` is the first vertex east of home's meridian.
 */
function poleCapFill(home, ring, elevationM, radiusDeg) {
  const north = home.latitude > 0;
  const edge = north ? 0 : 1;
  const apex = mercator(home.latitude, home.longitude);
  // The ring from west to east within half a world of home, as [x, y] ...
  const curve = ring
    .map(([lon, lat]) => {
      const q = mercator(lat, lon);
      q[0] -= Math.floor(q[0] - apex[0] + 0.5);
      return q;
    })
    .sort((a, b) => a[0] - b[0]);
  // ... closed where it crosses the meridian opposite home, and with a point on
  // home's meridian, so that home is a corner of the strips.
  const at = (x, a, b) => [x, a[1] + ((x - a[0]) / (b[0] - a[0] || 1)) * (b[1] - a[1])];
  const seam = at(apex[0] + 0.5, curve[curve.length - 1], [curve[0][0] + 1, curve[0][1]]);
  curve.unshift([apex[0] - 0.5, seam[1]]);
  curve.push(seam);
  const k = curve.findIndex(([x]) => x >= apex[0]);
  if (curve[k][0] > apex[0]) curve.splice(k, 0, at(apex[0], curve[k - 1], curve[k]));
  const vertex = (x, y) => {
    const lat = (2 * Math.atan(Math.exp(Math.PI - 2 * Math.PI * y))) / DEG - 90;
    const out = Math.min(1, arcDeg(home.latitude, home.longitude, lat, x * 360 - 180) / radiusDeg);
    return [x, y, out * elevationM, out];
  };
  const rows = curve.map(([x, y]) => [
    vertex(x, edge),
    vertex(x, north ? Math.min(apex[1], y) : Math.max(apex[1], y)),
    [x, y, elevationM, 1],
  ]);
  const out = Math.min(1, (90 - Math.abs(home.latitude)) / radiusDeg);
  const tris = [];
  for (let i = 0; i < rows.length - 1; i++) {
    if (i === k) tris.split = tris.length / 4;
    const [e1, m1, r1] = rows[i];
    const [e2, m2, r2] = rows[i + 1];
    tris.push(...e1, ...e2, ...m2, ...e1, ...m2, ...m1, ...m1, ...m2, ...r2, ...m1, ...r2, ...r1);
    // Beyond the edge, towards the pole (a mercator y far past the edge projects onto it).
    tris.push(...e1, ...e2, (e1[0] + e2[0]) / 2, north ? -2 : 3, out * elevationM, out);
  }
  return tris;
}

/** Canvas sprite of the station, nose (direction of travel) up. */
function drawStation(size = 256) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const s = size / 256;
  g.scale(s, s);
  const wing = (x, y, h) => {
    const grad = g.createLinearGradient(x, 0, x + 24, 0);
    grad.addColorStop(0, "#5b3a12");
    grad.addColorStop(0.45, "#c98a2b");
    grad.addColorStop(0.55, "#e2a944");
    grad.addColorStop(1, "#6b4515");
    g.fillStyle = grad;
    g.fillRect(x, y, 24, h);
    g.strokeStyle = "rgba(30,20,8,.55)";
    g.lineWidth = 1;
    for (let k = 1; k < 6; k++) {
      g.beginPath();
      g.moveTo(x, y + (h * k) / 6);
      g.lineTo(x + 24, y + (h * k) / 6);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(x + 12, y);
    g.lineTo(x + 12, y + h);
    g.stroke();
    g.strokeStyle = "rgba(255,230,170,.7)";
    g.strokeRect(x + 0.5, y + 0.5, 23, h - 1);
  };
  // Solar array wings at both ends of the truss, above and below it.
  for (const x of [14, 44, 188, 218]) {
    wing(x, 34, 84);
    wing(x, 138, 84);
  }
  // Main truss.
  const truss = g.createLinearGradient(0, 122, 0, 134);
  truss.addColorStop(0, "#f1f5f9");
  truss.addColorStop(1, "#94a3b8");
  g.fillStyle = truss;
  g.fillRect(10, 123, 236, 10);
  g.strokeStyle = "rgba(51,65,85,.6)";
  for (let x = 16; x < 246; x += 10) {
    g.beginPath();
    g.moveTo(x, 123);
    g.lineTo(x + 5, 133);
    g.stroke();
  }
  // Radiators.
  g.fillStyle = "#f8fafc";
  g.fillRect(92, 100, 10, 22);
  g.fillRect(154, 134, 10, 22);
  // Pressurised modules along the direction of travel.
  const mod = g.createLinearGradient(116, 0, 140, 0);
  mod.addColorStop(0, "#94a3b8");
  mod.addColorStop(0.4, "#ffffff");
  mod.addColorStop(1, "#7c8aa0");
  g.fillStyle = mod;
  g.beginPath();
  g.roundRect(117, 44, 22, 168, 9);
  g.fill();
  g.fillRect(102, 76, 52, 14); // Columbus / Kibo
  g.fillRect(108, 176, 40, 12); // Zvezda's arrays mount
  g.fillStyle = "#cbd5e1";
  g.beginPath();
  g.arc(128, 44, 9, 0, 2 * Math.PI);
  g.fill();
  return c;
}

function drawGlow(size, inner, outer) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export class SpaceLayer {
  constructor({ id = "iss-space" } = {}) {
    this.id = id;
    this.type = "custom";
    this.renderingMode = "2d";
    this._ribbons = new Map(); // name -> {data, segments, buffer, vao, dirty}
    this._fills = new Map(); // name -> {data, buffer, vao, dirty}
    this._state = null;
    this._ribbonPrograms = new ProgramCache(RIBBON_VERTEX, RIBBON_FRAGMENT, [
      "a_pos", "a_elev", "a_prev", "a_next", "a_side", "a_t", "a_lit",
    ]);
    this._spritePrograms = new ProgramCache(SPRITE_VERTEX, SPRITE_FRAGMENT, ["a_corner"]);
    this._fillPrograms = new ProgramCache(FILL_VERTEX, FILL_FRAGMENT, ["a_pos", "a_elev", "a_alpha"]);
    this._last = null;
  }

  onAdd(map) {
    this._map = map;
  }

  onRemove(map, gl) {
    for (const cache of [this._ribbonPrograms, this._spritePrograms, this._fillPrograms]) cache.destroy(gl);
    for (const r of [...this._ribbons.values(), ...this._fills.values()]) {
      if (r.vao) gl.deleteVertexArray(r.vao);
      if (r.buffer) gl.deleteBuffer(r.buffer);
      r.vao = r.buffer = null;
      r.dirty = true;
    }
    if (this._spriteVao) gl.deleteVertexArray(this._spriteVao);
    if (this._spriteBuffer) gl.deleteBuffer(this._spriteBuffer);
    for (const t of Object.values(this._textures || {})) gl.deleteTexture(t);
    this._spriteVao = this._spriteBuffer = this._textures = null;
  }

  // -- data -----------------------------------------------------------------

  /** Replace a polyline. rows: track rows; elevationM overrides the altitude (0 = ground). */
  setLine(name, rows, baseT, elevationM = null) {
    const built = rows && rows.length > 1 ? buildRibbon(rowsToPoints(rows, baseT, elevationM)) : null;
    const old = this._ribbons.get(name) || {};
    this._ribbons.set(name, { ...old, ...(built || { data: new Float32Array(0), segments: [] }), dirty: true });
  }

  /** Replace a ring of [lon, lat] at a fixed altitude; t counts the points, for dashes. */
  setRing(name, ring, elevationM) {
    const pts = ring.map(([lon, lat], i) => {
      const [x, y] = mercator(lat, lon);
      return [x, y, elevationM, i, 1];
    });
    const old = this._ribbons.get(name) || {};
    this._ribbons.set(name, { ...old, ...buildRibbon(pts), dirty: true });
  }

  /**
   * The cone of sky in which the station can be seen from home: a funnel from
   * home up to the ring at the station's altitude. radiusDeg is the angular
   * radius the ring was made with (needed for a ring around a pole).
   */
  setCone(home, ring, elevationM, radiusDeg) {
    const apex = mercator(home.latitude, home.longitude);
    // Unwrap around the apex so a cone near the antimeridian stays in one piece.
    const near = (pt) => {
      const q = mercator(pt[1], pt[0]);
      if (q[0] - apex[0] > 0.5) q[0] -= 1;
      else if (q[0] - apex[0] < -0.5) q[0] += 1;
      return q;
    };
    const data = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const a = near(ring[i]);
      const b = near(ring[i + 1]);
      data.push(apex[0], apex[1], 0, 0.0, a[0], a[1], elevationM, 1, b[0], b[1], elevationM, 1);
    }
    this._setFill("cone", data, apex[0]);
    // Around a pole that fan has a face across the whole flat map, so the flat
    // map gets a shape of its own (the fan is right on the globe).
    const pole = radiusDeg > 0 && ring.length > 2 && aroundPole(ring);
    const cap = pole ? poleCapFill(home, ring, elevationM, radiusDeg) : [];
    this._setFill("coneFlat", cap, apex[0], cap.split);
  }

  /**
   * Replace a filled shape around mercator x, given as triangles of [x, y, elevation, alpha].
   * A shape split at a vertex is drawn as two parts, [first, count, midX, halfWidth],
   * each on its own copy of the world, as the pieces of a ribbon are.
   */
  _setFill(name, data, x, split) {
    let reach = 0;
    for (let i = 0; i < data.length; i += 4) reach = Math.max(reach, Math.abs(data[i] - x));
    const part = (first, count) => {
      const xs = data.slice(first * 4, (first + count) * 4).filter((_, i) => i % 4 === 0);
      const [lo, hi] = [Math.min(...xs), Math.max(...xs)];
      return [first, count, (lo + hi) / 2, (hi - lo) / 2];
    };
    const parts = split === undefined ? null : [part(0, split), part(split, data.length / 4 - split)];
    const old = this._fills.get(name) || {};
    this._fills.set(name, { ...old, data: new Float32Array(data), x, reach, parts, dirty: true });
  }

  /** Per-frame state; cheap, no buffers change. */
  setFrame(state) {
    this._state = state;
  }

  // -- rendering ------------------------------------------------------------

  prerender(gl, args) {
    for (const cache of [this._fillPrograms, this._ribbonPrograms, this._spritePrograms]) {
      cache.prepare(gl, args.shaderData);
    }
  }

  _ensureTextures(gl) {
    if (this._textures) return;
    const upload = (canvas) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    };
    this._textures = {
      station: upload(drawStation(256)),
      glow: upload(drawGlow(128, "rgba(255,244,214,0.95)", "rgba(255,200,120,0)")),
      dot: upload(drawGlow(64, "rgba(255,255,255,1)", "rgba(255,255,255,0)")),
    };
  }

  _ensureRibbon(gl, r) {
    if (!r.dirty && r.vao) return;
    if (!r.vao) {
      r.vao = gl.createVertexArray();
      r.buffer = gl.createBuffer();
      gl.bindVertexArray(r.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.buffer);
      const f = 4;
      const s = RIBBON_STRIDE * f;
      const attrs = [
        [0, 2, 0], [1, 1, 2], [2, 3, 3], [3, 3, 6], [4, 1, 9], [5, 1, 10], [6, 1, 11],
      ];
      for (const [loc, size, offset] of attrs) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, s, offset * f);
      }
    } else {
      gl.bindVertexArray(r.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.buffer);
    }
    gl.bufferData(gl.ARRAY_BUFFER, r.data, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    r.dirty = false;
  }

  _ensureSprite(gl) {
    if (this._spriteVao) return;
    this._spriteVao = gl.createVertexArray();
    this._spriteBuffer = gl.createBuffer();
    gl.bindVertexArray(this._spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._spriteBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  _ensureFill(gl, f) {
    if (!f.vao) {
      f.vao = gl.createVertexArray();
      f.buffer = gl.createBuffer();
      gl.bindVertexArray(f.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, f.buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 8);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 16, 12);
      gl.bindVertexArray(null);
      f.dirty = true;
    }
    if (f.dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, f.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, f.data, gl.STATIC_DRAW);
      f.dirty = false;
    }
  }

  _drawRibbon(gl, prog, view, name, opts) {
    const r = this._ribbons.get(name);
    if (!r || !r.segments.length) return;
    this._ensureRibbon(gl, r);
    const u = prog.uniforms;
    gl.uniform1f(u.u_width, opts.width * (this._pixelRatio || 1));
    gl.uniform1f(u.u_elev_scale, opts.elevScale ?? 1);
    gl.uniform1i(u.u_mode, opts.mode ?? 1);
    gl.uniform4f(u.u_color, ...opts.color);
    gl.uniform4f(u.u_color2, ...(opts.color2 || opts.color));
    gl.uniform4f(u.u_color_past, ...(opts.colorPast || opts.color));
    gl.uniform1f(u.u_now, this._state?.now ?? 0);
    gl.uniform1f(u.u_past_span, opts.pastSpan ?? 3000);
    gl.uniform1f(u.u_future_span, opts.futureSpan ?? 6000);
    gl.uniform1f(u.u_dash, opts.dash ?? 60);
    gl.uniform1f(u.u_soft, opts.soft ? 1 : 0);
    gl.bindVertexArray(r.vao);
    for (const [first, count, x, half] of r.segments) {
      drawCopies(gl, prog, view, x, half + COPY_MARGIN, () => gl.drawArrays(gl.TRIANGLE_STRIP, first, count));
    }
  }

  _drawSprite(gl, prog, view, texture, center, size, opts = {}) {
    const u = prog.uniforms;
    // The point ahead on the sprite's copy of the world: across the antimeridian it
    // is a world away, which on the flat map would turn the nose to the west.
    const ahead = opts.ahead || center;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform3f(u.u_center, ...center);
    gl.uniform3f(u.u_ahead, ahead[0] + Math.round(center[0] - ahead[0]), ahead[1], ahead[2]);
    gl.uniform1f(u.u_size, size * (this._pixelRatio || 1));
    gl.uniform1f(u.u_orient, opts.ahead ? 1 : 0);
    gl.uniform1f(u.u_opacity, opts.opacity ?? 1);
    gl.uniform3f(u.u_tint, ...(opts.tint || [1, 1, 1]));
    drawCopies(gl, prog, view, center[0], COPY_MARGIN, () => gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4));
  }

  render(gl, args) {
    const st = this._state;
    const view = viewOf(this._map, args);
    const p = args.defaultProjectionData;
    this._last = {
      main: Float64Array.from(p.mainMatrix),
      fallback: Float64Array.from(p.fallbackMatrix),
      plane: p.clippingPlane.slice(),
      transition: p.projectionTransition,
      globe: view.globe,
      center: view.center,
    };
    if (!st) return;
    const progs = programsFor(this, gl, args.shaderData, [this._fillPrograms, this._ribbonPrograms, this._spritePrograms]);
    if (!progs) return;
    const [fill, ribbon, sprite] = progs;
    // Widths and sizes are in CSS pixels, and the canvas can be drawn at a lower
    // pixel ratio than MapLibre was asked for (it keeps within maxCanvasSize).
    const cssWidth = this._map?.getCanvas().clientWidth;
    this._pixelRatio = cssWidth > 0 ? gl.drawingBufferWidth / cssWidth : st.pixelRatio || 1;
    this._ensureTextures(gl);
    this._ensureSprite(gl);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);

    // Visibility cone above home; on the flat map one around a pole has its own shape.
    const flat = !view.globe || p.projectionTransition <= 0.999;
    const coneFlat = this._fills.get("coneFlat");
    const cone = flat && coneFlat?.data.length ? coneFlat : this._fills.get("cone");
    if (st.showCone && cone?.data.length) {
      this._ensureFill(gl, cone);
      gl.useProgram(fill.program);
      setProjectionUniforms(gl, fill, view);
      gl.uniform4f(fill.uniforms.u_color, 0.99, 0.78, 0.25, st.coneAlpha ?? 0.16);
      gl.bindVertexArray(cone.vao);
      for (const [first, count, x, reach] of cone.parts || [[0, cone.data.length / 4, cone.x, cone.reach]]) {
        drawCopies(gl, fill, view, x, reach, () => gl.drawArrays(gl.TRIANGLES, first, count));
      }
    }

    gl.useProgram(ribbon.program);
    setProjectionUniforms(gl, ribbon, view);
    const sun = [0.49, 0.83, 0.99, 1];
    const shade = [0.66, 0.55, 0.98, 0.85];
    const past = [0.9, 0.93, 1, 0.55];
    if (st.showTrack) {
      // Shadow of the orbit on the ground, then the orbit itself with a glow.
      this._drawRibbon(gl, ribbon, view, "orbit", {
        mode: 0, width: 1.5, elevScale: 0, color: [0.6, 0.85, 1, 0.22], color2: [0.6, 0.6, 1, 0.16],
        colorPast: [1, 1, 1, 0.12], pastSpan: 2400, futureSpan: 5700,
      });
      this._drawRibbon(gl, ribbon, view, "orbit", {
        mode: 0, width: 10, soft: true, color: [0.3, 0.75, 1, 0.38], color2: [0.55, 0.4, 1, 0.22],
        colorPast: [1, 1, 1, 0.1], pastSpan: 2400, futureSpan: 5700,
      });
      this._drawRibbon(gl, ribbon, view, "orbit", {
        mode: 0, width: 2.4, color: sun, color2: shade, colorPast: past, pastSpan: 2400, futureSpan: 5700,
      });
    }
    if (st.showCone) {
      this._drawRibbon(gl, ribbon, view, "coneRing", { width: 6, soft: true, color: [1, 0.8, 0.3, 0.35] });
      this._drawRibbon(gl, ribbon, view, "coneRing", { width: 1.6, color: [1, 0.84, 0.4, 0.9] });
    }
    // Where the station is above the horizon right now, dashed.
    if (st.showFootprint) {
      this._drawRibbon(gl, ribbon, view, "footprint", { mode: 2, dash: 1, width: 1, color: [0.49, 0.83, 0.99, 0.35] });
    }
    // The approach leading into the next pass, then the pass itself.
    this._drawRibbon(gl, ribbon, view, "approach", { mode: 2, width: 2, dash: 90, color: [1, 0.85, 0.45, 0.7] });
    this._drawRibbon(gl, ribbon, view, "overhead", { width: 9, soft: true, color: [0.8, 0.86, 1, 0.3] });
    this._drawRibbon(gl, ribbon, view, "overhead", { width: 2.4, color: [0.88, 0.92, 1, 0.8] });
    this._drawRibbon(gl, ribbon, view, "pass", { width: 12, soft: true, color: [1, 0.75, 0.2, 0.45] });
    this._drawRibbon(gl, ribbon, view, "pass", { width: 3.4, color: [1, 0.86, 0.38, 1] });
    if (st.iss) {
      this._drawRibbon(gl, ribbon, view, "drop", { width: 1.2, color: [1, 1, 1, 0.4] });
    }

    // Sprites: tick marks, the station's shadow on the ground, then the station.
    gl.useProgram(sprite.program);
    setProjectionUniforms(gl, sprite, view);
    gl.bindVertexArray(this._spriteVao);
    gl.uniform1i(sprite.uniforms.u_tex, 0);
    for (const t of st.ticks || []) {
      this._drawSprite(gl, sprite, view, this._textures.dot, t, 4.5, { opacity: 0.95, tint: [0.88, 0.95, 1] });
    }
    if (st.iss) {
      const { center, ahead, ground, sunlit, size } = st.iss;
      this._drawSprite(gl, sprite, view, this._textures.dot, ground, 6, { opacity: 0.55, tint: [0.1, 0.1, 0.12] });
      if (sunlit) {
        this._drawSprite(gl, sprite, view, this._textures.glow, center, size * 1.9, { opacity: 0.75 });
      }
      this._drawSprite(gl, sprite, view, this._textures.station, center, size, {
        ahead,
        opacity: sunlit ? 1 : 0.85,
        tint: sunlit ? [1, 1, 1] : [0.42, 0.45, 0.62],
      });
    }
    gl.bindVertexArray(null);
  }

  /**
   * Where a point at an altitude appears on screen, in CSS pixels, using the
   * matrices of the last frame; null if hidden behind the globe or off screen.
   * On the flat map it is the copy of the world nearest the centre of the view,
   * which is where MapLibre puts its markers too.
   */
  project(lat, lon, altitudeM, width, height) {
    const L = this._last;
    if (!L) return null;
    const [x, y] = mercator(lat, lon);
    const near = x + Math.round((L.center ?? x) - x);
    const mul = (m, v) => [
      m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
      m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
      m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
      m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
    ];
    let clip;
    if (L.globe) {
      const sx = x * 2 * Math.PI + Math.PI;
      const t = Math.exp(Math.PI - y * 2 * Math.PI);
      const sinSy = (t * t - 1) / (t * t + 1);
      const cosSy = (2 * t) / (t * t + 1);
      const k = 1 + altitudeM / GLOBE_RADIUS_M;
      const s = [Math.sin(sx) * cosSy * k, sinSy * k, Math.cos(sx) * cosSy * k, 1];
      // Behind the planet (see projectAlt).
      const d = -L.plane[3];
      const limit = d - Math.sqrt(Math.max(1 - d * d, 0)) * Math.sqrt(Math.max(k * k - 1, 0));
      if (s[0] * L.plane[0] + s[1] * L.plane[1] + s[2] * L.plane[2] < limit) return null;
      clip = mul(L.main, s);
      if (L.transition <= 0.999) {
        const f = mul(L.fallback, [near, y, 0, 1]);
        clip = [0, 1, 3].reduce((c, i) => {
          c[i] = f[i] + (clip[i] - f[i]) * L.transition;
          return c;
        }, clip.slice());
      }
    } else {
      clip = mul(L.main, [near, y, 0, 1]);
    }
    if (clip[3] <= 0) return null;
    const px = ((clip[0] / clip[3]) * 0.5 + 0.5) * width;
    const py = (0.5 - (clip[1] / clip[3]) * 0.5) * height;
    if (px < -50 || py < -50 || px > width + 50 || py > height + 50) return null;
    return { x: px, y: py };
  }
}

export { mercator as toMercator };
