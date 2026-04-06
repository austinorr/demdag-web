import vertSrc from "../shaders/watershed.vert.glsl";
import fragSrc from "../shaders/watershed.frag.glsl";

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
  const shaderDefs = [
    { source: vertSrc, type: gl.VERTEX_SHADER },
    { source: fragSrc, type: gl.FRAGMENT_SHADER },
  ];

  const shaders = [];
  for (const def of shaderDefs) {
    const shader = gl.createShader(def.type);

    gl.shaderSource(shader, def.source);
    gl.compileShader(shader);

    const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
    if (!compiled) {
      const lastError = gl.getShaderInfoLog(shader);
      console.error(
        "*** Error compiling shader '" +
          shader +
          "':" +
          lastError +
          `\n` +
          def.source
            .split("\n")
            .map((l, i) => `${i + 1}: ${l}`)
            .join("\n")
      );
      gl.deleteShader(shader);
      return null;
    }

    shaders.push(shader);
  }

  const program = gl.createProgram();
  shaders.forEach((shader) => {
    gl.attachShader(program, shader);
  });
  gl.linkProgram(program);

  const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
  if (!linked) {
    const lastError = gl.getProgramInfoLog(program);
    console.error("Error in program linking:" + lastError);
    gl.deleteProgram(program);
    return null;
  }

  return program;
};
