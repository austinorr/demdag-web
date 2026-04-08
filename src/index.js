import { datasets, units, sqmeters_per_pixel } from "./data/datasets.js";
import { loadImages } from "./data/loader.js";
import { createContext, createProgram } from "./gl/context.js";
import { createTextures } from "./gl/textures.js";
import { render, setupBuffers } from "./gl/renderer.js";
import { locateHUD } from "./ui/hud.js";
import {
  setZoom,
  createAdjustZoom,
  createAreaButtons,
  createSnapToggle,
  updateArea,
  maybeShowAreaSummary,
} from "./ui/controls.js";
import { getNoPaddingNoBorderCanvasRelativeMousePosition } from "./ui/input.js";
import { snapToMaxAcc } from "./snap.js";

// --- State ---

const zooms = [0.25, 0.5, 1, 2, 4, 8, 16];
const snapStateOpt = ["zoom", "large", "none"];
const snapLarge = 40;
const slippySnapRadii = [0, 4, 16, 32];

const state = {
  gl: null,
  program: null,
  images: [],
  textures: [],
  zoom: 1,
  zix: 2,
  snapStateIx: 0,
  snapState: snapStateOpt[0],
  snapRadius: 0,
  slippySnapIx: 1, // default to 4
  slippySnapRadius: slippySnapRadii[1],
  npixels: 0,
  showArea: false,
  pinMax: false,
  sqmeters_per_pixel,
  from_sqm_conversion_factor: 1,
  mousePos: { x: 1e6, y: 1e6 },
  mpos: { x: 1e6, y: 1e6 },
  selectedUnit: units.at(-1),
};

let isTouch = false;
var touchCount = 0;

// --- Snap logic ---

const getSnapRadius = () => {
  switch (state.snapState) {
    case "large":
      return snapLarge;
    case "none":
      return 0;
    default:
      return state.zoom >= 8.0
        ? 1
        : state.zoom >= 4.0
          ? 1
          : state.zoom >= 2.0
            ? 2
            : state.zoom >= 1.0
              ? 4
              : state.zoom >= 0.5
                ? 8
                : state.zoom <= 0.25
                  ? 16
                  : 0;
  }
};

state.snapRadius = getSnapRadius();

const cycleSnapState = () => {
  if (slippyActive) {
    state.slippySnapIx = (state.slippySnapIx + 1) % slippySnapRadii.length;
    state.slippySnapRadius = slippySnapRadii[state.slippySnapIx];
    state.snapRadius = state.slippySnapRadius;
  } else {
    state.snapStateIx = (state.snapStateIx + 1) % snapStateOpt.length;
    state.snapState = snapStateOpt[state.snapStateIx];
    state.snapRadius = getSnapRadius();
  }
  return state.snapState;
};

const updateSnapState = () => {
  if (slippyActive) {
    state.snapRadius = state.slippySnapRadius;
    let buttonMode = document.getElementById("snapMode");
    buttonMode.innerHTML = `radius: ${state.snapRadius}`;
  } else {
    state.snapRadius = getSnapRadius();
    let buttonMode = document.getElementById("snapMode");
    buttonMode.innerHTML = `mode: ${state.snapState}</br>radius: ${state.snapRadius}`;
  }
};

// --- Performance counter ---

const perfEnabled = new URLSearchParams(window.location.search).has("perf");

if (perfEnabled) {
  const el = document.getElementById("fps-container");
  if (el) el.style.display = "";
}

let frameCount = 0;
let lastFpsTime = performance.now();
let cpuTimeSum = 0;
let gpuTimeSum = 0;
let latencySum = 0;
let latencyCount = 0;
let firstInputInBurst = 0;
let gpuTimerExt = null;
let pendingQuery = null;

let isWebGL2 = false;

const initGpuTimer = (gl) => {
  if (!perfEnabled) return;

  isWebGL2 =
    typeof WebGL2RenderingContext !== "undefined" &&
    gl instanceof WebGL2RenderingContext;

  if (isWebGL2) {
    gpuTimerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  } else {
    gpuTimerExt = gl.getExtension("EXT_disjoint_timer_query");
  }

  if (!gpuTimerExt) {
    console.warn("GPU timer extension not available — showing CPU time only");
  }
};

const collectGpuTime = (gl) => {
  if (!pendingQuery || !gpuTimerExt) return;

  const available = isWebGL2
    ? gl.getQueryParameter(pendingQuery, gl.QUERY_RESULT_AVAILABLE)
    : gpuTimerExt.getQueryObjectEXT(
        pendingQuery,
        gpuTimerExt.QUERY_RESULT_AVAILABLE_EXT,
      );
  const disjoint = gl.getParameter(gpuTimerExt.GPU_DISJOINT_EXT);

  if (available && !disjoint) {
    const ns = isWebGL2
      ? gl.getQueryParameter(pendingQuery, gl.QUERY_RESULT)
      : gpuTimerExt.getQueryObjectEXT(
          pendingQuery,
          gpuTimerExt.QUERY_RESULT_EXT,
        );
    gpuTimeSum += ns / 1e6; // ns → ms
  }
  if (available || disjoint) {
    if (isWebGL2) {
      gl.deleteQuery(pendingQuery);
    } else {
      gpuTimerExt.deleteQueryEXT(pendingQuery);
    }
    pendingQuery = null;
  }
};

const updatePerf = (cpuMs) => {
  frameCount++;
  cpuTimeSum += cpuMs;
  const now = performance.now();
  const elapsed = now - lastFpsTime;
  if (elapsed >= 1000) {
    const fps = Math.round((frameCount * 1000) / elapsed);
    const avgCpu = (cpuTimeSum / frameCount).toFixed(1);
    let text = `${fps} fps / cpu ${avgCpu}ms`;
    if (latencyCount > 0) {
      const avgLat = (latencySum / latencyCount).toFixed(0);
      text += ` / lag ${avgLat}ms`;
    }
    if (gpuTimerExt && gpuTimeSum > 0) {
      const avgGpu = (gpuTimeSum / frameCount).toFixed(1);
      text += ` / gpu ${avgGpu}ms`;
    }
    frameCount = 0;
    cpuTimeSum = 0;
    gpuTimeSum = 0;
    latencySum = 0;
    latencyCount = 0;
    lastFpsTime = now;
    const fpsEl = document.getElementById("fps");
    if (fpsEl) fpsEl.textContent = text;
  }
};

// --- Render wrapper ---

const doSnap = () => {
  const im = state.images[0];
  if (state.snapRadius <= 0 || state.images.length < 3) return state.mousePos;
  const col = Math.floor((state.mousePos.x / state.gl.canvas.width) * im.width);
  const row = Math.floor(
    (state.mousePos.y / state.gl.canvas.height) * im.height,
  );
  return snapToMaxAcc(
    col,
    row,
    state.snapRadius,
    state.images[0]._raw_data,
    state.images[1]._raw_data,
    im.width,
    im.height,
  );
};

const doRender = () => {
  try {
    const gl = state.gl;

    if (perfEnabled) {
      // Collect previous frame's GPU time (non-blocking)
      if (gl) collectGpuTime(gl);

      const t0 = performance.now();
      if (!state.pinMax) {
        state.mpos = doSnap();
      }

      // Start GPU timer query before draw
      let queryStarted = false;
      if (gl && gpuTimerExt && !pendingQuery) {
        if (isWebGL2) {
          pendingQuery = gl.createQuery();
          gl.beginQuery(gpuTimerExt.TIME_ELAPSED_EXT, pendingQuery);
        } else {
          pendingQuery = gpuTimerExt.createQueryEXT();
          gpuTimerExt.beginQueryEXT(gpuTimerExt.TIME_ELAPSED_EXT, pendingQuery);
        }
        queryStarted = true;
      }

      render(gl, state.program, state.textures, state.images, state);

      // End GPU timer query after draw
      if (queryStarted) {
        if (isWebGL2) {
          gl.endQuery(gpuTimerExt.TIME_ELAPSED_EXT);
        } else {
          gpuTimerExt.endQueryEXT(gpuTimerExt.TIME_ELAPSED_EXT);
        }
      }

      updatePerf(performance.now() - t0);
    } else {
      if (!state.pinMax) {
        state.mpos = doSnap();
      }
      render(gl, state.program, state.textures, state.images, state);
    }
  } catch (e) {
    console.error(e);
  }
};

// --- GL init ---

const initGL = (images) => {
  if (images.length === 0) {
    console.error("No Images!");
    return;
  }

  let canvas = document.getElementById("canvas");
  state.gl = createContext(canvas);
  if (!state.gl) return;

  initGpuTimer(state.gl);

  state.program = createProgram(state.gl);
  if (!state.program) return;

  state.images = images;
  state.textures = createTextures(state.gl, images);

  let w = images[0].width;
  let h = images[0].height;

  if (w >= 4096 || h > 4096) {
    alert("texture too large!");
    adjustZoom(-1);
    return;
  }

  state.gl.canvas.width = w;
  state.gl.canvas.height = h;
  state.gl.viewport(0, 0, state.gl.canvas.width, state.gl.canvas.height);

  setupBuffers(state.gl, state.program, w, h);

  doRender();
  setZoom(state.gl, state.zoom);
};

// --- Zoom ---

const adjustZoom = createAdjustZoom(
  state,
  zooms,
  (z) => setZoom(state.gl, z),
  updateSnapState,
);

// --- Units ---

const changeUnits = (id) => {
  state.selectedUnit = units.find((u) => u.id === id);
  state.from_sqm_conversion_factor = state.selectedUnit.from_sqm;
  maybeShowAreaSummary(state);
  doRender();
  updateArea(state);
};

// --- Input ---

document.querySelector("#canvas").addEventListener(
  "touchstart",
  (event) => {
    touchCount++;
    if (event.touches.length === 1 && touchCount === 1) {
      event.preventDefault();
    }
  },
  { passive: false },
);

document.querySelector("#canvas").addEventListener("touchend", (event) => {
  touchCount = 0;
});

document.querySelector("#canvas").addEventListener("click", () => {
  state.pinMax = !state.pinMax;
});

let rafPending = false;

const onMove = (e) => {
  if (e.pointerType) isTouch = e.pointerType === "touch";
  const { x, y } = getNoPaddingNoBorderCanvasRelativeMousePosition(e);
  const mobileOffset = (isTouch * 50) / state.zoom;
  state.mousePos.x = x;
  state.mousePos.y = y - mobileOffset;

  if (perfEnabled && !firstInputInBurst) {
    firstInputInBurst = performance.now();
  }

  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;

      if (perfEnabled && firstInputInBurst) {
        latencySum += performance.now() - firstInputInBurst;
        latencyCount++;
        firstInputInBurst = 0;
      }

      doRender();
      if (state.showArea) {
        updateArea(state);
      }
    });
  }
};

document.querySelector("#canvas").addEventListener("pointermove", onMove);
window.addEventListener("scroll", locateHUD);
window.addEventListener("resize", locateHUD);

document
  .querySelector("#canvas")
  .addEventListener("mouseenter", () => maybeShowAreaSummary(state));

document.querySelector("#canvas").addEventListener("mouseexit", () => {
  document.getElementById("area-summary").style.display = "none";
});

// --- View switching ---

let slippyMap = null;
let slippyActive = false;

const showCanvasView = () => {
  slippyActive = false;
  document.getElementById("canvas-container").style.display = "flex";
  document.getElementById("map-container").style.display = "none";
  document.getElementById("area-units").style.display = "flex";
  document.getElementById("area-summary").style.display = "";
};

const showMapView = () => {
  slippyActive = true;
  document.getElementById("canvas-container").style.display = "none";
  document.getElementById("map-container").style.display = "block";
  document.getElementById("area-units").style.display = "none";
  document.getElementById("area-summary").style.display = "none";
};

// --- Main ---

const mainSM = async () => {
  showCanvasView();
  state.zix = datasets.sm.defaultZix;
  state.zoom = zooms[state.zix];
  const images = await loadImages(datasets.sm.urls);
  initGL(images);
};

const mainLG = async () => {
  showCanvasView();
  state.zix = datasets.lg.defaultZix;
  state.zoom = zooms[state.zix];
  const images = await loadImages(datasets.lg.urls);
  initGL(images);
};

const mainSlippyConn = async () => {
  showMapView();
  const startZ = slippyMap ? slippyMap.getZoom() : 4;
  state.slippySnapRadius = startZ < 8 ? 16 : state.slippySnapRadius;
  state.slippySnapIx = slippySnapRadii.indexOf(state.slippySnapRadius);
  state.snapRadius = state.slippySnapRadius;
  const cogBase = import.meta.env.PROD
    ? "https://pub-68a42a1442d1489680f4073a62efaef0.r2.dev/cog/"
    : `${import.meta.env.BASE_URL}cog/`;
  const discUrl = `${cogBase}fdr_discovery.tif`;
  const finiUrl = `${cogBase}fdr_finish.tif`;

  try {
    if (!slippyMap) {
      const { initSlippyMap } = await import("./map/slippy-map.js");
      slippyMap = await initSlippyMap("map-container", discUrl, finiUrl, state);
    } else {
      slippyMap.resize();
    }
    console.debug("slippyMap initialized", slippyMap);
  } catch (e) {
    console.error("initSlippyMap failed:", e);
  }
};

const main = async (example) => {
  if (!example) {
    const urlParams = new URLSearchParams(window.location.search);
    example = urlParams.get("example");
  }

  const params = new URLSearchParams(window.location.search);
  if (example == "lg") {
    params.set("example", "lg");
  } else if (example == "slippy-conn") {
    params.set("example", "slippy-conn");
  } else {
    params.delete("example");
  }
  const qs = params.toString();
  window.history.pushState({}, document.title, "./" + (qs ? "?" + qs : ""));

  if (example == "slippy-conn") {
    mainSlippyConn();
  } else if (example == "lg") {
    mainLG();
  } else {
    mainSM();
  }
  locateHUD();
  updateSnapState();
};

// --- Expose to HTML onclick handlers ---

window.main = main;
window.adjustZoom = (inc) => {
  if (slippyActive && slippyMap) {
    slippyMap.zoomTo(Math.round(slippyMap.getZoom()) + inc);
  } else {
    adjustZoom(inc);
  }
};
window.changeUnits = changeUnits;

// --- Init ---

createAreaButtons(state, changeUnits);
createSnapToggle(state, cycleSnapState, updateSnapState);
main();
