// Snap-to-max-accumulation in raster space.
// Searches a circular neighborhood and returns the pixel with the highest
// flow accumulation (1 + finish - discovery).
export const snapToMaxAcc = (col, row, radius, discData, finiData, width, height) => {
  if (radius <= 0) return { x: col, y: row };

  const snap2 = radius * radius;
  let maxAcc = 0;
  let bestX = col;
  let bestY = row;

  const c0 = Math.floor(col);
  const r0 = Math.floor(row);

  for (let i = -radius; i <= radius; i++) {
    const c = Math.min(width - 1, Math.max(0, c0 + i));
    for (let j = -radius; j <= radius; j++) {
      const r = Math.min(height - 1, Math.max(0, r0 + j));
      if (i * i + j * j <= snap2) {
        const idx = r * width + c;
        const acc = 1 + finiData[idx] - discData[idx];
        if (acc > maxAcc) {
          maxAcc = acc;
          bestX = c;
          bestY = r;
        }
      }
    }
  }

  return { x: bestX, y: bestY };
};
