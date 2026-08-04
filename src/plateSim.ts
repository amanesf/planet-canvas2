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

const PLATE_COUNT = 7;
export const SIM_WIDTH = 128;
export const SIM_HEIGHT = 64;

// The simulation steps on its own clock, independent of the render frame
// rate — the render loop stays at whatever fps the device can hold, and
// only every few frames does an actual simulation tick (one render-target
// switch) happen. 4 ticks/second reads as continuous motion for
// something as slow as continental drift while keeping the GPU work this
// adds to a small, controlled fraction of the frame budget.
const TICK_INTERVAL = 0.25;

interface PlateDef {
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

export interface PlateSimulation {
  /** Current height-delta texture, in [0,1] (unpack with *2.0-1.0 in a consuming shader). */
  getTexture: () => THREE.Texture;
  /**
   * Call every frame; internally throttles actual GPU work to
   * TICK_INTERVAL. `speedMultiplier` scales simulated time per tick, not
   * tick frequency — see the implementation for why.
   */
  update: (renderer: THREE.WebGLRenderer, elapsedSeconds: number, speedMultiplier?: number) => void;
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
    // The tick still only fires at the same real-world cadence (one
    // render-target switch roughly every TICK_INTERVAL seconds,
    // regardless of speed) — a multiplier scales how much *simulated*
    // time that one tick covers, not how often it happens, so speeding
    // this up costs nothing extra on the GPU.
    const stepDt = accumulator * speedMultiplier;
    accumulator = 0;
    simTime += stepDt;

    material.uniforms.tPrev.value = rtA.texture;
    material.uniforms.uSimTime.value = simTime;
    material.uniforms.uDt.value = stepDt;

    // this device's driver copes fine with switching render targets (see
    // gpgpu-test.html) — the crash this project spent so long chasing
    // was shadow mapping, not this pattern; restoring the caller's own
    // target afterward keeps this a self-contained step regardless
    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(rtB);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previousTarget);

    const swap = rtA;
    rtA = rtB;
    rtB = swap;
  };

  return {
    getTexture: () => rtA.texture,
    update,
  };
}
