// MapLibre CustomLayerInterface that renders the watershed overlay.
// Projects data window corners to screen space each frame using map.project().
// Cursor dv/fv are looked up on the CPU and passed as uint uniforms.

import { compileShader, linkProgram } from "../gl/shader.js";
import { createIntTexture } from "../gl/textures.js";

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
uniform ivec2 u_dataSize;
uniform ivec2 u_cursorTexel;
uniform float u_opacity;
uniform int u_level;
uniform int u_showAcc;

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
  if (v_texCoord.x < 0.0 || v_texCoord.x > 1.0 ||
      v_texCoord.y < 0.0 || v_texCoord.y > 1.0) {
    discard;
  }

  ivec2 texel = ivec2(v_texCoord * vec2(u_dataSize));
  texel = clamp(texel, ivec2(0), u_dataSize - 1);

  // Selected pixel — shade grey
  if (texel == u_cursorTexel) {
    fragColor = vec4(0.5, 0.5, 0.5, u_opacity);
    return;
  }

  uint d = texelFetch(u_discovery, texel, 0).r;
  uint f = texelFetch(u_finish, texel, 0).r;

  fragColor = vec4(0.0);

  // Upstream watershed (blue)
  if (d > u_dv && f < u_fv) {
    fragColor = vec4(0.0, 0.3, 1.0, u_opacity);
  }
}
`;

const GRID_N = 16;
const GRID_VERTS = (GRID_N + 1) * (GRID_N + 1); // 289
const GRID_INDICES = GRID_N * GRID_N * 6; // 1536

export const createWatershedLayer = (id) => {
  let gridLngLat = null; // flat array of [lng,lat] pairs, (GRID_N+1)^2 entries
  let map = null;
  let program = null;
  let posBuffer = null;
  let texBuffer = null;
  let indexBuffer = null;
  let discTexture = null;
  let finiTexture = null;
  let cursorDv = 0;
  let cursorFv = 0;
  let cursorTexelX = -1;
  let cursorTexelY = -1;
  let opacity = 0.8;
  let currentLevel = 0;
  let showAcc = true;
  let dataWidth = 0;
  let dataHeight = 0;

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

      // Cache locations once
      posLoc = gl.getAttribLocation(program, "a_position");
      texLoc = gl.getAttribLocation(program, "a_texCoord");
      uniforms = {
        discovery: gl.getUniformLocation(program, "u_discovery"),
        finish: gl.getUniformLocation(program, "u_finish"),
        dv: gl.getUniformLocation(program, "u_dv"),
        fv: gl.getUniformLocation(program, "u_fv"),
        dataSize: gl.getUniformLocation(program, "u_dataSize"),
        cursorTexel: gl.getUniformLocation(program, "u_cursorTexel"),
        opacity: gl.getUniformLocation(program, "u_opacity"),
        level: gl.getUniformLocation(program, "u_level"),
        showAcc: gl.getUniformLocation(program, "u_showAcc"),
      };
    },

    render(gl, options) {
      if (!program || !map || !discTexture || !finiTexture || !gridLngLat)
        return;

      const canvas = map.getCanvas();
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;

      // Project each grid vertex to clip space
      for (let i = 0; i < gridLngLat.length; i++) {
        const p = map.project(gridLngLat[i]);
        posData[i * 2] = (p.x / cw) * 2 - 1;
        posData[i * 2 + 1] = 1 - (p.y / ch) * 2;
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, posData, gl.DYNAMIC_DRAW);

      gl.useProgram(program);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.enableVertexAttribArray(posLoc);
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

      gl.enableVertexAttribArray(texLoc);
      gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
      gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, discTexture);
      gl.uniform1i(uniforms.discovery, 4);

      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, finiTexture);
      gl.uniform1i(uniforms.finish, 5);

      gl.uniform1ui(uniforms.dv, cursorDv);
      gl.uniform1ui(uniforms.fv, cursorFv);
      gl.uniform2i(uniforms.dataSize, dataWidth, dataHeight);
      gl.uniform2i(uniforms.cursorTexel, cursorTexelX, cursorTexelY);
      gl.uniform1f(uniforms.opacity, opacity);
      gl.uniform1i(uniforms.level, currentLevel);
      gl.uniform1i(uniforms.showAcc, showAcc ? 1 : 0);

      gl.drawElements(gl.TRIANGLES, GRID_INDICES, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.BLEND);
    },

    updateTextures(gl, discData, finiData, width, height) {
      dataWidth = width;
      dataHeight = height;

      if (discTexture) gl.deleteTexture(discTexture);
      if (finiTexture) gl.deleteTexture(finiTexture);

      discTexture = createIntTexture(gl, discData, width, height);
      finiTexture = createIntTexture(gl, finiData, width, height);
    },

    setCursorValues(dv, fv, tx, ty) {
      cursorDv = dv;
      cursorFv = fv;
      cursorTexelX = tx;
      cursorTexelY = ty;
    },

    setLevel(levelIndex) {
      currentLevel = levelIndex;
    },

    setShowAcc(v) {
      showAcc = v;
    },

    setDataGrid(lngLatGrid) {
      gridLngLat = lngLatGrid;
    },

    setOpacity(v) {
      opacity = v;
    },
  };

  return layer;
};
