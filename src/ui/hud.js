export const locateHUD = () => {
  console.debug("locating hud");
  let c = document.getElementById("canvas").getBoundingClientRect();
  let area_summary = document.getElementById("area-summary");
  area_summary.style.top = c.top + 15 + "px";
  area_summary.style.left = c.left + 15 + "px";
  if (c.top < 0) {
    area_summary.style.top = "15px";
  }
  if (c.left < 0) {
    area_summary.style.left = "15px";
  }
};
