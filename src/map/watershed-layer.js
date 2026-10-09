// MapLibre CustomLayerInterface that renders the watershed overlay for any
// number of datasets (one discovery/finish COG pair each). One program; each
// dataset is drawn as its own warped mesh with its own textures and cursor
// uniforms, because discovery/finish values are only comparable within a pair.
//
// Each entry is a plain object owned by slippy-map.js with at least:
//   { active, tex: { disc, fini }, w, h, grid, dv, fv, cursor: [x, y] }

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
uniform ivec2 u_dataSize;
uniform ivec2 u_cursorTexel;
uniform float u_opacity;

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
  if (v_texCoord.x < 0.0 || v_texCoord.x > 1.0 ||
      v_texCoord.y < 0.0 || v_texCoord.y > 1.0) {
    discard;
  }

  ivec2 texel = ivec2(v_texCoord * vec2(u_dataSize));
  texel = clamp(texel, ivec2(0), u_dataSize - 1);

  uint d = texelFetch(u_discovery, texel, 0).r;
  if (d == u_nodata) discard;

  // Selected pixel — shade grey
  if (texel == u_cursorTexel) {
    fragColor = vec4(0.5, 0.5, 0.5, u_opacity);
    return;
  }

  uint f = texelFetch(u_finish, texel, 0).r;

  // Upstream watershed (blue). f is the max discovery in the subtree, so
  // descendants on the path to that leaf have f == u_fv: use >= / <=.
  if (d >= u_dv && f <= u_fv) {
    fragColor = vec4(0.0, 0.3, 1.0, u_opacity);
  } else {
    discard;
  }
}
`;

export const GRID_N = 16;
const GRID_VERTS = (GRID_N + 1) * (GRID_N + 1); // 289
const GRID_INDICES = GRID_N * GRID_N * 6; // 1536

export const createWatershedLayer = (id, nodata = 0) => {
  let entries = [];
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
        dataSize: gl.getUniformLocation(program, "u_dataSize"),
        cursorTexel: gl.getUniformLocation(program, "u_cursorTexel"),
        opacity: gl.getUniformLocation(program, "u_opacity"),
      };
    },

    render(gl) {
      if (!program || !map) return;

      const drawable = entries.filter(
        (e) => e.active && e.tex.disc && e.tex.fini && e.grid,
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
  };

  return layer;
};
