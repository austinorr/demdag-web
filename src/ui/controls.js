import { units } from "../data/datasets.js";
import { locateHUD } from "./hud.js";

export const setZoom = (gl, zoom) => {
  console.debug("zoom: ", zoom);
  let canvas = document.getElementById("canvas");
  canvas.style.width = `${gl.canvas.width * zoom}px`;
  canvas.style.height = `${gl.canvas.height * zoom}px`;
  let z = document.getElementById("zoom");
  z.innerHTML = zoom;
  locateHUD();
};

export const createAdjustZoom = (state, zooms, setZoomFn, updateSnapStateFn) => {
  return (inc) => {
    let newZix = state.zix + inc;

    if (newZix < 0) {
      newZix = 0;
    }
    if (newZix >= zooms.length) {
      newZix = zooms.length - 1;
    }
    state.zix = newZix;
    state.zoom = zooms[newZix];
    setZoomFn(state.zoom);
    updateSnapStateFn();
  };
};

export const createAreaButtons = (state, changeUnitsFn) => {
  let buttonContainer = document.getElementById("area-units");
  let inputHtml = buttonContainer.innerHTML;

  for (const u of units) {
    inputHtml += `
    <div>
      <input type="radio" id="units-${u.id}" name="units" value="${u.id}" onChange=changeUnits("${u.id}")>
      <label for="units-${u.id}" >${u.label}</label>
    </div>
    `;
  }

  buttonContainer.innerHTML = inputHtml;
  let u = state.selectedUnit;
  let defaultUnits = document.querySelector(`input[id='units-${u.id}']`);
  defaultUnits.checked = true;
  changeUnitsFn(u.id);
};

export const createSnapToggle = (state, cycleSnapStateFn, updateSnapStateFn) => {
  let button = document.getElementById("cycleSnap");
  button.classList.add(`mode-${state.snapState}`);
  updateSnapStateFn();

  button.addEventListener("click", () => {
    button.classList.remove(`mode-${state.snapState}`);
    cycleSnapStateFn();
    button.classList.add(`mode-${state.snapState}`);
    updateSnapStateFn();
  });
};

export const updateArea = (state) => {
  let u = state.selectedUnit;
  let area = state.npixels * state.sqmeters_per_pixel * u.from_sqm;
  let area_str = area.toLocaleString(undefined, { maximumFractionDigits: 1 });

  let area_value = document.getElementById("area_value");
  area_value.innerText = `${area_str} ${u.label}`;
};

export const maybeShowAreaSummary = (state) => {
  let area_summary = document.getElementById("area-summary");
  if (!state.from_sqm_conversion_factor) {
    state.showArea = false;
    area_summary.style.display = "none";
  } else {
    state.showArea = true;
    area_summary.style.display = "";
  }
};
