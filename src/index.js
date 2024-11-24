import { fromArrayBuffer } from "geotiff";
import discURL from "./assets/d8_discovery.tif";
import finiURL from "./assets/d8_finish.tif";
import bgURL from "./assets/d8_bg.jpg";

import discURL_LG from "./assets/helens_fdr_discovery.tif";
import finiURL_LG from "./assets/helens_fdr_finish.tif";
import bgURL_LG from "./assets/helens_bg.jpg";

var images = [];
var zoom = 1;
var gl, program;
var textures = [];

var zooms = [0.25, 0.5, 1, 2, 4, 8, 16];
var zix = 2;

function resetZoom() {
  zoom = 1;
  zix = 2;
  console.debug("zoom: ", zoom);
  render();
}

function adjustZoom(inc) {
  let newZix = zix + inc;

  if (newZix < 0) {
    newZix = 0;
  }
  if (newZix >= zooms.length) {
    newZix = zooms.length - 1;
  }
  zix = newZix;
  zoom = zooms[zix];
  console.debug("zoom: ", zoom);
  render();
}

function resizeCanvasToDisplaySize(canvas, multiplier) {
  multiplier = multiplier || 1;
  const width = (canvas.clientWidth * multiplier) | 0;
  const height = (canvas.clientHeight * multiplier) | 0;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    return true;
  }
  return false;
}

function loadImage(url, callback) {
  const img = new Image();
  img.crossOrigin = "Anonymous"; // to avoid CORS if used with Canvas
  img.src = url;
  img.onload = callback;
  return img;
}

let tiffCache = {};
async function loadTiff(url) {
  if (!tiffCache?.[url]) {
    let image;
    console.debug("fetching:", url);
    const response = await fetch(url);

    const arrayBuffer = await response.arrayBuffer();
    // console.log(arrayBuffer);
    const tiff = await fromArrayBuffer(arrayBuffer);
    const imageTiff = await tiff.getImage();
    const width = imageTiff.getWidth();
    const height = imageTiff.getHeight();

    if (url.includes("_discovery") || url.includes("_finish")) {
      const geoTiffDataRGB = await imageTiff.readRasters();
      // console.log("geoTiffDataRGB: ", geoTiffDataRGB[0]);
      const dataInt8 = new Uint8ClampedArray(geoTiffDataRGB[0].length * 4); // array of RGBA values

      // convert GeoTiff's RGB values to ImageData's RGBA values
      for (let i = 0; i < height; i++) {
        for (let j = 0; j < width; j++) {
          const srcIdx = i * width + j;
          const idx = 4 * i * width + 4 * j;
          const int32 = geoTiffDataRGB[0][srcIdx];
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
}

async function loadImages(urls, callback) {
  var imagesToLoad = urls.length;
  images = [];

  // Called each time an image finished
  // loading.
  var onImageLoad = function () {
    --imagesToLoad;
    // If all the images are loaded call the callback.
    console.debug("loaded img.");
    if (imagesToLoad === 0) {
      console.debug("images:", images);
      callback(images);
    }
  };
  console.debug("urls:", urls);

  for (var ii = 0; ii < urls.length; ++ii) {
    const url = urls[ii];
    console.debug("loading: ", url);
    let image;
    if (url.endsWith(".tif") || url.endsWith(".tiff")) {
      image = await loadTiff(url);
      images.push(image);
      onImageLoad();
    } else {
      image = await loadImage(url, onImageLoad);
      images.push(image);
    }
  }
}

function render() {
  // Create a buffer to put three 2d clip space points in
  var positionBuffer = gl.createBuffer();

  // Bind it to ARRAY_BUFFER (think of it as ARRAY_BUFFER = positionBuffer)
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  // Set a rectangle the same size as the image.
  setRectangle(gl, 0, 0, images[0].width, images[0].height);

  let w = images[0].width * zoom;
  let h = images[0].height * zoom;

  if (w >= 4096 || h > 4096) {
    alert("texture too large!");
    adjustZoom(-1);
    return;
  }

  gl.canvas.width = w;
  gl.canvas.height = h;

  // look up where the vertex data needs to go.
  var positionLocation = gl.getAttribLocation(program, "a_position");
  var texcoordLocation = gl.getAttribLocation(program, "a_texCoord");

  // provide texture coordinates for the rectangle.
  var texcoordBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0,
    ]),
    gl.STATIC_DRAW
  );

  // lookup uniforms
  var resolutionLocation = gl.getUniformLocation(program, "u_resolution");
  var mouseLocation = gl.getUniformLocation(program, "u_mouse");
  var uzoom = gl.getUniformLocation(program, "u_zoom");

  // lookup the sampler locations.
  var u_image0Location = gl.getUniformLocation(program, "u_image0");
  var u_image1Location = gl.getUniformLocation(program, "u_image1");
  var u_image2Location = gl.getUniformLocation(program, "u_image2");

  // let resized = resizeCanvasToDisplaySize(gl.canvas);
  // if (resized) {
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  // }

  // Clear the canvas
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // Tell it to use our program (pair of shaders)
  gl.useProgram(program);

  // Turn on the position attribute
  gl.enableVertexAttribArray(positionLocation);

  // Bind the position buffer.
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);

  // Tell the position attribute how to get data out of positionBuffer (ARRAY_BUFFER)
  var size = 2; // 2 components per iteration
  var type = gl.FLOAT; // the data is 32bit floats
  var normalize = false; // don't normalize the data
  var stride = 0; // 0 = move forward size * sizeof(type) each iteration to get the next position
  var offset = 0; // start at the beginning of the buffer
  gl.vertexAttribPointer(
    positionLocation,
    size,
    type,
    normalize,
    stride,
    offset
  );

  // Turn on the texcoord attribute
  gl.enableVertexAttribArray(texcoordLocation);

  // bind the texcoord buffer.
  gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer);

  // Tell the texcoord attribute how to get data out of texcoordBuffer (ARRAY_BUFFER)
  var size = 2; // 2 components per iteration
  var type = gl.FLOAT; // the data is 32bit floats
  var normalize = false; // don't normalize the data
  var stride = 0; // 0 = move forward size * sizeof(type) each iteration to get the next position
  var offset = 0; // start at the beginning of the buffer
  gl.vertexAttribPointer(
    texcoordLocation,
    size,
    type,
    normalize,
    stride,
    offset
  );

  // set the resolution
  gl.uniform2f(
    resolutionLocation,
    gl.canvas.width / zoom,
    gl.canvas.height / zoom
  );
  gl.uniform2f(mouseLocation, mousePos.x / zoom, mousePos.y / zoom);
  gl.uniform1f(uzoom, zoom);

  // set which texture units to render with.
  gl.uniform1i(u_image0Location, 0); // texture unit 0
  gl.uniform1i(u_image1Location, 1); // texture unit 1
  gl.uniform1i(u_image2Location, 2); // texture unit 1

  // Set each texture unit to use a particular texture.
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, textures[0]);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, textures[1]);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, textures[2]);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function initGL(images) {
  // Get A WebGL context
  /** @type {HTMLCanvasElement} */

  if (images.length === 0) {
    console.error("No Images!");
    return;
  }
  var canvas = document.querySelector("#canvas");
  gl = canvas.getContext("webgl");
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
    shaderSource = shaderScript.text;

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
  shaders.forEach(function (shader) {
    gl.attachShader(program, shader);
  });
  gl.linkProgram(program);

  // Check the link status
  const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
  if (!linked) {
    // something went wrong with the link
    const lastError = gl.getProgramInfoLog(program);
    errFn("Error in program linking:" + lastError);

    gl.deleteProgram(program);
    return null;
  }

  // setup GLSL program
  gl.useProgram(program);

  // const ext = gl.getExtension("WEBGL_depth_texture");

  // create textures
  textures = [];
  for (var ii = 0; ii < images.length; ++ii) {
    // console.log("texture: ", ii, images[ii]);
    var texture = gl.createTexture();
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

  render();
}

function setRectangle(gl, x, y, width, height) {
  var x1 = x;
  var x2 = x + width;
  var y1 = y;
  var y2 = y + height;
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([x1, y1, x2, y1, x1, y2, x1, y2, x2, y1, x2, y2]),
    gl.STATIC_DRAW
  );
}

var mousePos = { x: 1e6, y: 1e6 };

function getRelativeMousePosition(event, target) {
  target = target || event.target;
  var rect = target.getBoundingClientRect();

  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function debounce(callback, wait) {
  var timeout;
  return function (e) {
    clearTimeout(timeout);

    timeout = setTimeout(() => {
      callback(e);
    }, wait);
  };
}

// assumes target or event.target is canvas
function getNoPaddingNoBorderCanvasRelativeMousePosition(event, target) {
  target = target || event.target;
  var pos = getRelativeMousePosition(event, target);

  pos.x = (pos.x * target.width) / target.clientWidth;
  pos.y = (pos.y * target.height) / target.clientHeight;

  return pos;
}

const mobileAndTabletCheck = function () {
  let check = false;
  (function (a) {
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

const isMobile = mobileAndTabletCheck();

document.querySelector("#canvas").addEventListener(
  "touchstart",
  function (event) {
    if (event.touches.length == 1) {
      event.preventDefault();
    }
  },
  { passive: false }
);

const onMove = (e) => {
  const pos = getNoPaddingNoBorderCanvasRelativeMousePosition(e);
  mousePos.x = pos.x;
  mousePos.y = pos.y + (isMobile ? 1 : 0) * -40;
  console.debug("mousePos", mousePos);
  render();
};

document
  .querySelector("#canvas")
  .addEventListener("pointermove", debounce(onMove, 3));

document.addEventListener("resize", render);

async function main() {
  zix = 3;
  zoom = zooms[zix];
  await loadImages([discURL, finiURL, bgURL], initGL);
}

async function mainLG() {
  zix = 2;
  zoom = zooms[zix];
  await loadImages([discURL_LG, finiURL_LG, bgURL_LG], initGL);
}

window.main = main;
window.mainLG = mainLG;
window.adjustZoom = adjustZoom;
window.resetZoom = resetZoom;

main();
