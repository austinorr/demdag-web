#version 300 es

precision highp float;
precision highp int;

uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform ivec2 u_mpos;
uniform float u_zoom;
uniform float u_snap;

// data textures (unsigned integer)
uniform highp usampler2D u_image0;
uniform highp usampler2D u_image1;

// background texture (RGBA)
uniform sampler2D u_image2;

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
  // read discovery/finish at cursor position (unsigned integer texel fetch)
  uint dv = texelFetch(u_image0, u_mpos, 0).r;
  uint fv = texelFetch(u_image1, u_mpos, 0).r;

  // read discovery/finish at this fragment's position
  ivec2 texel = ivec2(v_texCoord * vec2(textureSize(u_image0, 0)));
  uint d = texelFetch(u_image0, texel, 0).r;
  uint f = texelFetch(u_image1, texel, 0).r;

  fragColor = texture(u_image2, v_texCoord);

  // draw the loupe
  vec2 ss = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  float mdist = distance(floor(u_mouse) + vec2(0.5, 0.5), ss);
  if (mdist < max(u_snap, 0.708)  && (mdist > u_snap - 1.41422 * 1.2 || mdist <= 0.4)) {
    fragColor *= vec4(0.2, 0.2, 0.2, 1.0);
  }

  // trace downstream flow path
  if (d < dv && f >= fv) {
    // boost to yellow.
    fragColor += vec4(1.0, 1.0, 0.0, 0.0);
  }

  // trace upstream watershed
  if (d >= dv && f <= fv) {
    fragColor *= vec4(0.1, 0.5, 0.8, 1.0);

    // boost blue channel to pure blue so we can count it up.
    fragColor += vec4(0.0, 0.0, 1.0, 0.0);
  }
}
