import { fromArrayBuffer } from "geotiff";
import discURL from "./assets/d8_discovery.tif";
import finiURL from "./assets/d8_finish.tif";
import bgURL from "./assets/d8_bg.jpg";

import discURL_LG from "./assets/helens_fdr_discovery.tif";
import finiURL_LG from "./assets/helens_fdr_finish.tif";
import bgURL_LG from "./assets/helens_bg.jpg";

const cycleSnapState = () => {
  snapStateIx = (snapStateIx + 1) % snapStateOpt.length;
  snapState = snapStateOpt[snapStateIx];
  snapRadius = getSnapRadius();
  return snapState;
};

const getSnapRadius = () => {
  switch (snapState) {
    case "large":
      return snapLarge;
    case "none":
      return 0;
    default:
      return zoom >= 8.0
        ? 0
        : zoom >= 4.0
        ? 0
        : zoom >= 2.0
        ? 1
        : zoom >= 1.0
        ? 2
        : zoom >= 0.5
        ? 4
        : zoom <= 0.25
        ? 8
        : 0;
  }
};

const locateHUD = () => {
  console.debug("locating hud");
  let c = document.getElementById("canvas").getBoundingClientRect();
  area_summary.style.top = c.top + 15 + "px";
  area_summary.style.left = c.left + 15 + "px";
  if (c.top < 0) {
    area_summary.style.top = "15px";
  }
  if (c.left < 0) {
    area_summary.style.left = "15px";
  }
};

const _setZoom = (zoom) => {
  console.debug("zoom: ", zoom);
  let canvas = document.getElementById("canvas");
  canvas.style.width = `${gl.canvas.width * zoom}px`;
  canvas.style.height = `${gl.canvas.height * zoom}px`;
  let z = document.getElementById("zoom");
  z.innerHTML = zoom;
  locateHUD();
};

const adjustZoom = (inc) => {
  let newZix = zix + inc;

  if (newZix < 0) {
    newZix = 0;
  }
  if (newZix >= zooms.length) {
    newZix = zooms.length - 1;
  }
  zix = newZix;
  zoom = zooms[zix];
  _setZoom(zoom);
  updateSnapState();
};

const loadImage = (url) => {
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

const loadTiff = async (url) => {
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
      const dataInt8 = new Uint8ClampedArray(geoTiffData.length * 4); // array of RGBA values

      // convert GeoTiff's RGB values to ImageData's RGBA values
      for (let i = 0; i < height; i++) {
        for (let j = 0; j < width; j++) {
          const srcIdx = i * width + j;
          const idx = 4 * i * width + 4 * j;
          const int32 = geoTiffData[srcIdx];
          dataInt8[idx] = int32 & 0xff;
          dataInt8[idx + 1] = (int32 >> 8) & 0xff;
          dataInt8[idx + 2] = (int32 >> 16) & 0xff;
          dataInt8[idx + 3] = (int32 >> 24) & 0xff;
        }
      }

      const data = {
        data: dataInt8,
        width,
        height,
        _raw_data: geoTiffData,
      };

      console.debug("data: ", data, url);

      image = data;
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

const loadImages = async (urls, callback) => {
  images = [];
  console.debug("urls:", urls);
  Promise.all(urls.map(imLoad)).then((imgs) => {
    images = imgs;
    callback(images);
  });
};

const getSquaredDistance = (x1, y1, x2, y2) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return dx * dx + dy * dy;
};

const snapToMaxAcc = () => {
  let mpos = mousePos;
  let snap = snapRadius;
  let snap2 = snap * snap;

  if ((snap > 0) & (images.length >= 3)) {
    let pctx = mousePos.x / gl.canvas.width;
    let pcty = mousePos.y / gl.canvas.height;
    let im = images[0];
    let col = Math.floor(im.width * pctx);
    let row = Math.floor(im.height * pcty);

    let maxacc = 0;

    for (let i = -snap; i <= snap; i++) {
      let c = Math.min(im.width, Math.max(0, col + i));
      for (let j = -snap; j <= snap; j++) {
        let r = Math.min(im.height, Math.max(0, row + j));

        if (getSquaredDistance(col, row, c, r) <= snap2) {
          const srcIdx = r * im.width + c;
          const acc =
            1 + images[1]._raw_data[srcIdx] - images[0]._raw_data[srcIdx];
          if (acc > maxacc) {
            maxacc = acc;
            mpos = { x: c, y: r };
          }
        }
      }
    }
  }
  return mpos;
};

const _render = () => {
  if (!(images.length > 0) || !(images[0]?.width > 0)) {
    return;
  }
  // Create a buffer to put three 2d clip space points in
  let positionBuffer = gl.createBuffer();

  // Bind it to ARRAY_BUFFER (think of it as ARRAY_BUFFER = positionBuffer)
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  // Set a rectangle the same size as the image.
  setRectangle(gl, 0, 0, images[0].width, images[0].height);

  // look up where the vertex data needs to go.
  let positionLocation = gl.getAttribLocation(program, "a_position");
  let texcoordLocation = gl.getAttribLocation(program, "a_texCoord");

  // provide texture coordinates for the rectangle.
  let texcoordBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0,
    ]),
    gl.STATIC_DRAW
  );

  // lookup uniforms
  let resolutionLocation = gl.getUniformLocation(program, "u_resolution");
  let mouseLocation = gl.getUniformLocation(program, "u_mouse");
  let umpos = gl.getUniformLocation(program, "u_mpos");
  let uzoom = gl.getUniformLocation(program, "u_zoom");
  let usnap = gl.getUniformLocation(program, "u_snap");

  // lookup the sampler locations.
  let u_image0Location = gl.getUniformLocation(program, "u_image0");
  let u_image1Location = gl.getUniformLocation(program, "u_image1");
  let u_image2Location = gl.getUniformLocation(program, "u_image2");

  // Tell it to use our program (pair of shaders)
  gl.useProgram(program);

  // Turn on the position attribute
  gl.enableVertexAttribArray(positionLocation);

  // Bind the position buffer.
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);

  // Tell the position attribute how to get data out of positionBuffer (ARRAY_BUFFER)
  gl.vertexAttribPointer(
    positionLocation,
    2, // 2 components per iteration
    gl.FLOAT, // the data is 32bit floats
    false, // don't normalize the data
    0, // 0 = move forward size * sizeof(type) each iteration to get the next position
    0 // start at the beginning of the buffer
  );

  // Turn on the texcoord attribute
  gl.enableVertexAttribArray(texcoordLocation);

  // bind the texcoord buffer.
  gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer);

  // Tell the texcoord attribute how to get data out of texcoordBuffer (ARRAY_BUFFER)
  gl.vertexAttribPointer(
    texcoordLocation,
    2, // 2 components per iteration
    gl.FLOAT, // the data is 32bit floats
    false, // don't normalize the data
    0, // 0 = move forward size * sizeof(type) each iteration to get the next position
    0 // start at the beginning of the buffer
  );

  if (!pinMax) {
    mpos = snapToMaxAcc();
  }

  // set the resolution
  gl.uniform2f(resolutionLocation, gl.canvas.width, gl.canvas.height);
  gl.uniform2f(mouseLocation, mousePos.x, mousePos.y);
  gl.uniform2f(umpos, mpos.x, mpos.y);
  gl.uniform1f(uzoom, zoom);
  gl.uniform1f(usnap, snapRadius);

  // set which texture units to render with.
  gl.uniform1i(u_image0Location, 0); // texture unit 0
  gl.uniform1i(u_image1Location, 1); // texture unit 1
  gl.uniform1i(u_image2Location, 2); // texture unit 2

  // Set each texture unit to use a particular texture.
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, textures[0]);

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, textures[1]);

  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, textures[2]);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
  if (showArea) {
    readPixels();
  }
  gl.finish();
};

const render = () => {
  try {
    _render();
  } catch (e) {
    console.error(e);
  }
};

const readPixels = () => {
  // the pixels with blue channel set to 255 are 'in' the watershed.
  // this will add them up and render the result to the page.
  let w_size = 0;
  const width = gl.canvas.width;
  const height = gl.canvas.height;
  const pixels = new Uint8Array(width * height * 4); // 4 for RGBA
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  for (let i = 0; i < height; i++) {
    for (let j = 0; j < width; j++) {
      const idx = 4 * i * width + 4 * j;

      if (pixels[idx + 2] >= 255) {
        w_size += 1;
      }
    }
  }
  npixels = w_size;
};

const initGL = (images) => {
  // Get A WebGL context
  /** @type {HTMLCanvasElement} */

  if (images.length === 0) {
    console.error("No Images!");
    return;
  }
  let canvas = document.getElementById("canvas");
  canvas.style["image-rendering"] = "pixelated";
  gl = canvas.getContext("webgl", { antialias: false });
  if (!gl) {
    console.error("Cannot attach as webgl canvas to the document!");
    return;
  }

  const shaderScriptIds = ["vertex-shader-2d", "fragment-shader-2d"];

  const shaders = [];
  for (let ii = 0; ii < shaderScriptIds.length; ++ii) {
    let shaderSource = "";
    let shaderType;
    let scriptId = shaderScriptIds[ii];
    const shaderScript = document.getElementById(scriptId);
    if (!shaderScript) {
      throw "*** Error: unknown script element" + scriptId;
    }
    let prefix = ""; //"#version 300 es";
    shaderSource = `${prefix}\n${shaderScript.text}`;

    if (shaderScript.type === "x-shader/x-vertex") {
      shaderType = gl.VERTEX_SHADER;
    } else if (shaderScript.type === "x-shader/x-fragment") {
      shaderType = gl.FRAGMENT_SHADER;
    } else if (
      shaderType !== gl.VERTEX_SHADER &&
      shaderType !== gl.FRAGMENT_SHADER
    ) {
      throw "*** Error: unknown shader type";
    }

    const shader = gl.createShader(shaderType);

    // Load the shader source
    gl.shaderSource(shader, shaderSource);

    // Compile the shader
    gl.compileShader(shader);

    // Check the compile status
    const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
    if (!compiled) {
      // Something went wrong during compilation; get the error
      const lastError = gl.getShaderInfoLog(shader);
      console.error(
        "*** Error compiling shader '" +
          shader +
          "':" +
          lastError +
          `\n` +
          shaderSource
            .split("\n")
            .map((l, i) => `${i + 1}: ${l}`)
            .join("\n")
      );
      gl.deleteShader(shader);
      return null;
    }

    shaders.push(shader);
  }
  program = gl.createProgram();
  shaders.forEach((shader) => {
    gl.attachShader(program, shader);
  });
  gl.linkProgram(program);

  // Check the link status
  const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
  if (!linked) {
    // something went wrong with the link
    const lastError = gl.getProgramInfoLog(program);
    console.error("Error in program linking:" + lastError);

    gl.deleteProgram(program);
    return null;
  }

  // setup GLSL program
  gl.useProgram(program);

  // const ext = gl.getExtension("WEBGL_depth_texture");

  // create textures
  textures = [];
  for (let ii = 0; ii < images.length; ++ii) {
    // console.log("texture: ", ii, images[ii]);
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);

    // Set the parameters so we can render any size image.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // Upload the image into the texture.

    if (images[ii]?.data) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0, // mip level
        gl.RGBA, // internal format
        images[ii].width, // width
        images[ii].height, // height
        0, // border
        gl.RGBA, // source format
        gl.UNSIGNED_BYTE, // source type
        images[ii].data
        // 0
      );
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        images[ii]
      );
    }

    // add the texture to the array of textures.
    textures.push(texture);
  }

  let w = images[0].width;
  let h = images[0].height;

  if (w >= 4096 || h > 4096) {
    alert("texture too large!");
    adjustZoom(-1);
    return;
  }

  gl.canvas.width = w;
  gl.canvas.height = h;
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

  render();
  _setZoom(zoom);
};

const setRectangle = (gl, x, y, width, height) => {
  let x1 = x;
  let x2 = x + width;
  let y1 = y;
  let y2 = y + height;
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([x1, y1, x2, y1, x1, y2, x1, y2, x2, y1, x2, y2]),
    gl.STATIC_DRAW
  );
};

const getRelativeMousePosition = (event, target) => {
  target = target || event.target;
  const { left, top } = target.getBoundingClientRect();

  return {
    x: event.clientX - left,
    y: event.clientY - top,
  };
};

// assumes target or event.target is canvas
const getNoPaddingNoBorderCanvasRelativeMousePosition = (event, target) => {
  target = target || event.target;
  let { x, y } = getRelativeMousePosition(event, target);

  x = (x * target.width) / target.clientWidth;
  y = (y * target.height) / target.clientHeight;

  return { x, y };
};

const mobileAndTabletCheck = () => {
  let check = false;
  ((a) => {
    if (
      /(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|mobile.+firefox|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows ce|xda|xiino|android|ipad|playbook|silk/i.test(
        a
      ) ||
      /1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(
        a.substr(0, 4)
      )
    )
      check = true;
  })(navigator.userAgent || navigator.vendor || window.opera);
  return check;
};

const isTouchDevice = () => {
  try {
    //We try to create TouchEvent. It would fail for desktops and throw error
    document.createEvent("TouchEvent");
    return true;
  } catch (e) {
    return false;
  }
};

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
  pinMax = !pinMax;
});

const onMove = (e) => {
  const { x, y } = getNoPaddingNoBorderCanvasRelativeMousePosition(e);
  const mobileOffset = (isMobile * 50) / zoom;
  mousePos.x = x;
  mousePos.y = y - mobileOffset;
  console.debug("mousePos", mousePos);
  render();

  //PageX and PageY return the position of client's cursor from top left of screen
  if (showArea) {
    updateArea();
  }
};

document.querySelector("#canvas").addEventListener("pointermove", onMove);
window.addEventListener("scroll", locateHUD);
window.addEventListener("resize", locateHUD);

const mainSM = async () => {
  zix = 3;
  zoom = zooms[zix];
  await loadImages([discURL, finiURL, bgURL], initGL);
};

const mainLG = async () => {
  zix = 0;
  zoom = zooms[zix];
  await loadImages([discURL_LG, finiURL_LG, bgURL_LG], initGL);
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

const changeUnits = (id) => {
  selectedUnit = units.find((u) => u.id === id);
  from_sqm_conversion_factor = selectedUnit.from_sqm;
  maybeShowAreaSummary();
  render();
  updateArea();
};

const maybeShowAreaSummary = () => {
  if (!from_sqm_conversion_factor) {
    showArea = false;
    area_summary.style.display = "none";
  } else {
    showArea = true;
    area_summary.style.display = "";
  }
};

document
  .querySelector("#canvas")
  .addEventListener("mouseenter", maybeShowAreaSummary);

document.querySelector("#canvas").addEventListener("mouseexit", () => {
  area_summary.style.display = "none";
});

const updateArea = () => {
  let u = selectedUnit;
  let area = npixels * sqmeters_per_pixel * u.from_sqm;
  let area_str = area.toLocaleString(undefined, { maximumFractionDigits: 1 });

  let area_value = document.getElementById("area_value");
  area_value.innerText = `${area_str} ${u.label}`;
};

const createAreaButtons = () => {
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
  let u = selectedUnit;
  let defaultUnits = document.querySelector(`input[id='units-${u.id}']`);
  defaultUnits.checked = true;
  changeUnits(u.id);
};

const updateSnapState = () => {
  snapRadius = getSnapRadius();
  let buttonMode = document.getElementById("snapMode");
  buttonMode.innerHTML = `mode: ${snapState}</br>radius: ${snapRadius}`;
};

const createSnapToggle = () => {
  let button = document.getElementById("cycleSnap");
  button.classList.add(`mode-${snapState}`);
  updateSnapState();

  button.addEventListener("click", () => {
    button.classList.remove(`mode-${snapState}`);
    cycleSnapState();
    button.classList.add(`mode-${snapState}`);
    updateSnapState();
  });
};

window.main = main;
window.adjustZoom = adjustZoom;
window.changeUnits = changeUnits;

var gl, program;
var images = [];
var textures = [];
var zoom = 1;
var zooms = [0.25, 0.5, 1, 2, 4, 8, 16];
var zix = 2;

var snapStateOpt = ["zoom", "large", "none"];
var snapLarge = 40;
var snapStateIx = 0;
var snapState = snapStateOpt[snapStateIx];
var snapRadius = getSnapRadius();

var npixels = 0; // number of pixels in the delineation
var showArea = false;
var pinMax = false;
const sqmeters_per_pixel = 100; //
var from_sqm_conversion_factor = 1; //

var tiffCache = {};

var area_summary = document.getElementById("area-summary");
var mousePos = { x: 1e6, y: 1e6 };
var mpos = mousePos;
const isMobile = isTouchDevice() || mobileAndTabletCheck();
var touchCount = 0;
const units = [
  { id: "acres", label: "Acres", from_sqm: 1 / 4046.86 },
  { id: "sqmi", label: "Sq Mi", from_sqm: 1 / 2589988.110336 },
  { id: "sqm", label: "Sq M", from_sqm: 1 },
  { id: "sqkm", label: "Sq Km", from_sqm: 1 / 1000 },
  { id: "pixels", label: "Pixels", from_sqm: 1 / 100 },
  { id: "none", label: "None", from_sqm: 0 },
];
var selectedUnit = units.at(-1);

createAreaButtons();
createSnapToggle();
main();
