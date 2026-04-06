export const createTextures = (gl, images) => {
  const textures = [];
  for (let ii = 0; ii < images.length; ++ii) {
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);

    // Set the parameters so we can render any size image.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    if (images[ii]?._raw_data) {
      // Integer texture — upload raw Int32Array directly as R32I
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32I,
        images[ii].width,
        images[ii].height,
        0,
        gl.RED_INTEGER,
        gl.INT,
        images[ii]._raw_data,
      );
    } else if (images[ii]?.data) {
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
