import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import proj4 from "proj4";

import {
  openCOG,
  closeCOG,
  getCOGInfo,
  getOverviewLevels,
  getCOGImage,
} from "./cog-source.js";
import { createWatershedLayer, GRID_N } from "./watershed-layer.js";
import { createIntTexture } from "../gl/textures.js";
import { snapToMaxAcc } from "../snap.js";

// Below this zoom no raster data is loaded or drawn: a nationwide viewport
// would intersect well over a hundred HUC04 pairs.
const MINZOOM = 6;
// Discovery value of cells outside the flow graph (DFS counter starts at 1).
const NODATA = 0;
// Byte cap on the shared tile cache; cleared wholesale when exceeded.
const TILE_CACHE_BYTES = 256 * 1024 * 1024;

// Register a CRS definition with proj4, fetching from epsg.io if needed
const ensureCRS = async (epsg) => {
  const code = `EPSG:${epsg}`;
  if (proj4.defs(code)) return code;

  const resp = await fetch(`https://epsg.io/${epsg}.proj4`);
  if (!resp.ok) throw new Error(`Unknown CRS: ${code}`);
  const def = await resp.text();
  proj4.defs(code, def.trim());
  return code;
};

const DEBUG = new URLSearchParams(window.location.search).has("debug");

const toUint32 = (raw) =>
  raw instanceof Uint32Array
    ? raw
    : new Uint32Array(raw.buffer, raw.byteOffset, raw.length);

// bbox = [w, s, e, n] in degrees; bounds = maplibregl.LngLatBounds
const bboxIntersects = (bbox, bounds) =>
  bbox[0] < bounds.getEast() &&
  bbox[2] > bounds.getWest() &&
  bbox[1] < bounds.getNorth() &&
  bbox[3] > bounds.getSouth();

export const initSlippyMap = async (container, manifestUrl, appState) => {
  // Manifest: [{ id, bbox: [w, s, e, n] }, ...]. Pair files live at
  // huc04/{id}/fdr_discovery.tif and huc04/{id}/fdr_finish.tif beside it.
  const resp = await fetch(manifestUrl);
  if (!resp.ok) throw new Error(`manifest fetch failed: ${resp.status}`);
  const manifest = await resp.json();
  const manifestBase = new URL(manifestUrl, window.location.href);
  const urlFor = (id, name) => new URL(`huc04/${id}/${name}`, manifestBase).href;

  // Initial view: centre of the union of all bboxes
  const union = manifest.reduce(
    (u, e) => [
      Math.min(u[0], e.bbox[0]),
      Math.min(u[1], e.bbox[1]),
      Math.max(u[2], e.bbox[2]),
      Math.max(u[3], e.bbox[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  const center = [(union[0] + union[2]) / 2, (union[1] + union[3]) / 2];

  const watershedLayer = createWatershedLayer("watershed-overlay", NODATA);

  const basemaps = {
    osm: {
      label: "OSM",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "&copy; OpenStreetMap contributors",
      maxzoom: 19,
    },
    satellite: {
      label: "Satellite",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "&copy; Esri, Maxar, Earthstar Geographics",
      maxzoom: 19,
    },
    topo: {
      label: "Topo",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "&copy; Esri, USGS, NOAA",
      maxzoom: 19,
    },
    str: {
      label: "USGS NHD",
      tiles: [
        "https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution:
        'Tiles courtesy of the <a href="https://usgs.gov/">U.S. Geological Survey</a>',
      maxzoom: 16,
    },
  };

  // Build initial style with all basemap sources/layers; only "osm" visible
  const sources = {};
  const layers = [];
  for (const [key, bm] of Object.entries(basemaps)) {
    sources[`basemap-${key}`] = {
      type: "raster",
      tiles: bm.tiles,
      tileSize: bm.tileSize,
      attribution: bm.attribution,
    };
    layers.push({
      id: `basemap-${key}`,
      type: "raster",
      source: `basemap-${key}`,
      minzoom: 0,
      maxzoom: bm.maxzoom,
      layout: { visibility: key === "osm" ? "visible" : "none" },
    });
  }

  const swapBasemap = (key) => {
    for (const k of Object.keys(basemaps)) {
      map.setLayoutProperty(
        `basemap-${k}`,
        "visibility",
        k === key ? "visible" : "none",
      );
    }
  };

  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sources,
      layers,
    },
    center,
    zoom: MINZOOM,
  });

  // --- Datasets ---
  // One record per visible manifest entry, created lazily and released when it
  // leaves the view. The record doubles as the layer's render entry.
  const active = new Map(); // id -> ds
  const tileCache = new Map(); // `${id}:${level}:${tc}:${tr}` -> tile
  let tileCacheBytes = 0;

  const createDataset = (entry) => {
    const ds = {
      id: entry.id,
      entry,
      ready: null,
      // filled by ready
      discCog: null,
      finiCog: null,
      info: null,
      levels: null,
      toNative: null,
      fromNative: null,
      fullResZoom: 0,
      // loaded window state
      disc: null,
      fini: null,
      w: 0,
      h: 0,
      window: null, // [x0, y0, x1, y1] in full-res pixel space
      levelIndex: -1,
      loading: false,
      pending: false,
      // render entry
      tex: { disc: null, fini: null },
      grid: null,
      dv: 0,
      fv: 0,
      cursor: [-1, -1],
      active: false,
    };

    ds.ready = (async () => {
      const [discCog, finiCog] = await Promise.all([
        openCOG(urlFor(ds.id, "fdr_discovery.tif")),
        openCOG(urlFor(ds.id, "fdr_finish.tif")),
      ]);
      const info = await getCOGInfo(discCog);
      if (!info.epsg) throw new Error(`${ds.id}: COG has no EPSG code`);
      const crs = await ensureCRS(info.epsg);
      ds.discCog = discCog;
      ds.finiCog = finiCog;
      ds.info = info;
      ds.levels = await getOverviewLevels(discCog);
      ds.toNative = proj4("EPSG:4326", crs);
      ds.fromNative = proj4(crs, "EPSG:4326");
      // Map zoom z has ~156543/2^z m/px at the equator; find the zoom where
      // that matches this dataset's full-res pixel size.
      ds.fullResZoom = Math.log2(156543.03 / Math.abs(info.resolution[0]));
    })();
    ds.ready.catch((e) => console.error(`dataset ${ds.id} failed to open:`, e));

    return ds;
  };

  const releaseDataset = (ds) => {
    const gl = map.painter.context.gl;
    if (ds.tex.disc) gl.deleteTexture(ds.tex.disc);
    if (ds.tex.fini) gl.deleteTexture(ds.tex.fini);
    ds.tex.disc = ds.tex.fini = null;
    ds.disc = ds.fini = null;
    ds.window = null;
    ds.grid = null;
    ds.active = false;
    active.delete(ds.id);
    // Drop the geotiff handles (each keeps its own block cache). Reopening
    // later costs one small header request.
    closeCOG(urlFor(ds.id, "fdr_discovery.tif"));
    closeCOG(urlFor(ds.id, "fdr_finish.tif"));
  };

  // Coordinate transforms (full-res pixel space of one dataset)
  const lngLatToPixel = (ds, lng, lat) => {
    const { origin, resolution } = ds.info;
    const [x, y] = ds.toNative.forward([lng, lat]);
    return {
      x: (x - origin[0]) / resolution[0],
      y: (y - origin[1]) / resolution[1],
    };
  };

  const pixelToLngLat = (ds, col, row) => {
    const { origin, resolution } = ds.info;
    const x = origin[0] + col * resolution[0];
    const y = origin[1] + row * resolution[1];
    return ds.fromNative.forward([x, y]);
  };

  // Visible bounding box in full-res pixel space, clamped to the raster.
  const getVisibleWindow = (ds) => {
    const b = map.getBounds();
    const samples = [
      lngLatToPixel(ds, b.getWest(), b.getNorth()),
      lngLatToPixel(ds, b.getEast(), b.getNorth()),
      lngLatToPixel(ds, b.getEast(), b.getSouth()),
      lngLatToPixel(ds, b.getWest(), b.getSouth()),
    ];
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const p of samples) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    return [
      Math.max(0, Math.floor(x0)),
      Math.max(0, Math.floor(y0)),
      Math.min(ds.info.width, Math.ceil(x1)),
      Math.min(ds.info.height, Math.ceil(y1)),
    ];
  };

  const needsReload = (ds, levelIndex, visWindow) => {
    if (!ds.window || levelIndex !== ds.levelIndex) return true;
    return (
      visWindow[0] < ds.window[0] ||
      visWindow[1] < ds.window[1] ||
      visWindow[2] > ds.window[2] ||
      visWindow[3] > ds.window[3]
    );
  };

  // Map zoom level to COG image index. levels[0] = full-res, levels[N] = coarsest.
  const zoomToLevel = (ds, z) => {
    const maxOverview = ds.levels.length - 1;
    const stepsCoarser = Math.max(0, Math.floor(ds.fullResZoom - z));
    return ds.levels[Math.min(maxOverview, stepsCoarser)];
  };

  // Fetch a single tile from both COGs of a dataset at a given level.
  const fetchTile = async (ds, levelIndex, tc, tr) => {
    const key = `${ds.id}:${levelIndex}:${tc}:${tr}`;
    if (tileCache.has(key)) return tileCache.get(key);

    const TILE = ds.info.tileSize;
    const [image0, image1] = await Promise.all([
      getCOGImage(ds.discCog, levelIndex),
      getCOGImage(ds.finiCog, levelIndex),
    ]);

    const imgW = image0.getWidth();
    const imgH = image0.getHeight();
    const x0 = tc * TILE;
    const y0 = tr * TILE;
    const x1 = Math.min(imgW, x0 + TILE);
    const y1 = Math.min(imgH, y0 + TILE);
    if (x0 >= imgW || y0 >= imgH) return null;

    const window = [x0, y0, x1, y1];
    const [discRasters, finiRasters] = await Promise.all([
      image0.readRasters({ window }),
      image1.readRasters({ window }),
    ]);

    const tile = {
      disc: toUint32(discRasters[0]),
      fini: toUint32(finiRasters[0]),
      w: x1 - x0,
      h: y1 - y0,
    };

    const bytes = tile.w * tile.h * 8;
    if (tileCacheBytes + bytes > TILE_CACHE_BYTES) {
      tileCache.clear();
      tileCacheBytes = 0;
    }
    tileCache.set(key, tile);
    tileCacheBytes += bytes;
    return tile;
  };

  // Assemble tiles into a single texture-sized buffer pair
  const assembleTiles = (tiles, tilesX, tilesY, totalW, totalH, TILE) => {
    const disc = new Uint32Array(totalW * totalH);
    const fini = new Uint32Array(totalW * totalH);

    for (let tr = 0; tr < tilesY; tr++) {
      for (let tc = 0; tc < tilesX; tc++) {
        const tile = tiles[tr * tilesX + tc];
        if (!tile) continue;
        const dstX = tc * TILE;
        const dstY = tr * TILE;
        for (let row = 0; row < tile.h; row++) {
          const srcOff = row * tile.w;
          const dstOff = (dstY + row) * totalW + dstX;
          disc.set(tile.disc.subarray(srcOff, srcOff + tile.w), dstOff);
          fini.set(tile.fini.subarray(srcOff, srcOff + tile.w), dstOff);
        }
      }
    }
    return { disc, fini };
  };

  const loadVisibleData = async (ds) => {
    if (ds.loading) {
      ds.pending = true;
      return;
    }
    ds.loading = true;
    try {
      await ds.ready;
      if (active.get(ds.id) !== ds) return; // released while opening

      const level = zoomToLevel(ds, map.getZoom());
      const visWindow = getVisibleWindow(ds);
      if (visWindow[2] - visWindow[0] <= 0 || visWindow[3] - visWindow[1] <= 0)
        return;
      if (!needsReload(ds, level.index, visWindow)) return;

      const { width, height, tileSize: TILE } = ds.info;
      const scaleX = level.width / width;
      const scaleY = level.height / height;

      // Tile range in overview pixel space
      const tc0 = Math.max(0, Math.floor((visWindow[0] * scaleX) / TILE));
      const tr0 = Math.max(0, Math.floor((visWindow[1] * scaleY) / TILE));
      const tc1 = Math.ceil((visWindow[2] * scaleX) / TILE);
      const tr1 = Math.ceil((visWindow[3] * scaleY) / TILE);
      const tilesX = tc1 - tc0;
      const tilesY = tr1 - tr0;
      if (tilesX <= 0 || tilesY <= 0) return;

      const totalW = Math.min(level.width - tc0 * TILE, tilesX * TILE);
      const totalH = Math.min(level.height - tr0 * TILE, tilesY * TILE);

      console.debug(
        `[${ds.id}] level=${level.index} tiles=[${tc0},${tr0}]→[${tc1},${tr1}] (${tilesX}x${tilesY}, ${totalW}x${totalH}px)`,
      );

      const tilePromises = [];
      for (let tr = tr0; tr < tr1; tr++) {
        for (let tc = tc0; tc < tc1; tc++) {
          tilePromises.push(fetchTile(ds, level.index, tc, tr));
        }
      }
      const tiles = await Promise.all(tilePromises);
      if (active.get(ds.id) !== ds) return; // released while fetching

      const { disc, fini } = assembleTiles(
        tiles,
        tilesX,
        tilesY,
        totalW,
        totalH,
        TILE,
      );

      ds.levelIndex = level.index;
      ds.disc = disc;
      ds.fini = fini;
      ds.w = totalW;
      ds.h = totalH;
      // Back-project tile-aligned window to full-res space (for needsReload/cursor)
      ds.window = [
        (tc0 * TILE) / scaleX,
        (tr0 * TILE) / scaleY,
        (tc0 * TILE + totalW) / scaleX,
        (tr0 * TILE + totalH) / scaleY,
      ];

      const gl = map.painter.context.gl;
      if (ds.tex.disc) gl.deleteTexture(ds.tex.disc);
      if (ds.tex.fini) gl.deleteTexture(ds.tex.fini);
      ds.tex.disc = createIntTexture(gl, disc, totalW, totalH);
      ds.tex.fini = createIntTexture(gl, fini, totalW, totalH);

      // (GRID_N+1)^2 lng/lat points for the reprojection mesh
      const grid = [];
      const [wx0, wy0] = ds.window;
      const ww = ds.window[2] - wx0;
      const wh = ds.window[3] - wy0;
      for (let row = 0; row <= GRID_N; row++) {
        for (let col = 0; col <= GRID_N; col++) {
          grid.push(
            pixelToLngLat(ds, wx0 + (col / GRID_N) * ww, wy0 + (row / GRID_N) * wh),
          );
        }
      }
      ds.grid = grid;

      if (DEBUG) {
        updateDebugBoundaries(ds, tc0, tr0, tc1, tr1, scaleX, scaleY);
      }
      map.triggerRepaint();
    } catch (e) {
      console.error(`[${ds.id}] failed to load tiles:`, e);
    } finally {
      ds.loading = false;
      if (ds.pending) {
        ds.pending = false;
        loadVisibleData(ds);
      }
    }
  };

  // Sync the active dataset set with the viewport and (re)load each one.
  const update = () => {
    const z = map.getZoom();
    const bounds = map.getBounds();
    const visible =
      z >= MINZOOM ? manifest.filter((e) => bboxIntersects(e.bbox, bounds)) : [];
    const visibleIds = new Set(visible.map((e) => e.id));

    for (const ds of [...active.values()]) {
      if (!visibleIds.has(ds.id)) releaseDataset(ds);
    }
    for (const e of visible) {
      if (!active.has(e.id)) active.set(e.id, createDataset(e));
    }
    watershedLayer.setEntries([...active.values()]);

    for (const e of visible) loadVisibleData(active.get(e.id));
    if (visible.length === 0) map.triggerRepaint();
  };

  // Helper: convert a pixel-space rect [x0,y0,x1,y1] to a GeoJSON polygon
  const pixelRectToGeoJSON = (ds, x0, y0, x1, y1) => {
    const tl = pixelToLngLat(ds, x0, y0);
    const tr = pixelToLngLat(ds, x1, y0);
    const br = pixelToLngLat(ds, x1, y1);
    const bl = pixelToLngLat(ds, x0, y1);
    return {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[tl, tr, br, bl, tl]] },
    };
  };

  // Debug overlays show the most recently loaded dataset only.
  const updateDebugBoundaries = (ds, tc0, tr0, tc1, tr1, scaleX, scaleY) => {
    const TILE = ds.info.tileSize;
    const w = ds.window;
    const fetchWindowGeo = {
      type: "FeatureCollection",
      features: [pixelRectToGeoJSON(ds, w[0], w[1], w[2], w[3])],
    };

    const tileFeatures = [];
    for (let tr = tr0; tr < tr1; tr++) {
      for (let tc = tc0; tc < tc1; tc++) {
        tileFeatures.push(
          pixelRectToGeoJSON(
            ds,
            (tc * TILE) / scaleX,
            (tr * TILE) / scaleY,
            ((tc + 1) * TILE) / scaleX,
            ((tr + 1) * TILE) / scaleY,
          ),
        );
      }
    }
    const tilesGeo = { type: "FeatureCollection", features: tileFeatures };

    if (map.getSource("debug-fetch-window")) {
      map.getSource("debug-fetch-window").setData(fetchWindowGeo);
      map.getSource("debug-tiles").setData(tilesGeo);
    }
  };

  // Outline of every manifest bbox (debug aid, toggled in the layers panel)
  let showBoxes = false;
  let showStreams = true;
  const bboxGeoJSON = {
    type: "FeatureCollection",
    features: manifest.map((e) => {
      const [w, s, ea, n] = e.bbox;
      return {
        type: "Feature",
        properties: { id: e.id },
        geometry: {
          type: "Polygon",
          coordinates: [[[w, n], [ea, n], [ea, s], [w, s], [w, n]]],
        },
      };
    }),
  };

  // Add custom layers (called on initial load + after basemap switch)
  const addOverlayLayers = () => {
    if (!map.getSource("manifest-bboxes")) {
      map.addSource("manifest-bboxes", { type: "geojson", data: bboxGeoJSON });
      map.addLayer({
        id: "manifest-bboxes-line",
        type: "line",
        source: "manifest-bboxes",
        layout: { visibility: showBoxes ? "visible" : "none" },
        paint: { "line-color": "#d33", "line-width": 1.5, "line-opacity": 0.7 },
      });
      map.addLayer({
        id: "manifest-bboxes-label",
        type: "symbol",
        source: "manifest-bboxes",
        layout: {
          visibility: showBoxes ? "visible" : "none",
          "text-field": ["get", "id"],
          "text-size": 11,
          "text-anchor": "top-left",
          "text-offset": [0.3, 0.3],
        },
        paint: { "text-color": "#d33", "text-halo-color": "#fff", "text-halo-width": 1 },
      });
    }
    if (!map.getLayer(watershedLayer.id)) {
      map.addLayer(watershedLayer);
    }
    if (DEBUG) {
      if (!map.getSource("debug-fetch-window")) {
        map.addSource("debug-fetch-window", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addSource("debug-tiles", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "debug-fetch-window-fill",
          type: "fill",
          source: "debug-fetch-window",
          paint: { "fill-color": "#ff0000", "fill-opacity": 0.5 },
        });
        map.addLayer({
          id: "debug-fetch-window-line",
          type: "line",
          source: "debug-fetch-window",
          paint: { "line-color": "#ff0000", "line-width": 2 },
        });
        map.addLayer({
          id: "debug-tiles-line",
          type: "line",
          source: "debug-tiles",
          paint: { "line-color": "#00ff00", "line-width": 1 },
        });
      }
    }
  };

  const setShowBoxes = (v) => {
    showBoxes = v;
    for (const id of ["manifest-bboxes-line", "manifest-bboxes-label"]) {
      if (map.getLayer(id))
        map.setLayoutProperty(id, "visibility", v ? "visible" : "none");
    }
  };

  const setShowStreams = (v) => {
    showStreams = v;
    watershedLayer.setShowStreams(v);
    map.triggerRepaint();
  };

  // Layers control
  let activeBasemap = "osm";

  class LayersControl {
    onAdd(mapRef) {
      this._map = mapRef;

      const root = document.createElement("div");
      root.className = "maplibregl-ctrl maplibregl-ctrl-group";
      root.style.cssText = "position:relative;";

      // Toggle button — stacked layers icon
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.title = "Layers";
      toggle.style.cssText =
        "width:29px;height:29px;display:flex;align-items:center;justify-content:center;cursor:pointer;background:none;border:none;padding:0;";
      toggle.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`;
      root.appendChild(toggle);

      // Dropdown panel
      const panel = document.createElement("div");
      panel.style.cssText =
        "display:none;position:absolute;top:0;right:34px;background:#fff;border-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,0.3);padding:8px 0;min-width:140px;font-family:sans-serif;font-size:13px;z-index:1;";

      const header = document.createElement("div");
      header.textContent = "Basemap";
      header.style.cssText =
        "padding:4px 12px 6px;font-weight:600;font-size:11px;text-transform:uppercase;color:#666;letter-spacing:0.5px;";
      panel.appendChild(header);

      const radios = {};
      for (const [key, bm] of Object.entries(basemaps)) {
        const row = document.createElement("label");
        row.style.cssText =
          "display:flex;align-items:center;gap:6px;padding:4px 12px;cursor:pointer;";
        row.addEventListener(
          "mouseenter",
          () => (row.style.background = "#f0f0f0"),
        );
        row.addEventListener(
          "mouseleave",
          () => (row.style.background = "none"),
        );

        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "basemap";
        radio.checked = key === activeBasemap;
        radio.style.cssText = "margin:0;";
        radios[key] = radio;

        radio.addEventListener("change", () => {
          activeBasemap = key;
          swapBasemap(key);
        });

        const label = document.createElement("span");
        label.textContent = bm.label;

        row.appendChild(radio);
        row.appendChild(label);
        panel.appendChild(row);
      }

      // Overlay toggles
      const header2 = document.createElement("div");
      header2.textContent = "Overlays";
      header2.style.cssText = header.style.cssText + "margin-top:6px;";
      panel.appendChild(header2);

      const overlays = [
        { label: "Streams", get: () => showStreams, set: setShowStreams },
        { label: "HUC04 boxes", get: () => showBoxes, set: setShowBoxes },
      ];
      for (const ov of overlays) {
        const row = document.createElement("label");
        row.style.cssText =
          "display:flex;align-items:center;gap:6px;padding:4px 12px;cursor:pointer;";
        row.addEventListener(
          "mouseenter",
          () => (row.style.background = "#f0f0f0"),
        );
        row.addEventListener(
          "mouseleave",
          () => (row.style.background = "none"),
        );
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = ov.get();
        box.style.cssText = "margin:0;";
        box.addEventListener("change", () => ov.set(box.checked));
        const label = document.createElement("span");
        label.textContent = ov.label;
        row.appendChild(box);
        row.appendChild(label);
        panel.appendChild(row);
      }

      root.appendChild(panel);

      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = panel.style.display === "none";
        panel.style.display = open ? "block" : "none";
      });

      // Close on outside click
      document.addEventListener("click", () => {
        panel.style.display = "none";
      });
      panel.addEventListener("click", (e) => e.stopPropagation());

      this._container = root;
      this._radios = radios;
      return root;
    }
    onRemove() {
      this._container.remove();
    }
  }

  map.addControl(new LayersControl(), "top-right");

  // Cursor: find the first active dataset with real data under the cursor,
  // snap within it, and make it the only one that draws. If nothing is hit
  // (outside all rasters, or over nodata) the previous selection stays.
  const updateCursor = (lng, lat) => {
    let hit = null;
    let hx = 0;
    let hy = 0;
    for (const ds of active.values()) {
      if (!ds.disc || !ds.window) continue;
      const { x, y } = lngLatToPixel(ds, lng, lat);
      if (x < 0 || x >= ds.info.width || y < 0 || y >= ds.info.height) continue;

      const winW = ds.window[2] - ds.window[0];
      const winH = ds.window[3] - ds.window[1];
      const dataX = ((x - ds.window[0]) / winW) * ds.w;
      const dataY = ((y - ds.window[1]) / winH) * ds.h;
      if (dataX < 0 || dataX >= ds.w || dataY < 0 || dataY >= ds.h) continue;

      const idx = Math.floor(dataY) * ds.w + Math.floor(dataX);
      if (ds.disc[idx] === NODATA) continue;

      hit = ds;
      hx = dataX;
      hy = dataY;
      break;
    }
    if (!hit) return;

    const snapped = snapToMaxAcc(
      hx,
      hy,
      appState.snapRadius,
      hit.disc,
      hit.fini,
      hit.w,
      hit.h,
      NODATA,
    );
    const tx = Math.floor(snapped.x);
    const ty = Math.floor(snapped.y);
    const idx = ty * hit.w + tx;

    for (const ds of active.values()) ds.active = ds === hit;
    hit.dv = hit.disc[idx];
    hit.fv = hit.fini[idx];
    hit.cursor = [tx, ty];
    map.triggerRepaint();
  };

  // Wait for map load
  await new Promise((resolve) => {
    map.once("load", () => {
      addOverlayLayers();
      update();

      map.on("zoomend", update);
      map.on("moveend", update);

      // Touch: single finger = cursor, two fingers = pan
      const canvas = map.getCanvasContainer();
      canvas.addEventListener(
        "touchstart",
        (e) => {
          if (e.touches.length >= 2) {
            map.dragPan.enable();
          } else {
            map.dragPan.disable();
          }
        },
        { passive: true },
      );
      canvas.addEventListener(
        "touchend",
        (e) => {
          if (e.touches.length === 0) {
            map.dragPan.enable();
          }
        },
        { passive: true },
      );
      canvas.addEventListener(
        "touchmove",
        (e) => {
          if (e.touches.length === 1) {
            const touch = e.touches[0];
            const rect = canvas.getBoundingClientRect();
            const x = touch.clientX - rect.left;
            const y = touch.clientY - rect.top;
            const lngLat = map.unproject([x, y]);
            updateCursor(lngLat.lng, lngLat.lat);
          }
        },
        { passive: true },
      );

      map.on("mousemove", (e) => {
        updateCursor(e.lngLat.lng, e.lngLat.lat);
      });

      resolve();
    });
  });

  return map;
};
