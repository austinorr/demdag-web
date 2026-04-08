export const compileShader = (gl, type, source) => {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(
      "Shader compile error:",
      gl.getShaderInfoLog(shader),
      "\n" +
        source
          .split("\n")
          .map((l, i) => `${i + 1}: ${l}`)
          .join("\n"),
    );
    gl.deleteShader(shader);
    return null;
  }
  return shader;
};

export const linkProgram = (gl, vs, fs) => {
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("Program link error:", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
};
