import { datasets, units, sqmeters_per_pixel } from "./data/datasets.js";
import { loadImages } from "./data/loader.js";
import { createContext, createProgram } from "./gl/context.js";
import { createTextures } from "./gl/textures.js";
import { render } from "./gl/renderer.js";
import { locateHUD } from "./ui/hud.js";
import {
  setZoom,
  createAdjustZoom,
  createAreaButtons,
  createSnapToggle,
  updateArea,
  maybeShowAreaSummary,
} from "./ui/controls.js";
import {
  getNoPaddingNoBorderCanvasRelativeMousePosition,
  mobileAndTabletCheck,
  isTouchDevice,
  snapToMaxAcc,
} from "./ui/input.js";

// --- State ---

const zooms = [0.25, 0.5, 1, 2, 4, 8, 16];
const snapStateOpt = ["zoom", "large", "none"];
const snapLarge = 40;

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
  npixels: 0,
  showArea: false,
  pinMax: false,
  sqmeters_per_pixel,
  from_sqm_conversion_factor: 1,
  mousePos: { x: 1e6, y: 1e6 },
  mpos: { x: 1e6, y: 1e6 },
  selectedUnit: units.at(-1),
};

const isMobile = isTouchDevice() || mobileAndTabletCheck();
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
        ? 0
        : state.zoom >= 4.0
        ? 0
        : state.zoom >= 2.0
        ? 1
        : state.zoom >= 1.0
        ? 2
        : state.zoom >= 0.5
        ? 4
        : state.zoom <= 0.25
        ? 8
        : 0;
  }
};

state.snapRadius = getSnapRadius();

const cycleSnapState = () => {
  state.snapStateIx = (state.snapStateIx + 1) % snapStateOpt.length;
  state.snapState = snapStateOpt[state.snapStateIx];
  state.snapRadius = getSnapRadius();
  return state.snapState;
};

const updateSnapState = () => {
  state.snapRadius = getSnapRadius();
  let buttonMode = document.getElementById("snapMode");
  buttonMode.innerHTML = `mode: ${state.snapState}</br>radius: ${state.snapRadius}`;
};

// --- Render wrapper ---

const doRender = () => {
  try {
    if (!state.pinMax) {
      state.mpos = snapToMaxAcc(state, state.gl, state.images);
    }
    render(state.gl, state.program, state.textures, state.images, state);
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

  state.program = createProgram(state.gl);
  if (!state.program) return;

  state.gl.useProgram(state.program);

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

  doRender();
  setZoom(state.gl, state.zoom);
};

// --- Zoom ---

const adjustZoom = createAdjustZoom(
  state,
  zooms,
  (z) => setZoom(state.gl, z),
  updateSnapState
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
  { passive: false }
);

document.querySelector("#canvas").addEventListener("touchend", (event) => {
  touchCount = 0;
});

document.querySelector("#canvas").addEventListener("click", () => {
  state.pinMax = !state.pinMax;
});

const onMove = (e) => {
  const { x, y } = getNoPaddingNoBorderCanvasRelativeMousePosition(e);
  const mobileOffset = (isMobile * 50) / state.zoom;
  state.mousePos.x = x;
  state.mousePos.y = y - mobileOffset;
  console.debug("mousePos", state.mousePos);
  doRender();

  if (state.showArea) {
    updateArea(state);
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

// --- Main ---

const mainSM = async () => {
  state.zix = datasets.sm.defaultZix;
  state.zoom = zooms[state.zix];
  const images = await loadImages(datasets.sm.urls);
  initGL(images);
};

const mainLG = async () => {
  state.zix = datasets.lg.defaultZix;
  state.zoom = zooms[state.zix];
  const images = await loadImages(datasets.lg.urls);
  initGL(images);
};

const main = async (example) => {
  if (!example) {
    const urlParams = new URLSearchParams(window.location.search);
    example = urlParams.get("example");
  }

  if (example == "lg") {
    window.history.pushState({}, document.title, "./?example=lg");
    mainLG();
  } else {
    window.history.pushState({}, document.title, "./");
    mainSM();
  }
  locateHUD();
  updateSnapState();
};

// --- Expose to HTML onclick handlers ---

window.main = main;
window.adjustZoom = (inc) => adjustZoom(inc);
window.changeUnits = changeUnits;

// --- Init ---

createAreaButtons(state, changeUnits);
createSnapToggle(state, cycleSnapState, updateSnapState);
main();
