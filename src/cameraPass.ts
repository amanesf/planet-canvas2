import * as THREE from 'three';

// The camera stage: everything between the rendered scene and the picture.
//
// This began as depth of field alone. It has grown into the whole set of
// things a lens and a sensor do to an image, because that set is what was
// missing — a render can be geometrically and materially perfect and still
// read as a render, since no photograph has ever had a perfectly clean,
// evenly exposed, grainless frame with square corners.
//
// Depth of field is still the core of it. The reference is a macro shot:
// the focal
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
export const CameraPassShader = {
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
    /** seconds, for animating the grain */
    uTime: { value: 0 },
    /** how strongly out-of-focus highlights bloom into bokeh discs */
    uBokehBoost: { value: 5.0 },
    uVignette: { value: 0.34 },
    uGrain: { value: 0.05 },
    /** radial colour fringing at the frame edge, in UV units */
    uAberration: { value: 0.0016 },
    /** how much of the bright-area glow bleeds back into the frame */
    uBloomStrength: { value: 0.12 },
    /** glow sample radius, in UV units */
    uBloomRadius: { value: 0.008 },
    /** thin veiling haze mixed over the whole frame, like dust in the air */
    uHaze: { value: 0.035 },
    /**
     * How bright the diamond-dust sparkle specks are. Pulled back from 0.95
     * (an earlier "make it more noticeable" pass) now that the temporal
     * pattern itself is doing most of the work of reading as pretty rather
     * than distracting — a bright, busy grid of blinking dots was the
     * complaint, not a dim one.
     */
    uSparkleStrength: { value: 0.75 },
    /** sparkle grid cell size, in pixels */
    uSparkleScale: { value: 7.0 },
    /**
     * A small colour-grade pass on request ("aim for a high-quality anime
     * look overall") — punchier saturation and a gentle S-curve, the two
     * cheapest levers that actually move a render toward that look without
     * touching any one system's own colours. 1.0/0.0 would be a no-op.
     */
    uSaturation: { value: 1.16 },
    uContrast: { value: 0.1 },
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
    uniform float uTime;
    uniform float uBokehBoost;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uAberration;
    uniform float uBloomStrength;
    uniform float uBloomRadius;
    uniform float uHaze;
    uniform float uSparkleStrength;
    uniform float uSparkleScale;
    uniform float uSaturation;
    uniform float uContrast;
    varying vec2 vUv;

    // RINGS is set per quality tier: two rings read as a round aperture at
    // large radii, one is cheaper and enough at small ones. Each tap costs a
    // colour fetch and a depth fetch, so this count is the single biggest
    // lever on the cost of the frame.
    #ifndef RINGS
    #define RINGS 2
    #endif
    #define RING_TAPS 8

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

    // Out of focus, a point of light does not smear — it opens into a disc
    // the shape of the aperture, and it stays bright while doing so. A plain
    // average of neighbours does the opposite: it dilutes every highlight
    // into the dark pixels around it, which is why blurred background
    // sparkle came out as grey mush rather than as bokeh. Weighting each
    // sample by its own brightness restores the effect that makes defocused
    // light read as light.
    float bokehWeight(vec3 c) {
      // (three's own shader prefix already defines a luminance helper, and
      // GLSL will not accept a second body for it, so this inlines the same
      // calculation instead)
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      return 1.0 + uBokehBoost * l * l;
    }

    // Real glass does not focus every wavelength at the same radius, and the
    // mismatch grows toward the corners. It is a tiny effect and a
    // surprisingly strong tell — its complete absence is part of what makes
    // a render look synthetic.
    vec3 sampleScene(vec2 uv, float edge) {
      vec2 shift = (uv - vec2(0.5)) * uAberration * edge;
      return vec3(
        texture2D(tDiffuse, uv + shift).r,
        texture2D(tDiffuse, uv).g,
        texture2D(tDiffuse, uv - shift).b
      );
    }

    vec3 blurred(vec2 uv, float radius, float edge) {
      vec2 aspect = vec2(1.0, uResolution.x / uResolution.y);
      vec3 centre = sampleScene(uv, edge);
      float w0 = bokehWeight(centre);
      vec3 sum = centre * w0;
      float weight = w0;

      for (int ring = 1; ring <= RINGS; ring++) {
        float ringRadius = radius * (float(ring) / float(RINGS));
        float ringOffset = float(ring) * 0.4;
        for (int i = 0; i < RING_TAPS; i++) {
          float angle = (float(i) + ringOffset) / float(RING_TAPS) * 6.28318530718;
          vec2 tapUv = uv + vec2(cos(angle), sin(angle)) * aspect * ringRadius;

          // A sharp foreground pixel must not be smeared by a blurred
          // background one behind it, or every silhouette grows a halo.
          // Weighting each tap by its own blur amount keeps the bleed going
          // the way it does through a real lens: outward from the
          // out-of-focus subject, never into the focused one.
          float tapCoc = circleOfConfusion(tapUv);
          vec3 tap = sampleScene(tapUv, edge);
          float w = max(tapCoc, 0.05) * bokehWeight(tap);
          sum += tap * w;
          weight += w;
        }
      }

      return sum / weight;
    }

    // A cheap, single-ring approximation of bloom: only pixels bright
    // enough to be a highlight (a sunlit cloud top, a city light, lava
    // glow) feed it, so an ordinary mid-toned frame does not gain a soft
    // double-exposed look — only its actual highlights bleed a little,
    // which is what turns "glow" into a lens/eye response rather than a
    // uniform blur laid over everything.
    vec3 bloomGlow(vec2 uv, float edge) {
      vec2 aspect = vec2(1.0, uResolution.x / uResolution.y);
      const int TAPS = 6;
      vec3 sum = vec3(0.0);
      for (int i = 0; i < TAPS; i++) {
        float angle = (float(i) + 0.5) / float(TAPS) * 6.28318530718;
        vec2 offset = vec2(cos(angle), sin(angle)) * aspect * uBloomRadius;
        vec3 s = texture2D(tDiffuse, uv + offset).rgb;
        float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
        sum += s * smoothstep(0.55, 1.1, l);
      }
      return sum / float(TAPS);
    }

    // A diamond-dust glitter: fine specks that catch the light at random
    // moments and random positions, scattered across the whole frame.
    // Screen-space and grid-based — a scattered spatial hash per cell, the
    // same technique the grain noise below already uses — rather than real
    // particles, because the request was for an effect over the whole
    // picture (the room and the glass case as much as the globe), not a
    // feature of any one object in the scene.
    //
    // The previous version hashed only the cell, not time, so the same
    // ~9% of the screen blinked on a perfectly periodic sine loop forever
    // — a static, mechanical grid of dots rather than glitter, and exactly
    // what read as distracting rather than pretty. Time is quantized into
    // short cycles here, and which cells get a flash *this* cycle is
    // rehashed every cycle — so the sparkling positions themselves drift
    // and reshuffle instead of being fixed points that never move — and
    // each flash is a single short, randomly-timed pulse rather than a
    // continuous oscillation, so it reads as an occasional catch of light
    // instead of a blink you can predict.
    vec3 sparkleField(vec2 uv) {
      vec2 pixel = uv * uResolution;
      vec2 cell = floor(pixel / uSparkleScale);
      vec2 local = fract(pixel / uSparkleScale) - 0.5;

      const float cycleRate = 0.6; // cycles per second
      float cycle = floor(uTime * cycleRate);
      vec2 key = cell + vec2(cycle * 13.7, cycle * 71.3);
      float h = fract(sin(dot(key, vec2(41.3, 289.1))) * 43758.5453);
      // Sparse per cycle — most cells get no flash at all this round.
      if (h > 0.035) return vec3(0.0);

      vec2 jitter = vec2(fract(h * 97.13), fract(h * 53.71)) - 0.5;
      float d = length(local - jitter * 0.6);
      float core = smoothstep(0.2, 0.0, d);

      // A one-shot pulse timed to a random moment within this cycle
      // (startT), not a repeating wave — it rises, holds briefly, and
      // fades, once, then stays dark until (maybe) picked again next cycle.
      float cycleLen = 1.0 / cycleRate;
      float tInCycle = mod(uTime, cycleLen);
      float startT = fract(h * 613.7) * cycleLen * 0.7;
      float pulseLen = 0.12 + fract(h * 271.9) * 0.14;
      float p = (tInCycle - startT) / pulseLen;
      float pulse = smoothstep(0.0, 0.3, p) * smoothstep(1.0, 0.6, p);

      return vec3(0.85, 0.92, 1.0) * core * pulse;
    }

    void main() {
      vec2 centred = (vUv - vec2(0.5)) * vec2(uResolution.x / uResolution.y, 1.0);
      float edge = clamp(dot(centred, centred) * 2.2, 0.0, 1.0);

      float radius = circleOfConfusion(vUv) * uMaxBlur;
      vec3 colour = radius < 0.0003 ? sampleScene(vUv, edge) : blurred(vUv, radius, edge);

      // A thin glow off the frame's own highlights, on request — kept
      // small (see the uniform defaults) so it reads as a lens/eye
      // response to bright spots, not as a haze laid over the whole
      // picture (that is the separate, even fainter term below).
      colour += bloomGlow(vUv, edge) * uBloomStrength;

      // Lens falloff. Every lens is dimmer at the corners than in the
      // middle, and the eye reads an evenly lit rectangle as artificial long
      // before it can say why.
      colour *= 1.0 - uVignette * edge * edge;

      // A very thin veiling haze, like dust suspended in the light — lifts
      // the blacks a touch and pulls the frame toward the key lamp's own
      // warmth, which is what a lens shows in a room with anything
      // floating in the air, instead of the "photograph in vacuum"
      // cleanliness a raw render has by default. Small on purpose: this is
      // meant to be felt rather than seen.
      colour = mix(colour, vec3(0.5, 0.44, 0.36), uHaze);

      // Diamond dust, on request — additive and placed after the haze/
      // vignette so the specks read as points of light catching the eye
      // rather than as part of the scene's own shading, and not scaled by
      // the vignette itself: real glitter in the air keeps catching the
      // light out to the edge of frame, it does not dim with the lens.
      colour += sparkleField(vUv) * uSparkleStrength;

      // Colour grade: saturation lift, then a gentle S-curve. Both applied
      // after every other term above (haze, sparkle, bloom) so the grade
      // is over the whole finished picture, the way it would sit on a real
      // photograph rather than being baked into any one element's own
      // colours.
      float luma = dot(colour, vec3(0.2126, 0.7152, 0.0722));
      colour = mix(vec3(luma), colour, uSaturation);
      colour = mix(colour, smoothstep(0.0, 1.0, colour), uContrast);

      // Sensor grain, animated so it does not sit on the image like a
      // texture. Kept below the level where it is consciously visible: the
      // point is not to look grainy, it is to stop looking impossibly clean.
      float n = fract(sin(dot(vUv * uResolution + uTime * 137.0, vec2(12.9898, 78.233))) * 43758.5453);
      colour += (n - 0.5) * uGrain;

      gl_FragColor = vec4(colour, 1.0);
    }
  `,
};
