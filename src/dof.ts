import * as THREE from 'three';

// Real depth of field, replacing the fixed horizontal blur band that stood
// in for it.
//
// The band was defensible as a tilt-shift *filter*, but it is not what the
// reference photograph is doing. That image is a macro shot: the focal
// plane cuts through the front of the globe, and everything falls out of
// focus with *distance from the lens* — the far side of the sphere, the
// paint bottles at the back of the desk, and the cotton in the immediate
// foreground are all soft, while a horizontal band across the middle of
// the frame is sharp top to bottom. A screen-space band cannot express
// that, because it has no idea which pixels are near and which are far. It
// is also the single strongest cue that a photograph was taken of a small
// object from close range, which is precisely the impression this scene is
// trying to give.
//
// The depth buffer comes from the composer's own render target rather than
// from a second scene render, so this stays one full-screen pass.
export const DepthOfFieldShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uNear: { value: 0.1 },
    uFar: { value: 100 },
    /** distance from the camera, in world units, that is perfectly sharp */
    uFocusDistance: { value: 8 },
    /** how far from that plane a point can be before it blurs at all */
    uFocusRange: { value: 1.9 },
    /** world distance over which blur ramps from zero to maximum */
    uFalloff: { value: 4.0 },
    /** maximum circle of confusion, in UV units */
    uMaxBlur: { value: 0.011 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uResolution;
    uniform float uNear;
    uniform float uFar;
    uniform float uFocusDistance;
    uniform float uFocusRange;
    uniform float uFalloff;
    uniform float uMaxBlur;
    varying vec2 vUv;

    // depth buffer value -> distance from the camera in world units
    float linearDepth(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      // a perspective depth buffer is heavily non-linear; undo the
      // projection so "how far out of focus" can be measured in the same
      // units the focus distance is expressed in
      float viewZ = (uNear * uFar) / ((uFar - uNear) * d - uFar);
      return -viewZ;
    }

    float circleOfConfusion(vec2 uv) {
      float dist = linearDepth(uv);
      float defocus = max(abs(dist - uFocusDistance) - uFocusRange, 0.0);
      return clamp(defocus / uFalloff, 0.0, 1.0);
    }

    void main() {
      float coc = circleOfConfusion(vUv);
      float radius = coc * uMaxBlur;

      if (radius < 0.0003) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }

      vec2 aspect = vec2(1.0, uResolution.x / uResolution.y);
      vec4 sum = texture2D(tDiffuse, vUv);
      float weight = 1.0;

      // RINGS is set per quality tier: two rings read as a round aperture
      // at large radii, one is cheaper and enough at small ones. Each tap
      // costs a color fetch and a depth fetch, so this count is the single
      // biggest lever on the cost of the frame.
      #ifndef RINGS
      #define RINGS 2
      #endif
      const int RING_TAPS = 8;
      for (int ring = 1; ring <= RINGS; ring++) {
        float ringRadius = radius * (float(ring) / float(RINGS));
        float ringOffset = float(ring) * 0.4;
        for (int i = 0; i < RING_TAPS; i++) {
          float angle = (float(i) + ringOffset) / float(RING_TAPS) * 6.28318530718;
          vec2 offset = vec2(cos(angle), sin(angle)) * aspect * ringRadius;
          vec2 uv = vUv + offset;

          // A sharp foreground pixel must not be smeared by a blurred
          // background one behind it, or every silhouette grows a halo.
          // Weighting each tap by its own blur amount keeps the bleed
          // going the way it does through a real lens: outward from the
          // out-of-focus subject, never into the focused one.
          float tapCoc = circleOfConfusion(uv);
          float w = max(tapCoc, 0.05);
          sum += texture2D(tDiffuse, uv) * w;
          weight += w;
        }
      }

      gl_FragColor = sum / weight;
    }
  `,
};
