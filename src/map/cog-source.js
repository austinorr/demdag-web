import { fromUrl } from "geotiff";

// Cache open COG handles and image objects
const cogCache = {};
const imageCache = new Map(); // key: `${url}:${index}`

export const openCOG = async (url) => {
  if (!cogCache[url]) {
    cogCache[url] = await fromUrl(url);
  }
  return cogCache[url];
};

// Get the full resolution image dimensions and geotransform info
export const getCOGInfo = async (cog) => {
  const image = await cog.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bbox = image.getBoundingBox();
  const origin = image.getOrigin();
  const resolution = image.getResolution();
  const tileSize = image.getTileWidth();

  // Extract EPSG code from GeoKeys
  const geoKeys = image.getGeoKeys();
  const epsg =
    geoKeys.ProjectedCSTypeGeoKey ||
    geoKeys.GeographicTypeGeoKey ||
    null;

  return { width, height, bbox, origin, resolution, tileSize, epsg };
};

// Get overview level info: returns array of { index, width, height }
// index 0 = full res, index N = coarsest
export const getOverviewLevels = async (cog) => {
  const imageCount = await cog.getImageCount();
  const levels = [];
  for (let i = 0; i < imageCount; i++) {
    const img = await cog.getImage(i);
    levels.push({ index: i, width: img.getWidth(), height: img.getHeight() });
  }
  return levels;
};

// Get a cached image handle for a specific COG + overview index
export const getCOGImage = async (cog, levelIndex) => {
  // Use the cog object reference + index as a cache key
  if (!imageCache.has(cog)) {
    imageCache.set(cog, {});
  }
  const cache = imageCache.get(cog);
  if (!cache[levelIndex]) {
    cache[levelIndex] = await cog.getImage(levelIndex);
  }
  return cache[levelIndex];
};
