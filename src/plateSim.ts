import * as THREE from 'three';
import { mulberry32 } from './spatialHash';

// ---------------------------------------------------------------------
// Plate tectonics, live
// ---------------------------------------------------------------------
// design-memo.md's original plan for layer 1: "ボロノイ分割したプレートに
// 速度ベクトルを与え、境界で隆起／沈降を計算" (Voronoi-divide the sphere
// into plates, give each a velocity vector, compute uplift/subsidence at
// the boundaries). This is that, running on the GPU as a small render-
// target ping-pong — the same pattern gpgpu-test.html proved stable for
// 200+ seconds on the one real device this whole project has been tuned
// against, just doing real work instead of a throwaway test pattern.
//
// It does NOT replace terrain.ts's static height/color generation — that
// stays exactly as it is (rewriting ~1200 lines of tuned procedural
// terrain into GLSL is a different, much larger project). This produces
// one small extra signal — a height *delta*, evolving over time — that
// gets added on top of the existing static terrain in the vertex shader
// (see main.ts's onBeforeCompile injection on globeMaterial). The result
// is real, moving mountain-building at plate boundaries riding on a
// planet whose overall continents and paint stay put.
//
// Every plate rotates rigidly around its own axis (an "Euler pole", the
// same concept real plate tectonics uses) at its own fixed angular speed.
// At any simulated moment, whichever plate's rest frame a point on the
// sphere currently falls in is that point's owner; where two plates meet
// and are closing on each other, height accumulates (a collision zone);
// where they're pulling apart, it relaxes back down (a rift).

export const PLATE_COUNT = 7;
export const SIM_WIDTH = 128;
export const SIM_HEIGHT = 64;

// The simulation steps on its own clock, independent of the render frame
// rate — the render loop stays at whatever fps the device can hold, and
// only every few frames does an actual simulation tick (one render-target
// switch) happen. 4 ticks/second reads as continuous motion for
// something as slow as continental drift while keeping the GPU work this
// adds to a small, controlled fraction of the frame budget.
const TICK_INTERVAL = 0.25;

// How the speed multiplier is actually spent — see the long comment in
// update() below. Kept here alongside TICK_INTERVAL since the two
// together bound worst-case dispatch rate regardless of multiplier.
const MAX_SUBSTEP_SIM_SECONDS = 0.6;
const MAX_SUBSTEPS_PER_TICK = 12;

export interface PlateDef {
  pole: THREE.Vector3;
  seed: THREE.Vector3;
  /** signed angular speed, radians per simulated second — slow on purpose */
  speed: number;
}

function buildPlates(): PlateDef[] {
  const rand = mulberry32(90210);
  const plates: PlateDef[] = [];
  for (let i = 0; i < PLATE_COUNT; i++) {
    const poleZ = rand() * 2 - 1;
    const poleT = rand() * Math.PI * 2;
    const poleR = Math.sqrt(1 - poleZ * poleZ);
    const pole = new THREE.Vector3(poleR * Math.cos(poleT), poleZ, poleR * Math.sin(poleT));

    const seedZ = rand() * 2 - 1;
    const seedT = rand() * Math.PI * 2;
    const seedR = Math.sqrt(1 - seedZ * seedZ);
    const seed = new THREE.Vector3(seedR * Math.cos(seedT), seedZ, seedR * Math.sin(seedT));

    // a real plate drifts centimeters a year; this only has to look like
    // that scale of motion, not simulate it literally
    const speed = (rand() - 0.5) * 0.014;
    plates.push({ pole, seed, speed });
  }
  return plates;
}

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Same equirectangular convention terrain.ts's dirForPixel uses, so a
// texel here lines up with the same point on the sphere the terrain/bump
// textures do, and the globe mesh's own UVs (see main.ts) can sample this
// directly with no extra flip/remap.
const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  #define PLATE_COUNT ${PLATE_COUNT}
  uniform sampler2D tPrev;
  uniform vec3 uPoles[PLATE_COUNT];
  uniform vec3 uSeeds[PLATE_COUNT];
  uniform float uSpeeds[PLATE_COUNT];
  uniform float uSimTime;
  uniform float uDt;
  varying vec2 vUv;

  vec3 dirFromUv(vec2 uv) {
    float phi = uv.x * 6.283185307;
    float theta = uv.y * 3.141592653;
    return vec3(-cos(phi) * sin(theta), cos(theta), sin(phi) * sin(theta));
  }

  vec3 rotateAroundAxis(vec3 v, vec3 axis, float angle) {
    float s = sin(angle);
    float c = cos(angle);
    return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
  }

  void main() {
    vec3 worldDir = normalize(dirFromUv(vUv));

    // Which plate owns this point right now: rotate the query point back
    // into each plate's own rest frame and see which plate's seed it
    // lands closest to. Track the best and second-best match in one pass
    // — the runner-up is the neighbour across whatever boundary this
    // point is nearest to.
    float bestScore = -2.0;
    float secondScore = -2.0;
    int bestIdx = 0;
    int secondIdx = 1;

    for (int i = 0; i < PLATE_COUNT; i++) {
      vec3 restPoint = rotateAroundAxis(worldDir, uPoles[i], -uSpeeds[i] * uSimTime);
      float score = dot(restPoint, uSeeds[i]);
      if (score > bestScore) {
        secondScore = bestScore;
        secondIdx = bestIdx;
        bestScore = score;
        bestIdx = i;
      } else if (score > secondScore) {
        secondScore = score;
        secondIdx = i;
      }
    }

    vec3 poleI = uPoles[bestIdx];
    vec3 poleJ = uPoles[secondIdx];
    float speedI = uSpeeds[bestIdx];
    float speedJ = uSpeeds[secondIdx];

    // Each plate's current seed position (its rest-frame seed, carried
    // forward by that plate's own rotation) — the line between the two
    // nearest plates' current centres approximates the local boundary
    // direction well enough for this purpose.
    vec3 seedINow = rotateAroundAxis(uSeeds[bestIdx], poleI, speedI * uSimTime);
    vec3 seedJNow = rotateAroundAxis(uSeeds[secondIdx], poleJ, speedJ * uSimTime);
    vec3 toJ = seedJNow - seedINow;
    vec3 tangentToJ = toJ - worldDir * dot(toJ, worldDir);
    float tLen = length(tangentToJ);
    tangentToJ = tLen > 0.0001 ? tangentToJ / tLen : vec3(0.0);

    // Rigid-rotation velocity field: a point at worldDir on a plate
    // spinning around pole at speed moves at speed * (pole x point).
    vec3 velI = speedI * cross(poleI, worldDir);
    vec3 velJ = speedJ * cross(poleJ, worldDir);
    // positive: plate I is closing on plate J's side of the boundary —
    // a collision; negative: pulling apart — a rift
    float convergence = dot(velI - velJ, tangentToJ);

    // 0 deep inside a plate's own territory, 1 right on the boundary
    // line with its neighbour
    float boundary = 1.0 - clamp((bestScore - secondScore) * 6.0, 0.0, 1.0);

    float forcing = convergence * boundary * 0.6;

    // stored as 0..1 (unsigned byte target — the same render target type
    // gpgpu-test.html proved stable, no float-texture support required)
    float prev = texture2D(tPrev, vUv).r * 2.0 - 1.0;
    // slow decay: uplift doesn't accumulate into an unbounded spike, and
    // a rifted seam slowly relaxes rather than digging out forever — real
    // orogeny is a standing balance of uplift against erosion, not a
    // one-way ratchet
    float next = prev * 0.985 + forcing * uDt;
    next = clamp(next, -1.0, 1.0);

    gl_FragColor = vec4(next * 0.5 + 0.5, 0.0, 0.0, 1.0);
  }
`;

// ---------------------------------------------------------------------
// Shared GLSL for consumers that need to know "which plate, and where in
// that plate's own rest frame" for a point on the sphere — the same
// question the simulation fragment shader above answers to find
// convergence/divergence at boundaries. main.ts's globe vertex shader
// reuses this verbatim to make the *painted* terrain (the static color
// texture baked by terrain.ts) visually ride along with its owning
// plate's rotation, instead of only the height-delta bumps moving while
// the continents underneath stay painted in place.
//
// Deliberately duplicated as plain strings rather than shared with
// FRAGMENT_SHADER above: that shader's internals (dirFromUv, the
// boundary/convergence math) are private to the simulation pass and
// named without a prefix; these are meant to be spliced into someone
// else's shader alongside other identifiers, so everything here is
// prefixed `plate*` to avoid colliding with whatever that shader already
// declares.
export const PLATE_UNIFORMS_GLSL = /* glsl */ `
  #define PLATE_COUNT ${PLATE_COUNT}
  uniform vec3 uPoles[PLATE_COUNT];
  uniform vec3 uSeeds[PLATE_COUNT];
  uniform float uSpeeds[PLATE_COUNT];
  uniform float uSimTime;

  vec3 plateRotate(vec3 v, vec3 axis, float angle) {
    float s = sin(angle);
    float c = cos(angle);
    return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
  }

  // Same equirectangular convention as dirFromUv above (and terrain.ts's
  // dirForPixel) — deriving the query direction from the *UV* attribute
  // rather than the mesh's vertex position keeps plate ownership here
  // exactly consistent with how the height-delta texture's own texels
  // were assigned (that lookup already keys off this same uv attribute,
  // see uPlateSim's sample below), instead of introducing a second,
  // slightly different notion of "where this vertex is" from its
  // (already terrain-displaced) position.
  vec3 plateDirFromUv(vec2 uv) {
    float phi = uv.x * 6.283185307;
    float theta = uv.y * 3.141592653;
    return vec3(-cos(phi) * sin(theta), cos(theta), sin(phi) * sin(theta));
  }

  // Inverse of plateDirFromUv above (and of terrain.ts's dirForPixel,
  // which this must match exactly for a warped sample to land on the
  // same texel the unwarped one would have at t=0).
  vec2 plateUvFromDir(vec3 dir) {
    float theta = acos(clamp(dir.y, -1.0, 1.0));
    float phi = atan(dir.z, -dir.x);
    if (phi < 0.0) phi += 6.283185307;
    return vec2(phi / 6.283185307, theta / 3.141592653);
  }
`;

// Spliced in right after #include <uv_vertex>. As of the three.js version
// this project pins, that chunk does NOT feed the color/bump maps from
// the generic `vUv` varying — it computes dedicated `vMapUv` / `vBumpMapUv`
// varyings straight from the raw UV attribute, before this injected code
// ever runs, so overwriting `vUv` alone is a no-op for what actually gets
// sampled. This overwrites vMapUv/vBumpMapUv instead, with the UV of
// wherever this vertex's current position sat in its owning plate's rest
// frame at t=0 — i.e. "what was painted here before this plate had
// rotated". Everything downstream that samples them (the color map, the
// bump map, in the fragment shader) then picks up that moved paint
// automatically, with no other change needed.
//
// This is the same rotate-back-and-compare-to-each-seed search
// FRAGMENT_SHADER runs per simulation texel, just run once per vertex
// instead of per simulation texel, and keeping the winning rest-frame
// direction instead of only the winning index.
export const PLATE_UV_DRIFT_GLSL = /* glsl */ `
  {
    vec3 plateWorldDir = plateDirFromUv(uv);
    float plateBestScore = -2.0;
    vec3 plateRestDir = plateWorldDir;
    for (int i = 0; i < PLATE_COUNT; i++) {
      vec3 restPoint = plateRotate(plateWorldDir, uPoles[i], -uSpeeds[i] * uSimTime);
      float score = dot(restPoint, uSeeds[i]);
      if (score > plateBestScore) {
        plateBestScore = score;
        plateRestDir = restPoint;
      }
    }
    vec2 plateWarpedUv = plateUvFromDir(plateRestDir);
    #ifdef USE_MAP
    vMapUv = plateWarpedUv;
    #endif
    #ifdef USE_BUMPMAP
    vBumpMapUv = plateWarpedUv;
    #endif
  }
`;

export interface PlateSimulation {
  /** Current height-delta texture, in [0,1] (unpack with *2.0-1.0 in a consuming shader). */
  getTexture: () => THREE.Texture;
  /**
   * Call every frame; internally throttles actual GPU work to
   * TICK_INTERVAL. `speedMultiplier` scales simulated time per tick, not
   * tick frequency — see the implementation for why.
   */
  update: (renderer: THREE.WebGLRenderer, elapsedSeconds: number, speedMultiplier?: number) => void;
  /** Simulated seconds elapsed so far — for a consumer (e.g. the UV-drift
   * shader above) that needs to replay the exact same rest-frame rotation
   * this simulation used, rather than the real-time clock. */
  getSimTime: () => number;
  /** The plate definitions this instance was built with (fixed, seeded —
   * same values every time), so a consumer can build its own uPoles /
   * uSeeds / uSpeeds uniform arrays that stay in lockstep with the ones
   * driving the simulation itself. */
  getPlateDefs: () => PlateDef[];
}

function makeRenderTarget(): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(SIM_WIDTH, SIM_HEIGHT, {
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearFilter,
    generateMipmaps: false,
  });
  rt.texture.flipY = false;
  return rt;
}

export function createPlateSimulation(): PlateSimulation {
  const plates = buildPlates();

  let rtA = makeRenderTarget();
  let rtB = makeRenderTarget();

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      tPrev: { value: rtA.texture },
      uPoles: { value: plates.map((p) => p.pole) },
      uSeeds: { value: plates.map((p) => p.seed) },
      uSpeeds: { value: plates.map((p) => p.speed) },
      uSimTime: { value: 0 },
      uDt: { value: 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

  let simTime = 0;
  let accumulator = 0;
  let lastElapsed = 0;

  const update = (renderer: THREE.WebGLRenderer, elapsedSeconds: number, speedMultiplier = 1) => {
    const dt = Math.max(0, Math.min(elapsedSeconds - lastElapsed, 0.25));
    lastElapsed = elapsedSeconds;
    accumulator += dt;
    if (accumulator < TICK_INTERVAL) return;
    const totalStepDt = accumulator * speedMultiplier;
    accumulator = 0;

    // A single dispatch covering a large simulated-time jump is not the
    // same simulation run faster — it's a different, wrong one. The
    // boundary test re-derives plate ownership from scratch each
    // dispatch by rotating back to t=0, so a big enough jump can put a
    // texel under a *different* neighbour than the previous dispatch saw,
    // flipping the accumulated forcing's sign dispatch to dispatch
    // instead of building consistently in one direction — this is what
    // read as the terrain squirming instead of visibly drifting at high
    // speed. Splitting a big jump into several smaller dispatches, each
    // one actually feeding forward from the previous texture the way the
    // 1x case always did, keeps every step physically continuous.
    //
    // Capped rather than scaled exactly to the multiplier: even at 100x,
    // real per-second dispatch count stays well inside the range
    // gpgpu-test.html already proved stable (that ran one dispatch every
    // frame, ~60/sec, for 200+ seconds) — MAX_SUBSTEPS_PER_TICK *
    // (1 / TICK_INTERVAL) tops out around 48/sec here, comfortably under
    // that, regardless of how high the multiplier goes.
    const substeps = Math.min(
      MAX_SUBSTEPS_PER_TICK,
      Math.max(1, Math.ceil(totalStepDt / MAX_SUBSTEP_SIM_SECONDS)),
    );
    const subDt = totalStepDt / substeps;

    const previousTarget = renderer.getRenderTarget();
    for (let i = 0; i < substeps; i++) {
      simTime += subDt;
      material.uniforms.tPrev.value = rtA.texture;
      material.uniforms.uSimTime.value = simTime;
      material.uniforms.uDt.value = subDt;

      renderer.setRenderTarget(rtB);
      renderer.render(scene, camera);

      const swap = rtA;
      rtA = rtB;
      rtB = swap;
    }
    renderer.setRenderTarget(previousTarget);
  };

  return {
    getTexture: () => rtA.texture,
    update,
    getSimTime: () => simTime,
    getPlateDefs: () => plates,
  };
}
