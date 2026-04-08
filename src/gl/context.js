import vertSrc from "../shaders/watershed.vert.glsl";
import fragSrc from "../shaders/watershed.frag.glsl";
import { compileShader, linkProgram } from "./shader.js";

export const createContext = (canvas) => {
  canvas.style["image-rendering"] = "pixelated";
  const gl = canvas.getContext("webgl2", { antialias: false });
  if (!gl) {
    const msg = "Your browser does not support WebGL 2. Please use a modern browser (Chrome, Firefox, Safari 15+, Edge).";
    console.error(msg);
    canvas.parentElement.innerHTML = `<p style="color:red; padding:1em">${msg}</p>`;
    return null;
  }
  return gl;
};

export const createProgram = (gl) => {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!vs || !fs) return null;
  return linkProgram(gl, vs, fs);
};
