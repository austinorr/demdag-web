import { readPixels } from "./readback.js";

// Static GL resources — created once in setupBuffers(), reused every frame
let positionBuffer = null;
let texcoordBuffer = null;
let positionLocation = -1;
let texcoordLocation = -1;
let resolutionLocation = null;
let mouseLocation = null;
let mposLocation = null;
let zoomLocation = null;
let snapLocation = null;
let image0Location = null;
let image1Location = null;
let image2Location = null;

export const setupBuffers = (gl, program, imageWidth, imageHeight) => {
  gl.useProgram(program);

  // Position buffer — rectangle the same size as the image
  positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  const x2 = imageWidth;
  const y2 = imageHeight;
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, x2, 0, 0, y2, 0, y2, x2, 0, x2, y2]),
    gl.STATIC_DRAW,
  );

  // Texcoord buffer
  texcoordBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
    gl.STATIC_DRAW,
  );

  // Attribute locations
  positionLocation = gl.getAttribLocation(program, "a_position");
  texcoordLocation = gl.getAttribLocation(program, "a_texCoord");

  // Uniform locations
  resolutionLocation = gl.getUniformLocation(program, "u_resolution");
  mouseLocation = gl.getUniformLocation(program, "u_mouse");
  mposLocation = gl.getUniformLocation(program, "u_mpos");
  zoomLocation = gl.getUniformLocation(program, "u_zoom");
  snapLocation = gl.getUniformLocation(program, "u_snap");
  image0Location = gl.getUniformLocation(program, "u_image0");
  image1Location = gl.getUniformLocation(program, "u_image1");
  image2Location = gl.getUniformLocation(program, "u_image2");

  // Static sampler bindings (texture units never change)
  gl.uniform1i(image0Location, 0);
  gl.uniform1i(image1Location, 1);
  gl.uniform1i(image2Location, 2);
};

export const render = (gl, program, textures, images, state) => {
  if (!(images.length > 0) || !(images[0]?.width > 0)) {
    return;
  }

  gl.useProgram(program);

  // Bind position buffer and attribute
  gl.enableVertexAttribArray(positionLocation);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  // Bind texcoord buffer and attribute
  gl.enableVertexAttribArray(texcoordLocation);
  gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer);
  gl.vertexAttribPointer(texcoordLocation, 2, gl.FLOAT, false, 0, 0);

  // Update dynamic uniforms
  gl.uniform2f(resolutionLocation, gl.canvas.width, gl.canvas.height);
  gl.uniform2f(mouseLocation, state.mousePos.x, state.mousePos.y);
  gl.uniform2i(mposLocation, Math.round(state.mpos.x), Math.round(state.mpos.y));
  gl.uniform1f(zoomLocation, state.zoom);
  gl.uniform1f(snapLocation, state.snapRadius);

  // Bind textures
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, textures[0]);

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, textures[1]);

  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, textures[2]);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
  if (state.showArea) {
    state.npixels = readPixels(gl);
  }
};
