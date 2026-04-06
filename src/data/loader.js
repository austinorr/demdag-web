import { fromArrayBuffer } from "geotiff";

const tiffCache = {};

export const loadImage = (url) => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "Anonymous"; // to avoid CORS if used with Canvas

    // Set up the load and error event handlers before setting the src
    // to avoid a race condition if the image loads very quickly.
    img.onload = () => resolve(img);
    img.onerror = (error) => reject(error);

    // Set the source to start loading the image.
    img.src = url;
  });
};

export const loadTiff = async (url) => {
  if (!tiffCache?.[url]) {
    let image;
    console.debug("fetching:", url);
    const response = await fetch(url);

    const arrayBuffer = await response.arrayBuffer();
    const tiff = await fromArrayBuffer(arrayBuffer);
    const imageTiff = await tiff.getImage();
    const width = imageTiff.getWidth();
    const height = imageTiff.getHeight();

    if (url.includes("_discovery") || url.includes("_finish")) {
      const geoTiffDataBands = await imageTiff.readRasters();
      const geoTiffData = geoTiffDataBands[0];

      // Pass raw Int32Array directly — uploaded as R32I integer texture in WebGL 2
      const rawInt32 =
        geoTiffData instanceof Int32Array
          ? geoTiffData
          : new Int32Array(geoTiffData.buffer, geoTiffData.byteOffset, geoTiffData.length);

      image = {
        width,
        height,
        _raw_data: rawInt32,
      };

      console.debug("data: ", image, url);
    } else {
      const geoTiffDataRGB = await imageTiff.readRGB();

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const imageData = ctx.getImageData(0, 0, width, height);
      const data = imageData.data; // array of RGBA values

      // convert GeoTiff's RGB values to ImageData's RGBA values
      for (let i = 0; i < height; i++) {
        for (let j = 0; j < width; j++) {
          const srcIdx = 3 * i * width + 3 * j;
          const idx = 4 * i * width + 4 * j;
          data[idx] = geoTiffDataRGB[srcIdx];
          data[idx + 1] = geoTiffDataRGB[srcIdx + 1];
          data[idx + 2] = geoTiffDataRGB[srcIdx + 2];
          data[idx + 3] = 255; // fully opaque
        }
      }
      console.debug("imdata: ", imageData);
      ctx.putImageData(imageData, 0, 0);

      image = imageData;
    }
    tiffCache[url] = image;
  }

  return tiffCache[url];
};

const imLoad = async (url) => {
  if (url.endsWith(".tif") || url.endsWith(".tiff")) {
    return loadTiff(url);
  } else {
    return loadImage(url);
  }
};

export const loadImages = async (urls) => {
  console.debug("urls:", urls);
  return Promise.all(urls.map(imLoad));
};
