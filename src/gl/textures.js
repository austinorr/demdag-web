export const createIntTexture = (gl, data, width, height) => {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32UI,
    width,
    height,
    0,
    gl.RED_INTEGER,
    gl.UNSIGNED_INT,
    data,
  );
  return tex;
};

export const createTextures = (gl, images) => {
  const textures = [];
  for (let ii = 0; ii < images.length; ++ii) {
    if (images[ii]?._raw_data) {
      textures.push(
        createIntTexture(gl, images[ii]._raw_data, images[ii].width, images[ii].height),
      );
      continue;
    }

    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    if (images[ii]?.data) {
      // RGBA Uint8 data (e.g. ImageData)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        images[ii].width,
        images[ii].height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        images[ii].data,
      );
    } else {
      // HTMLImageElement / ImageBitmap
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        images[ii],
      );
    }

    textures.push(texture);
  }
  return textures;
};
