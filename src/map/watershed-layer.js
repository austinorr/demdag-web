// MapLibre CustomLayerInterface that renders the watershed overlay for any
// number of datasets (one discovery/finish COG pair each). One program; each
// dataset is drawn as its own warped mesh with its own textures and cursor
// uniforms, because discovery/finish values are only comparable within a pair.
//
// Each entry is a plain object owned by slippy-map.js with at least:
//   { active, tex: { disc, fini }, w, h, grid, dv, fv, cursor: [x, y], levelIndex }
// Streams (log-faded flow accumulation) draw on every loaded entry; the
// watershed draws only on the active one.

import { compileShader, linkProgram } from "../gl/shader.js";

const vertSrc = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}
`;

const fragSrc = `#version 300 es
precision highp float;
precision highp int;

uniform highp usampler2D u_discovery;
uniform highp usampler2D u_finish;
uniform uint u_dv;
uniform uint u_fv;
uniform uint u_nodata;
uniform int u_active;        // 1 = this dataset holds the cursor
uniform int u_streams;       // 1 = draw streams at this entry's level
uniform float u_streamScale;   // multiplies ACC_LO/ACC_HI at coarser levels
uniform ivec2 u_dataSize;
uniform ivec2 u_cursorTexel;
uniform float u_opacity;

in vec2 v_texCoord;
out vec4 fragColor;

// Stream shading: flow accumulation (1 + f - d) mapped log from ACC_LO
// (transparent) to ACC_HI (full STREAM_COLOR), in full-res cells at level 0
// and multiplied by u_streamScale at coarser levels (see STREAM_SCALE_BASE).
const float ACC_LO = 100.0;
const float ACC_HI = 1.0e5;
const vec3 STREAM_COLOR = vec3(0.02, 0.18, 0.62);
const vec3 WATERSHED_COLOR = vec3(0.0, 0.3, 1.0);

void main() {
  if (v_texCoord.x < 0.0 || v_texCoord.x > 1.0 ||
      v_texCoord.y < 0.0 || v_texCoord.y > 1.0) {
    discard;
  }

  ivec2 texel = ivec2(v_texCoord * vec2(u_dataSize));
  texel = clamp(texel, ivec2(0), u_dataSize - 1);

  uint d = texelFetch(u_discovery, texel, 0).r;
  if (d == u_nodata) discard;
  uint f = texelFetch(u_finish, texel, 0).r;

  // Selected pixel — shade grey
  if (u_active == 1 && texel == u_cursorTexel) {
    fragColor = vec4(0.5, 0.5, 0.5, u_opacity);
    return;
  }

  // Accumulation. Overviews reduce d and f independently (max), so f < d
  // can happen there; treat it as no stream rather than wrapping the uint.
  float acc = f >= d ? float(f - d) + 1.0 : 0.0;
  float lo = ACC_LO * u_streamScale;
  float hi = ACC_HI * u_streamScale;
  float t = u_streams == 1
    ? clamp(log(acc / lo) / log(hi / lo), 0.0, 1.0)
    : 0.0;

  // Upstream watershed (blue) for the active dataset only. f is the max
  // discovery in the subtree, so descendants on the path to that leaf have
  // f == u_fv: use >= / <=.
  bool inWatershed = u_active == 1 && d >= u_dv && f <= u_fv;

  if (inWatershed) {
    // streams stay visible inside the watershed as a darker blue
    fragColor = vec4(mix(WATERSHED_COLOR, STREAM_COLOR, t), u_opacity);
  } else if (t > 0.0) {
    fragColor = vec4(STREAM_COLOR, t * u_opacity);
  } else {
    discard;
  }
}
`;

// Coarsest overview level at which streams are drawn. Needs paired overviews
// (per block, the pixel with the largest f - d, both values kept); with
// independently max-reduced overviews f - d is noise, so set this to 0.
const STREAM_MAX_LEVEL = Infinity;
// How the stream fade thresholds grow per overview level: 1 keeps fixed cell
// counts (a blue wash when zoomed out), 4 tracks texel area (only the biggest
// rivers survive), 2 tracks texel width and sits between.
const STREAM_SCALE_BASE = 2;

export const GRID_N = 16;
const GRID_VERTS = (GRID_N + 1) * (GRID_N + 1); // 289
const GRID_INDICES = GRID_N * GRID_N * 6; // 1536

export const createWatershedLayer = (id, nodata = 0) => {
  let entries = [];
  let showStreams = true;
  let map = null;
  let program = null;
  let posBuffer = null;
  let texBuffer = null;
  let indexBuffer = null;
  let opacity = 0.8;

  // Cached locations
  let posLoc = -1;
  let texLoc = -1;
  let uniforms = {};

  // Reusable typed array for position buffer
  const posData = new Float32Array(GRID_VERTS * 2);

  const layer = {
    id,
    type: "custom",
    renderingMode: "2d",

    onAdd(mapRef, gl) {
      map = mapRef;

      const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
      if (!vs || !fs) return;
      program = linkProgram(gl, vs, fs);
      if (!program) return;

      posBuffer = gl.createBuffer();

      // Build static texcoord + index buffers for the grid
      const texData = new Float32Array(GRID_VERTS * 2);
      const N1 = GRID_N + 1;
      for (let row = 0; row <= GRID_N; row++) {
        for (let col = 0; col <= GRID_N; col++) {
          const i = (row * N1 + col) * 2;
          texData[i] = col / GRID_N;
          texData[i + 1] = row / GRID_N;
        }
      }

      texBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, texData, gl.STATIC_DRAW);

      const indices = new Uint16Array(GRID_INDICES);
      let idx = 0;
      for (let row = 0; row < GRID_N; row++) {
        for (let col = 0; col < GRID_N; col++) {
          const tl = row * N1 + col;
          const tr = tl + 1;
          const bl = tl + N1;
          const br = bl + 1;
          indices[idx++] = tl;
          indices[idx++] = tr;
          indices[idx++] = bl;
          indices[idx++] = bl;
          indices[idx++] = tr;
          indices[idx++] = br;
        }
      }

      indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

      posLoc = gl.getAttribLocation(program, "a_position");
      texLoc = gl.getAttribLocation(program, "a_texCoord");
      uniforms = {
        discovery: gl.getUniformLocation(program, "u_discovery"),
        finish: gl.getUniformLocation(program, "u_finish"),
        dv: gl.getUniformLocation(program, "u_dv"),
        fv: gl.getUniformLocation(program, "u_fv"),
        nodata: gl.getUniformLocation(program, "u_nodata"),
        active: gl.getUniformLocation(program, "u_active"),
        streams: gl.getUniformLocation(program, "u_streams"),
        streamScale: gl.getUniformLocation(program, "u_streamScale"),
        dataSize: gl.getUniformLocation(program, "u_dataSize"),
        cursorTexel: gl.getUniformLocation(program, "u_cursorTexel"),
        opacity: gl.getUniformLocation(program, "u_opacity"),
      };
    },

    render(gl) {
      if (!program || !map) return;

      const drawable = entries.filter(
        (e) => e.tex.disc && e.tex.fini && e.grid,
      );
      if (drawable.length === 0) return;

      const canvas = map.getCanvas();
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;

      gl.useProgram(program);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.enableVertexAttribArray(texLoc);
      gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
      gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

      gl.uniform1i(uniforms.discovery, 4);
      gl.uniform1i(uniforms.finish, 5);
      gl.uniform1ui(uniforms.nodata, nodata);
      gl.uniform1f(uniforms.opacity, opacity);

      for (const e of drawable) {
        // Project this entry's grid vertices to clip space
        for (let i = 0; i < e.grid.length; i++) {
          const p = map.project(e.grid[i]);
          posData[i * 2] = (p.x / cw) * 2 - 1;
          posData[i * 2 + 1] = 1 - (p.y / ch) * 2;
        }
        gl.enableVertexAttribArray(posLoc);
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, posData, gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, e.tex.disc);
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, e.tex.fini);

        gl.uniform1i(uniforms.active, e.active ? 1 : 0);
        gl.uniform1i(
          uniforms.streams,
          showStreams && e.levelIndex <= STREAM_MAX_LEVEL ? 1 : 0,
        );
        gl.uniform1f(uniforms.streamScale, Math.pow(STREAM_SCALE_BASE, e.levelIndex));
        gl.uniform1ui(uniforms.dv, e.dv);
        gl.uniform1ui(uniforms.fv, e.fv);
        gl.uniform2i(uniforms.dataSize, e.w, e.h);
        gl.uniform2i(uniforms.cursorTexel, e.cursor[0], e.cursor[1]);

        gl.drawElements(gl.TRIANGLES, GRID_INDICES, gl.UNSIGNED_SHORT, 0);
      }

      gl.disable(gl.BLEND);
    },

    setEntries(list) {
      entries = list;
    },

    setOpacity(v) {
      opacity = v;
    },

    setShowStreams(v) {
      showStreams = v;
    },
  };

  return layer;
};
