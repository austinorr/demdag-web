import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import proj4 from "proj4";

import {
  openCOG,
  getCOGInfo,
  getOverviewLevels,
  getCOGImage,
} from "./cog-source.js";
import { createWatershedLayer } from "./watershed-layer.js";
import { snapToMaxAccOverview } from "./cursor.js";

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

export const initSlippyMap = async (
  container,
  cogDiscUrl,
  cogFiniUrl,
  appState,
) => {
  const [discCog, finiCog] = await Promise.all([
    openCOG(cogDiscUrl),
    openCOG(cogFiniUrl),
  ]);

  const info = await getCOGInfo(discCog);
  const { origin, resolution, width, height, bbox, tileSize, epsg } = info;

  if (!epsg) throw new Error("COG has no EPSG code in GeoKeys");
  const cogCRS = await ensureCRS(epsg);
  const toNative = proj4("EPSG:4326", cogCRS);
  const fromNative = proj4(cogCRS, "EPSG:4326");

  const levels = await getOverviewLevels(discCog);

  // Full COG corners in lng/lat
  const corners = [
    fromNative.forward([bbox[0], bbox[3]]),
    fromNative.forward([bbox[2], bbox[3]]),
    fromNative.forward([bbox[2], bbox[1]]),
    fromNative.forward([bbox[0], bbox[1]]),
  ];

  const centerNative = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  const [centerLng, centerLat] = fromNative.forward(centerNative);
  const [swLng, swLat] = corners[3];
  const [neLng, neLat] = corners[1];

  const watershedLayer = createWatershedLayer("watershed-overlay");

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
    style: { version: 8, sources, layers },
    center: [centerLng, centerLat],
    zoom: 6,
    maxBounds: [
      [swLng - 3, swLat - 3],
      [neLng + 3, neLat + 3],
    ],
    dragPan: false,
  });

  // Coordinate transforms
  const lngLatToPixel = (lng, lat) => {
    const [x, y] = toNative.forward([lng, lat]);
    return {
      x: (x - origin[0]) / resolution[0],
      y: (y - origin[1]) / resolution[1],
    };
  };

  const pixelToLngLat = (col, row) => {
    const x = origin[0] + col * resolution[0];
    const y = origin[1] + row * resolution[1];
    return fromNative.forward([x, y]);
  };

  // --- Data loading state ---
  let currentDiscData = null;
  let currentFiniData = null;
  let currentDataWidth = 0;
  let currentDataHeight = 0;
  let currentWindow = null; // [x0, y0, x1, y1] in full-res pixel space
  let currentLevelIndex = -1;
  let loading = false;

  // Compute visible bounding box in full-res pixel space.
  // Samples 8 points around the viewport boundary to handle
  // Albers projection distortion.
  const getVisibleWindow = () => {
    const bounds = map.getBounds();
    const w = bounds.getWest();
    const e = bounds.getEast();
    const n = bounds.getNorth();
    const s = bounds.getSouth();

    const samples = [
      lngLatToPixel(w, n),
      lngLatToPixel(e, n),
      lngLatToPixel(e, s),
      lngLatToPixel(w, s),
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
      Math.min(width, Math.ceil(x1)),
      Math.min(height, Math.ceil(y1)),
    ];
  };

  const needsReload = (newLevelIndex) => {
    if (!currentWindow || newLevelIndex !== currentLevelIndex) return true;
    const bounds = map.getBounds();
    const corners = [
      lngLatToPixel(bounds.getWest(), bounds.getNorth()),
      lngLatToPixel(bounds.getEast(), bounds.getNorth()),
      lngLatToPixel(bounds.getEast(), bounds.getSouth()),
      lngLatToPixel(bounds.getWest(), bounds.getSouth()),
    ];
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const p of corners) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    return (
      x0 < currentWindow[0] ||
      y0 < currentWindow[1] ||
      x1 > currentWindow[2] ||
      y1 > currentWindow[3]
    );
  };

  // Map zoom level to COG image index.
  // levels[0] = full-res, levels[N] = coarsest.
  // Each overview is ~2x reduction, each map zoom is ~2x magnification.
  // At the minimum useful zoom (~8), use the coarsest overview.
  // Each zoom step above that moves one level finer.
  // z15 = level 0 (full-res), z14 = level 1, z13 = level 2, etc.
  // Full-res pixel size in meters. Map zoom z has ~156543/2^z m/px at equator.
  // Find the zoom level where the map resolution matches full-res COG resolution.
  const pixelSizeM = Math.abs(resolution[0]);
  const fullResZoom = Math.log2(156543.03 / pixelSizeM); // ~14.26 for 10m

  const zoomToLevel = (z) => {
    const maxOverview = levels.length - 1;
    // How many 2x steps coarser than full-res do we need?
    const stepsCoarser = Math.max(0, Math.floor(fullResZoom - z));
    const levelIndex = Math.min(maxOverview, stepsCoarser);
    console.debug(
      `z=${z.toFixed(1)} fullResZoom=${fullResZoom.toFixed(1)} → level ${levelIndex} (${levels[levelIndex].width}x${levels[levelIndex].height})`,
    );
    return levels[levelIndex];
  };

  const toUint32 = (raw) =>
    raw instanceof Uint32Array
      ? raw
      : new Uint32Array(raw.buffer, raw.byteOffset, raw.length);

  const TILE = tileSize;

  // Cache of loaded tiles: key = `${levelIndex}:${tileCol}:${tileRow}`
  const tileCache = new Map();

  const tileKey = (levelIndex, tc, tr) => `${levelIndex}:${tc}:${tr}`;

  // Fetch a single tile from a COG at a given level.
  // Returns { disc: Uint32Array, fini: Uint32Array } or null.
  const fetchTile = async (levelIndex, tc, tr) => {
    const key = tileKey(levelIndex, tc, tr);
    if (tileCache.has(key)) return tileCache.get(key);

    const [image0, image1] = await Promise.all([
      getCOGImage(discCog, levelIndex),
      getCOGImage(finiCog, levelIndex),
    ]);

    const imgW = image0.getWidth();
    const imgH = image0.getHeight();

    const x0 = tc * TILE;
    const y0 = tr * TILE;
    const x1 = Math.min(imgW, x0 + TILE);
    const y1 = Math.min(imgH, y0 + TILE);

    if (x0 >= imgW || y0 >= imgH) return null;

    const window = [x0, y0, x1, y1];
    console.debug(
      `fetchTile level=${levelIndex} tile=[${tc},${tr}] window=[${window}] imgSize=${imgW}x${imgH} fetchedSize=${x1 - x0}x${y1 - y0}`,
    );

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

    tileCache.set(key, tile);
    // console.log(`cache length: ${tileCache.size}`);
    return tile;
  };

  // Assemble tiles into a single texture-sized buffer
  const assembleTiles = (tiles, tilesX, tilesY, totalW, totalH) => {
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

  const loadVisibleData = async () => {
    if (loading) return;

    const z = map.getZoom();
    const level = zoomToLevel(z);

    if (!needsReload(level.index)) return;

    const visWindow = getVisibleWindow();
    if (visWindow[2] - visWindow[0] <= 0 || visWindow[3] - visWindow[1] <= 0)
      return;

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
      `Loading level=${level.index} tiles=[${tc0},${tr0}]→[${tc1},${tr1}] (${tilesX}x${tilesY} tiles, ${totalW}x${totalH}px)`,
      `\n  scaleX=${scaleX} scaleY=${scaleY} fullRes=${width}x${height} ovRes=${level.width}x${level.height}`,
      `\n  visWindow=[${visWindow}] currentWindow=[${[(tc0 * TILE) / scaleX, (tr0 * TILE) / scaleY, (tc0 * TILE + totalW) / scaleX, (tr0 * TILE + totalH) / scaleY]}]`,
    );

    loading = true;
    try {
      // Fetch all visible tiles in parallel
      const tilePromises = [];
      for (let tr = tr0; tr < tr1; tr++) {
        for (let tc = tc0; tc < tc1; tc++) {
          tilePromises.push(fetchTile(level.index, tc, tr));
        }
      }
      const tiles = await Promise.all(tilePromises);

      // Assemble into contiguous buffers
      const { disc, fini } = assembleTiles(
        tiles,
        tilesX,
        tilesY,
        totalW,
        totalH,
      );

      currentLevelIndex = level.index;
      currentDiscData = disc;
      currentFiniData = fini;
      currentDataWidth = totalW;
      currentDataHeight = totalH;

      watershedLayer.setLevel(currentLevelIndex);

      // Back-project tile-aligned window to full-res space (for needsReload/cursor)
      currentWindow = [
        (tc0 * TILE) / scaleX,
        (tr0 * TILE) / scaleY,
        (tc0 * TILE + totalW) / scaleX,
        (tr0 * TILE + totalH) / scaleY,
      ];

      const gl = map.painter.context.gl;
      watershedLayer.updateTextures(gl, disc, fini, totalW, totalH);

      // Build 17x17 grid of lng/lat points for reprojection mesh
      const GRID_N = 16;
      const grid = [];
      const wx0 = currentWindow[0];
      const wy0 = currentWindow[1];
      const ww = currentWindow[2] - wx0;
      const wh = currentWindow[3] - wy0;
      for (let row = 0; row <= GRID_N; row++) {
        for (let col = 0; col <= GRID_N; col++) {
          const px = wx0 + (col / GRID_N) * ww;
          const py = wy0 + (row / GRID_N) * wh;
          grid.push(pixelToLngLat(px, py));
        }
      }
      watershedLayer.setDataGrid(grid);

      // Debug: draw fetch window and tile boundaries
      if (DEBUG) {
        updateDebugBoundaries(
          currentWindow,
          tc0,
          tr0,
          tc1,
          tr1,
          scaleX,
          scaleY,
        );
      }

      map.triggerRepaint();
    } catch (e) {
      console.error("Failed to load tiles:", e);
    }
    loading = false;
  };

  // Helper: convert a pixel-space rect [x0,y0,x1,y1] to a GeoJSON polygon
  const pixelRectToGeoJSON = (x0, y0, x1, y1) => {
    const tl = pixelToLngLat(x0, y0);
    const tr = pixelToLngLat(x1, y0);
    const br = pixelToLngLat(x1, y1);
    const bl = pixelToLngLat(x0, y1);
    return {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[tl, tr, br, bl, tl]],
      },
    };
  };

  const updateDebugBoundaries = (
    window,
    tc0,
    tr0,
    tc1,
    tr1,
    scaleX,
    scaleY,
  ) => {
    // Fetch window boundary
    const fetchWindowGeo = {
      type: "FeatureCollection",
      features: [
        pixelRectToGeoJSON(window[0], window[1], window[2], window[3]),
      ],
    };

    // Individual tile boundaries
    const tileFeatures = [];
    for (let tr = tr0; tr < tr1; tr++) {
      for (let tc = tc0; tc < tc1; tc++) {
        const tx0 = (tc * TILE) / scaleX;
        const ty0 = (tr * TILE) / scaleY;
        const tx1 = ((tc + 1) * TILE) / scaleX;
        const ty1 = ((tr + 1) * TILE) / scaleY;
        tileFeatures.push(pixelRectToGeoJSON(tx0, ty0, tx1, ty1));
      }
    }
    const tilesGeo = { type: "FeatureCollection", features: tileFeatures };

    if (map.getSource("debug-fetch-window")) {
      map.getSource("debug-fetch-window").setData(fetchWindowGeo);
      map.getSource("debug-tiles").setData(tilesGeo);
    }
  };

  // Add custom layers (called on initial load + after basemap switch)
  const addOverlayLayers = () => {
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

  // Wait for map load
  await new Promise((resolve) => {
    map.once("load", async () => {
      addOverlayLayers();

      await loadVisibleData();

      map.on("zoomend", loadVisibleData);
      map.on("moveend", loadVisibleData);

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
        () => {
          map.dragPan.disable();
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

      const updateCursor = (lng, lat) => {
        if (!currentDiscData || !currentFiniData || !currentWindow) return;

        const { x, y } = lngLatToPixel(lng, lat);
        if (x < 0 || x >= width || y < 0 || y >= height) return;

        const winW = currentWindow[2] - currentWindow[0];
        const winH = currentWindow[3] - currentWindow[1];
        const dataX = ((x - currentWindow[0]) / winW) * currentDataWidth;
        const dataY = ((y - currentWindow[1]) / winH) * currentDataHeight;

        if (
          dataX < 0 ||
          dataX >= currentDataWidth ||
          dataY < 0 ||
          dataY >= currentDataHeight
        )
          return;

        const snapped = snapToMaxAccOverview(
          dataX,
          dataY,
          appState.snapRadius,
          currentDiscData,
          currentFiniData,
          currentDataWidth,
          currentDataHeight,
        );

        const tx = Math.floor(snapped.x);
        const ty = Math.floor(snapped.y);
        const idx = ty * currentDataWidth + tx;
        const dv = currentDiscData[idx];
        const fv = currentFiniData[idx];

        watershedLayer.setCursorValues(dv, fv, tx, ty);
        map.triggerRepaint();
      };

      map.on("mousemove", (e) => {
        updateCursor(e.lngLat.lng, e.lngLat.lat);
      });

      resolve();
    });
  });

  return map;
};
