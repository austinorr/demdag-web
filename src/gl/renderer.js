import { setRectangle } from "./buffers.js";
import { readPixels } from "./readback.js";

export const render = (gl, program, textures, images, state) => {
  if (!(images.length > 0) || !(images[0]?.width > 0)) {
    return;
  }
  // Create a buffer to put three 2d clip space points in
  let positionBuffer = gl.createBuffer();

  // Bind it to ARRAY_BUFFER (think of it as ARRAY_BUFFER = positionBuffer)
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  // Set a rectangle the same size as the image.
  setRectangle(gl, 0, 0, images[0].width, images[0].height);

  // look up where the vertex data needs to go.
  let positionLocation = gl.getAttribLocation(program, "a_position");
  let texcoordLocation = gl.getAttribLocation(program, "a_texCoord");

  // provide texture coordinates for the rectangle.
  let texcoordBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0,
    ]),
    gl.STATIC_DRAW
  );

  // lookup uniforms
  let resolutionLocation = gl.getUniformLocation(program, "u_resolution");
  let mouseLocation = gl.getUniformLocation(program, "u_mouse");
  let umpos = gl.getUniformLocation(program, "u_mpos");
  let uzoom = gl.getUniformLocation(program, "u_zoom");
  let usnap = gl.getUniformLocation(program, "u_snap");

  // lookup the sampler locations.
  let u_image0Location = gl.getUniformLocation(program, "u_image0");
  let u_image1Location = gl.getUniformLocation(program, "u_image1");
  let u_image2Location = gl.getUniformLocation(program, "u_image2");

  // Tell it to use our program (pair of shaders)
  gl.useProgram(program);

  // Turn on the position attribute
  gl.enableVertexAttribArray(positionLocation);

  // Bind the position buffer.
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);

  // Tell the position attribute how to get data out of positionBuffer (ARRAY_BUFFER)
  gl.vertexAttribPointer(
    positionLocation,
    2, // 2 components per iteration
    gl.FLOAT, // the data is 32bit floats
    false, // don't normalize the data
    0, // 0 = move forward size * sizeof(type) each iteration to get the next position
    0 // start at the beginning of the buffer
  );

  // Turn on the texcoord attribute
  gl.enableVertexAttribArray(texcoordLocation);

  // bind the texcoord buffer.
  gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer);

  // Tell the texcoord attribute how to get data out of texcoordBuffer (ARRAY_BUFFER)
  gl.vertexAttribPointer(
    texcoordLocation,
    2, // 2 components per iteration
    gl.FLOAT, // the data is 32bit floats
    false, // don't normalize the data
    0, // 0 = move forward size * sizeof(type) each iteration to get the next position
    0 // start at the beginning of the buffer
  );

  // set the resolution
  gl.uniform2f(resolutionLocation, gl.canvas.width, gl.canvas.height);
  gl.uniform2f(mouseLocation, state.mousePos.x, state.mousePos.y);
  gl.uniform2f(umpos, state.mpos.x, state.mpos.y);
  gl.uniform1f(uzoom, state.zoom);
  gl.uniform1f(usnap, state.snapRadius);

  // set which texture units to render with.
  gl.uniform1i(u_image0Location, 0); // texture unit 0
  gl.uniform1i(u_image1Location, 1); // texture unit 1
  gl.uniform1i(u_image2Location, 2); // texture unit 2

  // Set each texture unit to use a particular texture.
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
  gl.finish();
};
