export const readPixels = (gl) => {
  // the pixels with blue channel set to 255 are 'in' the watershed.
  // this will add them up and render the result to the page.
  let w_size = 0;
  const width = gl.canvas.width;
  const height = gl.canvas.height;
  const pixels = new Uint8Array(width * height * 4); // 4 for RGBA
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  for (let i = 0; i < height; i++) {
    for (let j = 0; j < width; j++) {
      const idx = 4 * i * width + 4 * j;

      if (pixels[idx + 2] >= 255) {
        w_size += 1;
      }
    }
  }
  return w_size;
};
