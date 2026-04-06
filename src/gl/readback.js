// Synchronous pixel readback with reused buffer.
// Counts pixels with blue channel = 255 (watershed area).

let pixelBuf = null;
let bufSize = 0;

export const readPixels = (gl) => {
  const width = gl.canvas.width;
  const height = gl.canvas.height;
  const needed = width * height * 4;

  // Reuse buffer across frames
  if (needed !== bufSize) {
    pixelBuf = new Uint8Array(needed);
    bufSize = needed;
  }

  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixelBuf);

  let count = 0;
  for (let i = 2; i < needed; i += 4) {
    if (pixelBuf[i] >= 255) {
      count++;
    }
  }
  return count;
};
