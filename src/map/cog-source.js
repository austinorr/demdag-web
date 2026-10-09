import { fromCustomClient, BaseClient, BaseResponse } from "geotiff";

// Cache open COG handles and image objects
const cogCache = {};
const imageCache = new Map(); // key: `${url}:${index}`

// Fetch client that only accepts partial (206) responses. If the server
// ignores the Range header, geotiff.js throws but leaves the response body
// streaming, and the browser downloads the entire file in the background.
// Seen on Cloudflare with objects over its 512 MB cache limit: the first
// range request came back as a full-file 200. Cancel the body right away.
class RangeOnlyResponse extends BaseResponse {
  constructor(response) {
    super();
    this.response = response;
  }
  get status() {
    return this.response.status;
  }
  getHeader(name) {
    return this.response.headers.get(name);
  }
  getData() {
    return this.response.arrayBuffer();
  }
}

class RangeOnlyClient extends BaseClient {
  async request({ headers, signal } = {}) {
    // Files over Cloudflare's 512 MB cache limit are edge-BYPASS; their first
    // cold range request has come back as a full-file 200, the next as 206.
    // Cancel the body, retry once, then give up.
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(this.url, { headers, signal });
      if (!headers?.Range || response.status === 206) {
        return new RangeOnlyResponse(response);
      }
      response.body?.cancel();
      if (attempt >= 1) {
        throw new Error(
          `${this.url}: range request answered with ${response.status}, not 206`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export const openCOG = async (url) => {
  if (!cogCache[url]) {
    cogCache[url] = await fromCustomClient(new RangeOnlyClient(url));
  }
  return cogCache[url];
};

// Forget a handle and its image cache so its block cache can be collected.
export const closeCOG = (url) => {
  const cog = cogCache[url];
  if (!cog) return;
  imageCache.delete(cog);
  delete cogCache[url];
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
