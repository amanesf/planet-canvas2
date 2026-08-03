import * as THREE from 'three';

// A deliberately lightweight stand-in for real depth-of-field. The stock
// three.js BokehPass re-renders the *entire scene a second time* every
// frame just to get a depth buffer, then runs a ~40-tap blur kernel over
// the full screen — that's exactly the category of extra per-frame GPU
// work (doubled geometry passes, heavy fragment shaders) that caused the
// real-time-shadow-map mobile crashes this project already fought hard to
// fix. A classic photographic tilt-shift lens doesn't actually blur by
// scene depth anyway — it blurs by distance from a flat focus band across
// the frame, which is exactly what miniature-effect photo filters fake.
// That means this can skip the depth pre-pass entirely: one single
// full-screen pass, a fixed small 8-tap blur, no second scene render.
export const TiltShiftShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    // 0 (top) .. 1 (bottom) in screen space — where the sharp band sits
    uFocusCenter: { value: 0.46 },
    uFocusHalfWidth: { value: 0.1 },
    uFalloff: { value: 0.18 },
    // max blur radius, in UV units, reached at the top/bottom edges
    uMaxBlur: { value: 0.0045 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uFocusCenter;
    uniform float uFocusHalfWidth;
    uniform float uFalloff;
    uniform float uMaxBlur;
    varying vec2 vUv;

    void main() {
      float dist = abs(vUv.y - uFocusCenter);
      float blurT = smoothstep(uFocusHalfWidth, uFocusHalfWidth + uFalloff, dist);
      float radius = blurT * uMaxBlur;
      vec2 aspectcorrect = vec2(1.0, uResolution.x / uResolution.y);

      vec4 sum = texture2D(tDiffuse, vUv);
      const int TAPS = 8;
      for (int i = 0; i < TAPS; i++) {
        float angle = (float(i) / float(TAPS)) * 6.28318530718;
        vec2 offset = vec2(cos(angle), sin(angle)) * aspectcorrect * radius;
        sum += texture2D(tDiffuse, vUv + offset);
      }
      gl_FragColor = sum / float(TAPS + 1);
    }
  `,
};
