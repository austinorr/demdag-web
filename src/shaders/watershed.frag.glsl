precision highp float;
precision highp int;

uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform vec2 u_mpos;
uniform float u_zoom;
uniform float u_snap;

// our textures
uniform sampler2D u_image0;
uniform sampler2D u_image1;
uniform sampler2D u_image2;

// the texCoords passed in from the vertex shader.
varying vec2 v_texCoord;

int buildInt(vec4 rgba) {
  int dv = int(rgba.r * 256.0) + int(rgba.g * 256.0 * 256.0) + int(rgba.b * 256.0 * 65536.0) + int(rgba.a * 256.0 * 16777216.0);
  return dv;
}

void main() {

  vec2 mpos = u_mpos / u_resolution;

  vec4 dvec = texture2D(u_image0, mpos);
  vec4 fvec = texture2D(u_image1, mpos);

  int dv = buildInt(dvec);
  int fv = buildInt(fvec);

  vec4 color0 = texture2D(u_image0, v_texCoord);
  vec4 color1 = texture2D(u_image1, v_texCoord);

  int d = buildInt(color0);
  int f = buildInt(color1);

  gl_FragColor = texture2D(u_image2, v_texCoord);

  // draw the loupe
  vec2 ss = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  float mdist = distance(floor(u_mouse) + vec2(0.5, 0.5), ss);
  if (mdist < max(u_snap, 0.708)  && (mdist > u_snap - 1.41422 * 1.2 || mdist <= 0.4)) {
    gl_FragColor *= vec4(0.2, 0.2, 0.2, 1.0);
  }

  // trace downstream flow path
  if (d < dv && f >= fv) {
    // boost to yellow.
    gl_FragColor += vec4(1.0, 1.0, 0.0, 0.0);
  }

  // trace upstream watershed
  if (d >= dv && f <= fv) {
    gl_FragColor *= vec4(0.1, 0.5, 0.8, 1.0);

    // boost blue channel to pure blue so we can count it up.
    gl_FragColor += vec4(0.0, 0.0, 1.0, 0.0);
  }
}
