import discURL from "../assets/d8_discovery.tif";
import finiURL from "../assets/d8_finish.tif";
import bgURL from "../assets/d8_bg.jpg";

import discURL_LG from "../assets/helens_fdr_discovery.tif";
import finiURL_LG from "../assets/helens_fdr_finish.tif";
import bgURL_LG from "../assets/helens_bg.jpg";

export const datasets = {
  sm: {
    urls: [discURL, finiURL, bgURL],
    defaultZix: 3,
  },
  lg: {
    urls: [discURL_LG, finiURL_LG, bgURL_LG],
    defaultZix: 0,
  },
};

export const sqmeters_per_pixel = 100;

export const units = [
  { id: "acres", label: "Acres", from_sqm: 1 / 4046.86 },
  { id: "sqmi", label: "Sq Mi", from_sqm: 1 / 2589988.110336 },
  { id: "sqm", label: "Sq M", from_sqm: 1 },
  { id: "sqkm", label: "Sq Km", from_sqm: 1 / 1000 },
  { id: "pixels", label: "Pixels", from_sqm: 1 / 100 },
  { id: "none", label: "None", from_sqm: 0 },
];
