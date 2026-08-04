import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  aridityAt,
  badlandsAt,
  BADLANDS_THRESHOLD,
  DESERT_ARIDITY_THRESHOLD,
  orogenyBeltAt,
  sampledHeight,
  SEA_LEVEL,
  snowinessAt,
  temperatureAt,
  terracedElevation,
} from './terrain';
import { clumpDensity, displaceWithNoise, mulberry32, smoothstep, SpatialHash } from './spatialHash';
import { fbm3 } from './noise';

// ---------------------------------------------------------------------
// One scatter, everything that stands on the ground
// ---------------------------------------------------------------------
// This used to be two systems sweeping the sphere independently: a
// "vegetation" pass (savanna trees/mountain rocks, dense forest canopy,
// ground grass, loose scree — four sub-sweeps of its own) and a "species"
// pass classifying candidates into fourteen further kinds. Each sweep
// generated its own random directions and resampled height, elevation,
// temperature, aridity, badlands and snowiness independently for them —
// so adding the species pass on top of the existing four made startup
// slower in proportion, not because there was more to build but because
// there was another full sphere to walk.
//
// Now there is one candidate stream. Every candidate's climate is sampled
// once (see `sampleAt`) and handed to every layer that might want it —
// the fourteen-species classifier, the forest canopy, the grass, the
// savanna trees and mountain rocks, and the scree — each of which still
// keeps its own spatial hash and spacing (they have very different
// densities), but none of which pays to regenerate the point or its
// climate. Adding a new layer costs a branch and a hash, not a sweep.
//
// The other half of "one scatter" is not looking like one: accepting
// every candidate that passes a biome test produces a mathematically even
// lattice, and nothing in nature is that regular — real ground cover sits
// in drifts and clusters with bare gaps between. `clumpDensity` (see
// spatialHash.ts) gates acceptance by coherent noise instead of a flat
// probability, so cacti come in stands, boulders in fields, and there is
// always somewhere for the ground to just be ground.

export type Species =
  | 'conifer'
  | 'palm'
  | 'deadTree'
  | 'bamboo'
  | 'mangrove'
  | 'shrub'
  | 'cactus'
  | 'desertScrub'
  | 'butte'
  | 'seaStack'
  | 'iceFloe'
  | 'glacier'
  | 'snowDrift'
  | 'geyser';

/** Whether a species is planted (tinted green-ish) or mineral. */
const MINERAL: ReadonlySet<Species> = new Set<Species>([
  'butte',
  'seaStack',
  'iceFloe',
  'glacier',
  'snowDrift',
  'geyser',
]);

interface Placement {
  dir: THREE.Vector3;
  height: number;
  species: Species;
}

// Climate sampled once per candidate direction and shared by every layer
// below, instead of each layer resampling it for its own private stream
// of candidates.
interface Sample {
  dir: THREE.Vector3;
  height: number;
  elevation: number;
  temperature: number;
  snow: number;
  arid: number;
  belt: number;
  badlands: number;
  underwater: boolean;
  shelfDepth: number;
}

function sampleAt(dir: THREE.Vector3): Sample {
  const height = sampledHeight(dir).raw;
  const elevation = terracedElevation(height);
  return {
    dir,
    height,
    elevation,
    temperature: temperatureAt(dir, elevation),
    snow: snowinessAt(dir, height),
    arid: aridityAt(dir),
    belt: orogenyBeltAt(dir),
    badlands: badlandsAt(dir),
    underwater: height < SEA_LEVEL,
    shelfDepth: SEA_LEVEL - height,
  };
}

/**
 * What belongs at this point, or null for bare ground.
 *
 * The order matters: the tests run from the most specific habitat to the
 * least, so that (say) a mangrove coast is not first claimed by the
 * generic tropical case. Each acceptance chance is gated by
 * `clumpDensity` with a seed of its own, so one species' clusters don't
 * line up with another's.
 */
function classify(s: Sample, rand: () => number): Species | null {
  const { dir, elevation, temperature, snow, arid, belt, badlands, underwater, shelfDepth } = s;

  if (underwater) {
    // Only the shallow shelf holds anything; deep water is empty.
    if (shelfDepth > 0.045) return null;
    if (temperature < 0.06) return rand() < 0.55 * clumpDensity(dir, 11) ? 'iceFloe' : null;
    if (temperature > 0.62 && shelfDepth < 0.02) return rand() < 0.5 * clumpDensity(dir, 23) ? 'mangrove' : null;
    // rock left standing where a cliffed coast has been cut back
    if (belt > 0.2 && shelfDepth < 0.03) return rand() < 0.35 * clumpDensity(dir, 37) ? 'seaStack' : null;
    return null;
  }

  // Frozen ground: ice and drifts, nothing that grows.
  if (snow > 0.5) {
    if (elevation > 0.2 && belt > 0.25) return rand() < 0.4 * clumpDensity(dir, 41) ? 'glacier' : null;
    return rand() < 0.3 * clumpDensity(dir, 53) ? 'snowDrift' : null;
  }

  // Volcanic country vents steam.
  if (belt > 0.55 && elevation > 0.16 && rand() < 0.06 * clumpDensity(dir, 61)) return 'geyser';

  if (arid > 0.62) {
    if (badlands > 0.32) return rand() < 0.5 * clumpDensity(dir, 71) ? 'butte' : null;
    if (temperature > 0.45) {
      if (rand() >= clumpDensity(dir, 83)) return null; // bare gaps between succulent stands
      return rand() < 0.45 ? 'cactus' : 'desertScrub';
    }
    return rand() < 0.4 * clumpDensity(dir, 97) ? 'desertScrub' : null;
  }

  // The tree line, and the dry margin of the forest: standing deadwood.
  if (elevation > 0.15 || arid > 0.5) return rand() < 0.18 * clumpDensity(dir, 101) ? 'deadTree' : null;

  if (temperature > 0.7) {
    // equatorial: palms along the shore, bamboo further in
    if (elevation < 0.03) return rand() < 0.5 * clumpDensity(dir, 113) ? 'palm' : null;
    return rand() < 0.35 * clumpDensity(dir, 127) ? 'bamboo' : null;
  }
  if (temperature < 0.34) return rand() < 0.6 * clumpDensity(dir, 131) ? 'conifer' : null;
  return rand() < 0.3 * clumpDensity(dir, 149) ? 'shrub' : null;
}

// ---------------------------------------------------------------------
// The models
// ---------------------------------------------------------------------
// Everything here is sized against the display scale: the globe is about
// 500 pixels across for a radius of 2, so one world unit is roughly 125
// pixels and nothing under about 0.03 units can be seen at all. These run
// from 0.03 to 0.09 — small enough to read as miniature, large enough to
// have a recognisable outline, which is the only thing that distinguishes
// one species from another at this size.

function cone(radius: number, height: number, y: number, segments = 6): THREE.BufferGeometry {
  return new THREE.ConeGeometry(radius, height, segments).translate(0, y + height / 2, 0);
}

function column(
  bottom: number,
  top: number,
  height: number,
  y: number,
  segments = 6,
): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(top, bottom, height, segments).translate(0, y + height / 2, 0);
}

function buildModel(species: Species, rand: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  switch (species) {
    case 'conifer': {
      // a spire, which is the whole point — nothing else on the planet has
      // a vertical silhouette, so it reads as boreal at a glance
      parts.push(column(0.006, 0.004, 0.02, 0, 5));
      for (let i = 0; i < 3; i++) {
        const t = i / 3;
        parts.push(cone(0.026 * (1 - t * 0.55), 0.038, 0.016 + t * 0.026, 7));
      }
      break;
    }
    case 'palm': {
      const trunk = column(0.005, 0.004, 0.07, 0, 5);
      trunk.rotateZ(0.18);
      parts.push(trunk);
      for (let i = 0; i < 5; i++) {
        const frond = new THREE.ConeGeometry(0.012, 0.05, 4);
        frond.translate(0, 0.025, 0);
        frond.rotateZ(Math.PI * 0.42);
        frond.rotateY((i / 5) * Math.PI * 2 + rand());
        frond.translate(0.012, 0.07, 0);
        parts.push(frond);
      }
      break;
    }
    case 'deadTree': {
      parts.push(column(0.006, 0.002, 0.055, 0, 5));
      for (let i = 0; i < 3; i++) {
        const branch = new THREE.CylinderGeometry(0.0012, 0.003, 0.03, 4);
        branch.translate(0, 0.015, 0);
        branch.rotateZ(0.7 + rand() * 0.5);
        branch.rotateY(rand() * Math.PI * 2);
        branch.translate(0, 0.036 + i * 0.008, 0);
        parts.push(branch);
      }
      break;
    }
    case 'bamboo': {
      for (let i = 0; i < 6; i++) {
        const culm = column(0.0035, 0.0025, 0.055 + rand() * 0.03, 0, 4);
        culm.rotateZ((rand() - 0.5) * 0.22);
        culm.translate((rand() - 0.5) * 0.026, 0, (rand() - 0.5) * 0.026);
        parts.push(culm);
      }
      break;
    }
    case 'mangrove': {
      // the recognisable part is the stilt roots standing out of the water
      parts.push(cone(0.028, 0.03, 0.022, 7));
      for (let i = 0; i < 5; i++) {
        const root = new THREE.CylinderGeometry(0.002, 0.003, 0.03, 4);
        root.translate(0, 0.015, 0);
        root.rotateZ(0.5);
        root.rotateY((i / 5) * Math.PI * 2);
        parts.push(root);
      }
      break;
    }
    case 'shrub': {
      const g = new THREE.IcosahedronGeometry(0.024, 1);
      displaceWithNoise(g, 0.3, 3, rand() * 500);
      g.scale(1.1, 0.7, 1.1);
      g.translate(0, 0.014, 0);
      parts.push(g);
      break;
    }
    case 'cactus': {
      parts.push(column(0.008, 0.007, 0.06, 0, 7));
      for (let i = 0; i < 2; i++) {
        const arm = new THREE.CylinderGeometry(0.005, 0.005, 0.028, 6);
        arm.translate(0, 0.014, 0);
        arm.rotateZ(i === 0 ? 1.2 : -1.2);
        arm.translate(0, 0.034, 0);
        parts.push(arm);
        const tip = new THREE.CylinderGeometry(0.005, 0.005, 0.018, 6);
        tip.translate(0, 0.009, 0);
        tip.translate(i === 0 ? 0.017 : -0.017, 0.042, 0);
        parts.push(tip);
      }
      break;
    }
    case 'desertScrub': {
      for (let i = 0; i < 4; i++) {
        const twig = new THREE.ConeGeometry(0.004, 0.022, 4);
        twig.translate(0, 0.011, 0);
        twig.rotateZ((rand() - 0.5) * 1.1);
        twig.rotateY(rand() * Math.PI * 2);
        parts.push(twig);
      }
      break;
    }
    case 'butte': {
      // a flat-topped mesa, the shape the badlands paint has been
      // describing with no geometry to back it up
      const g = new THREE.CylinderGeometry(0.03, 0.045, 0.055, 7);
      displaceWithNoise(g, 0.12, 8, rand() * 500);
      g.translate(0, 0.02, 0);
      parts.push(g);
      break;
    }
    case 'seaStack': {
      const g = new THREE.CylinderGeometry(0.014, 0.026, 0.075, 6);
      displaceWithNoise(g, 0.2, 7, rand() * 500);
      g.translate(0, 0.03, 0);
      parts.push(g);
      break;
    }
    case 'iceFloe': {
      const g = new THREE.CylinderGeometry(0.055, 0.05, 0.012, 7);
      displaceWithNoise(g, 0.25, 6, rand() * 500);
      g.scale(1, 1, 0.7);
      parts.push(g);
      break;
    }
    case 'glacier': {
      const g = new THREE.BoxGeometry(0.05, 0.02, 0.11, 2, 1, 3);
      displaceWithNoise(g, 0.18, 9, rand() * 500);
      g.translate(0, 0.008, 0);
      parts.push(g);
      break;
    }
    case 'snowDrift': {
      const g = new THREE.SphereGeometry(0.045, 7, 5);
      displaceWithNoise(g, 0.3, 4, rand() * 500);
      g.scale(1.3, 0.4, 1);
      parts.push(g);
      break;
    }
    case 'geyser': {
      // the plume, not the vent: steam is what you can see from here
      for (let i = 0; i < 4; i++) {
        const puff = new THREE.SphereGeometry(0.012 + i * 0.004, 6, 4);
        puff.translate((rand() - 0.5) * 0.012, 0.02 + i * 0.022, (rand() - 0.5) * 0.012);
        parts.push(puff);
      }
      break;
    }
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  merged.computeVertexNormals();
  return merged;
}

/** Base colour for a species, before the per-instance jitter. */
function speciesColor(species: Species, temperature: number, out: THREE.Color): THREE.Color {
  switch (species) {
    case 'conifer':
      return out.setHSL(0.31, 0.44, 0.24, THREE.SRGBColorSpace);
    case 'palm':
      return out.setHSL(0.22, 0.58, 0.32, THREE.SRGBColorSpace);
    case 'bamboo':
      return out.setHSL(0.19, 0.6, 0.35, THREE.SRGBColorSpace);
    case 'mangrove':
      return out.setHSL(0.25, 0.5, 0.33, THREE.SRGBColorSpace);
    case 'shrub':
      // the savanna belt yellows off as it dries
      return out.setHSL(0.16 + temperature * 0.06, 0.5, 0.35, THREE.SRGBColorSpace);
    case 'deadTree':
      return out.setHSL(0.08, 0.1, 0.55, THREE.SRGBColorSpace);
    case 'cactus':
      return out.setHSL(0.29, 0.36, 0.3, THREE.SRGBColorSpace);
    case 'desertScrub':
      return out.setHSL(0.11, 0.22, 0.3, THREE.SRGBColorSpace);
    case 'butte':
      return out.setHSL(0.07, 0.26, 0.4, THREE.SRGBColorSpace);
    case 'seaStack':
      return out.setHSL(0.08, 0.12, 0.38, THREE.SRGBColorSpace);
    case 'iceFloe':
      return out.setHSL(0.55, 0.1, 0.82, THREE.SRGBColorSpace);
    case 'glacier':
      return out.setHSL(0.55, 0.14, 0.76, THREE.SRGBColorSpace);
    case 'snowDrift':
      return out.setHSL(0.58, 0.05, 0.88, THREE.SRGBColorSpace);
    case 'geyser':
      return out.setHSL(0.55, 0.04, 0.9, THREE.SRGBColorSpace);
  }
}

// ---------------------------------------------------------------------
// The rest of the ground cover, folded in from the old vegetation pass:
// forest canopy, grass, savanna trees, mountain rocks and scree. These
// keep their own geometry and colour logic (a dense clumped canopy mass
// and a ground tuft have nothing in common with a fourteen-species
// InstancedMesh-per-kind), but they now read from the same candidate
// stream as everything above instead of sweeping the sphere on their own.
// ---------------------------------------------------------------------

// Below this aridity: lush enough for a real forest canopy mass (handled
// by the forest layer, not individual trees). Between this and the desert
// threshold: savanna — sparse, individually-visible trees are correct
// there, not a mistake to "fix" with more density.
const FOREST_ARIDITY_MAX = 0.44;

// Below this temperature it's tundra/ice country — too cold for forest,
// savanna, or desert dressing; those zones stay bare (the paint itself
// already reads as tundra/ice, see terrain.ts's biomeColor).
const COLD_TEMPERATURE_LIMIT = 0.09;

/**
 * Where on the tropical/temperate/boreal scale a point sits, expressed as
 * the hue, saturation and lightness its foliage should start from.
 */
function canopyClimate(
  dir: THREE.Vector3,
  elevation: number,
): { hue: number; saturation: number; lightness: number } {
  const temperature = temperatureAt(dir, elevation);
  const tropical = smoothstep(temperature, 0.6, 0.86);
  const boreal = 1 - smoothstep(temperature, 0.22, 0.48);

  // temperate baseline
  let hue = 0.215;
  let saturation = 0.56;
  let lightness = 0.32;

  // jungle: yellower and brighter
  hue = THREE.MathUtils.lerp(hue, 0.195, tropical);
  saturation = THREE.MathUtils.lerp(saturation, 0.66, tropical);
  lightness = THREE.MathUtils.lerp(lightness, 0.36, tropical);

  // taiga: bluer, darker, less saturated — spruce, not meadow
  hue = THREE.MathUtils.lerp(hue, 0.3, boreal);
  saturation = THREE.MathUtils.lerp(saturation, 0.38, boreal);
  lightness = THREE.MathUtils.lerp(lightness, 0.2, boreal);

  // and everything thins and dulls as it climbs toward the tree line
  const alpine = smoothstep(elevation, 0.09, 0.16);
  saturation *= 1 - alpine * 0.35;
  lightness *= 1 - alpine * 0.3;

  return { hue, saturation, lightness };
}

// A poofy, "mokomoko" canopy clump — several overlapping rounded lobes'
// worth of silhouette from a single displaced sphere (see displaceWithNoise
// for why one coherent displacement reads better than independent
// per-vertex jitter at this poly count), so hundreds of forest clumps
// still cost only a few instanced draw calls.
function buildCanopyBlob(rand: () => number, detail: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.05, detail);
  displaceWithNoise(g, detail >= 2 ? 0.42 : 0.3, 2.4, rand() * 500);
  displaceWithNoise(g, 0.13, 7, rand() * 500 + 300);
  g.scale(1, 0.78, 1); // clump foliage settles wider than it is tall
  g.computeVertexNormals();
  return g;
}

const dummy = new THREE.Object3D();
const up = new THREE.Vector3(0, 1, 0);

function orient(position: THREE.Vector3, normal: THREE.Vector3, spin: number, tilt = 0, tiltAxisAngle = 0) {
  dummy.position.copy(position);
  const align = new THREE.Quaternion().setFromUnitVectors(up, normal);
  const spinQ = new THREE.Quaternion().setFromAxisAngle(normal, spin);
  dummy.quaternion.copy(spinQ).multiply(align);
  if (tilt !== 0) {
    const tiltAxis = new THREE.Vector3(Math.cos(tiltAxisAngle), 0, Math.sin(tiltAxisAngle))
      .applyQuaternion(dummy.quaternion)
      .normalize();
    const tiltQ = new THREE.Quaternion().setFromAxisAngle(tiltAxis, tilt);
    dummy.quaternion.premultiply(tiltQ);
  }
}

// Live foliage color for the automatic season cycle: local winter fades
// chlorophyll toward autumn yellow-orange then a light frost, strongest at
// high latitude and fading to nothing at the equator (real tropical growth
// barely changes with the seasons) regardless of season phase. Applied to
// every plant-colored material (never the mineral/rock/bark ones) as a
// vertex+fragment shader tint — no texture rebake, no CPU work, the same
// onBeforeCompile pattern already used for the ocean's live wave motion in
// main.ts. seasonUniforms is one shared object so every material picks up
// main.ts's single per-frame update automatically.
function applySeasonalFoliageTint(
  material: THREE.MeshStandardMaterial,
  seasonUniforms: { uSeasonTilt: { value: number } },
) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSeasonTilt = seasonUniforms.uSeasonTilt;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vSeasonLat;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        // the instance's own placement on the sphere, not the local blade/
        // leaf geometry around it — instanceMatrix's translation column is
        // this instance's ground point, and every one of these materials is
        // only ever drawn via InstancedMesh
        vSeasonLat = normalize((instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz).y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSeasonTilt;\nvarying float vSeasonLat;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float seasonalFactor = uSeasonTilt * vSeasonLat;
          float fade = clamp(-seasonalFactor, 0.0, 1.0);
          vec3 autumnTint = vec3(0.62, 0.42, 0.12);
          vec3 frostTint = vec3(0.75, 0.8, 0.82);
          vec3 seasoned = mix(diffuseColor.rgb, autumnTint, smoothstep(0.0, 0.55, fade));
          seasoned = mix(seasoned, frostTint, smoothstep(0.55, 1.0, fade));
          diffuseColor.rgb = mix(diffuseColor.rgb, seasoned, smoothstep(0.15, 0.7, abs(vSeasonLat)));
        }`,
      );
  };
}

export function buildSpecies(
  radius: number,
  bumpHeight: number,
  seasonUniforms: { uSeasonTilt: { value: number } },
): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(515151);

  // One hash per layer — they keep the spacing each one was tuned at
  // (ground cover packs far tighter than a stand of trees), but they all
  // now draw from the same walk of the sphere below.
  const coreMinSpacing = 0.05;
  const coreMinSpacingSq = coreMinSpacing * coreMinSpacing;
  const coreHash = new SpatialHash(coreMinSpacing);
  const placements: Placement[] = [];

  interface GroundPoint {
    dir: THREE.Vector3;
    height: number;
  }
  interface ScatterPoint extends GroundPoint {
    kind: 'tree' | 'rock';
  }

  const forestMinSpacing = 0.02;
  const forestMinSpacingSq = forestMinSpacing * forestMinSpacing;
  const forestHash = new SpatialHash(forestMinSpacing);
  const forestPoints: GroundPoint[] = [];

  const grassMinSpacing = 0.028;
  const grassMinSpacingSq = grassMinSpacing * grassMinSpacing;
  const grassHash = new SpatialHash(grassMinSpacing);
  const grassPoints: GroundPoint[] = [];

  // savanna trees and mountain rocks share one hash, as they did before —
  // they never occur in the same place, so nothing is lost keeping them
  // out of each other's way with a single spacing.
  const pointsMinSpacing = 0.115;
  const pointsMinSpacingSq = pointsMinSpacing * pointsMinSpacing;
  const pointsHash = new SpatialHash(pointsMinSpacing);
  const points: ScatterPoint[] = [];

  const screeMinSpacing = 0.03;
  const screeMinSpacingSq = screeMinSpacing * screeMinSpacing;
  const screeHash = new SpatialHash(screeMinSpacing);
  const screePoints: GroundPoint[] = [];

  const dir = new THREE.Vector3();

  // Sized to the old forest pass's own candidate count (340,000) — the
  // densest of the five sweeps this replaces, and now the only sweep
  // there is. Every layer below tests the same stream independently
  // (no layer consumes a candidate the others wanted), so each ends up
  // sampled at least as well as it was from its own dedicated sweep,
  // for roughly half the combined candidate count the five sweeps used.
  //
  // Was cut hard chasing a crash on a real device that turned out to be
  // caused by shadow mapping specifically, not by scene weight (see
  // SETTINGS in main.ts and renderer.shadowMap.enabled in main.ts) —
  // restored most of the way back now that shadows are off there instead.
  const CANDIDATES = 300000;

  for (let i = 0; i < CANDIDATES; i++) {
    const z = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    dir.set(r * Math.cos(t), z, r * Math.sin(t));

    const s = sampleAt(dir);

    // ---- fourteen-species classification ----
    const species = classify(s, rand);
    if (species && !coreHash.hasNeighborWithin(dir, coreMinSpacingSq)) {
      const point = dir.clone();
      coreHash.add(point);
      placements.push({ dir: point, height: s.height, species });
    }

    if (s.underwater) continue; // nothing below covers open water

    // ---- forest canopy: a dense, clumped, overlapping mass ----
    if (
      s.height >= SEA_LEVEL + 0.02 &&
      s.elevation <= 0.15 &&
      s.temperature >= COLD_TEMPERATURE_LIMIT &&
      s.badlands <= BADLANDS_THRESHOLD &&
      s.arid <= FOREST_ARIDITY_MAX
    ) {
      // Two scales of clumping: a broad field decides which regions are
      // wooded at all, a finer one breaks up the margins within them —
      // see the header comment for why a single field gave an even
      // stipple instead of real closed-forest/open-plain contrast.
      const region = fbm3(dir.x * 2.6 + 404, dir.y * 2.6 + 404, dir.z * 2.6 + 404, 2);
      const patch = fbm3(dir.x * 9 + 77, dir.y * 9 + 77, dir.z * 9 + 77, 2);
      const density = smoothstep(region, -0.22, 0.02) * (1.15 + patch * 1.5);
      if (rand() < density && !forestHash.hasNeighborWithin(dir, forestMinSpacingSq)) {
        const point = dir.clone();
        forestHash.add(point);
        forestPoints.push({ dir: point, height: s.height });
      }
    }

    // ---- grass: dense tiny tufts covering the (non-desert, non-forest) ground ----
    if (
      s.height >= SEA_LEVEL + 0.012 &&
      s.elevation <= 0.16 &&
      s.temperature >= COLD_TEMPERATURE_LIMIT &&
      s.badlands <= BADLANDS_THRESHOLD &&
      s.arid <= DESERT_ARIDITY_THRESHOLD &&
      s.arid > FOREST_ARIDITY_MAX // forest floor is covered by canopy instead
    ) {
      if (rand() < clumpDensity(dir, 199) && !grassHash.hasNeighborWithin(dir, grassMinSpacingSq)) {
        const point = dir.clone();
        grassHash.add(point);
        grassPoints.push({ dir: point, height: s.height });
      }
    }

    // ---- savanna trees / mountain rocks ----
    if (s.height >= SEA_LEVEL + 0.015) {
      if (s.elevation < 0.15) {
        if (
          s.temperature >= COLD_TEMPERATURE_LIMIT &&
          s.badlands <= BADLANDS_THRESHOLD &&
          s.arid <= DESERT_ARIDITY_THRESHOLD &&
          s.arid > FOREST_ARIDITY_MAX // savanna band only; forest/desert get their own treatment
        ) {
          if (rand() < clumpDensity(dir, 163) && !pointsHash.hasNeighborWithin(dir, pointsMinSpacingSq)) {
            const point = dir.clone();
            pointsHash.add(point);
            points.push({ dir: point, height: s.height, kind: 'tree' });
          }
        }
      } else if (s.snow <= 0.35) {
        // Snow buries loose rock; strewing dark boulders across a white
        // field reads as pepper spilled on it.
        if (rand() < clumpDensity(dir, 179) && !pointsHash.hasNeighborWithin(dir, pointsMinSpacingSq)) {
          const point = dir.clone();
          pointsHash.add(point);
          points.push({ dir: point, height: s.height, kind: 'rock' });
        }
      }
    }

    // ---- scree: loose rubble covering rocky/mountain slopes ----
    if (s.elevation >= 0.15 && s.snow <= 0.35) {
      if (rand() < clumpDensity(dir, 191) && !screeHash.hasNeighborWithin(dir, screeMinSpacingSq)) {
        const point = dir.clone();
        screeHash.add(point);
        screePoints.push({ dir: point, height: s.height });
      }
    }
  }

  // ======================================================================
  // Build meshes
  // ======================================================================

  // ---- fourteen species: two shared materials, one InstancedMesh each ----

  const plantMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.93,
    envMapIntensity: 0.1,
  });
  applySeasonalFoliageTint(plantMaterial, seasonUniforms);
  const mineralMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.85,
    flatShading: true,
    envMapIntensity: 0.14,
  });

  const bySpecies = new Map<Species, Placement[]>();
  placements.forEach((p) => {
    const list = bySpecies.get(p.species);
    if (list) list.push(p);
    else bySpecies.set(p.species, [p]);
  });

  const color = new THREE.Color();
  bySpecies.forEach((list, species) => {
    const geometry = buildModel(species, rand);
    const material = MINERAL.has(species) ? mineralMaterial : plantMaterial;
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);

    list.forEach((p, i) => {
      // Floating species sit at sea level; everything else stands on the
      // ground, sunk slightly so it does not read as placed on top of it.
      const floats = p.species === 'iceFloe' || p.species === 'mangrove';
      const surface = floats
        ? radius + (SEA_LEVEL - 0.015) * bumpHeight
        : radius + sampledHeight(p.dir).display * bumpHeight - 0.004;
      dummy.position.copy(p.dir).multiplyScalar(surface);
      const align = new THREE.Quaternion().setFromUnitVectors(up, p.dir);
      const spin = new THREE.Quaternion().setFromAxisAngle(p.dir, rand() * Math.PI * 2);
      dummy.quaternion.copy(spin).multiply(align);
      const sc = 0.85 + rand() * rand() * 1.25;
      dummy.scale.set(sc, sc * (0.85 + rand() * 0.4), sc);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const temperature = temperatureAt(p.dir, terracedElevation(p.height));
      speciesColor(species, temperature, color);
      color.offsetHSL(0, (rand() - 0.5) * 0.05, (rand() - 0.5) * 0.09);
      mesh.setColorAt(i, color);
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  });

  // ---- savanna trees: 3 archetypes mixed by pseudo-climate + chance ----
  // (a tall pointy cone looked fine from directly above, but at the
  // sphere's silhouette edge — where we're looking almost along the
  // surface — a ring of them stands straight out sideways into a comical
  // "spike wall". Short + rounded keeps the grazing-angle silhouette calm.)

  const trees = points.filter((p) => p.kind === 'tree');
  const rocks = points.filter((p) => p.kind === 'rock');

  const TRUNK_H = 0.014;

  const bushGeometry = new THREE.IcosahedronGeometry(0.02, 1);
  bushGeometry.scale(1, 0.72, 1);
  bushGeometry.translate(0, TRUNK_H + 0.02 * 0.55, 0);

  const coniferGeometry = new THREE.ConeGeometry(0.016, 0.05, 6);
  coniferGeometry.translate(0, TRUNK_H + 0.05 / 2 - 0.008, 0);

  const clumpGeometry = mergeGeometries(
    [
      (() => {
        const g = new THREE.IcosahedronGeometry(0.015, 1);
        g.translate(-0.011, TRUNK_H + 0.013, 0.004);
        return g;
      })(),
      (() => {
        const g = new THREE.IcosahedronGeometry(0.017, 1);
        g.translate(0.01, TRUNK_H + 0.016, -0.006);
        return g;
      })(),
    ],
    false,
  );

  const trunkGeometry = new THREE.CylinderGeometry(0.004, 0.006, TRUNK_H, 5);
  trunkGeometry.translate(0, TRUNK_H / 2, 0);

  const trunkMaterial = new THREE.MeshStandardMaterial({
    color: '#8a5a3a',
    roughness: 0.95,
    envMapIntensity: 0.1,
  });
  // left white on purpose — instanceColor below multiplies against this,
  // so a tinted base color here would compound with (and mute/darken) the
  // per-instance hue instead of showing it cleanly
  const foliageMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.9,
    envMapIntensity: 0.1,
  });
  applySeasonalFoliageTint(foliageMaterial, seasonUniforms);

  // real diorama foliage ("clump foliage" flock/lichen material) is a
  // distinctly bright, saturated yellow-green — noticeably more lime than
  // an ordinary tree green, and part of what makes a miniature's
  // vegetation read as a real physical material instead of rendered grass
  const treeVariants: { geometry: THREE.BufferGeometry; hue: [number, number] }[] = [
    { geometry: bushGeometry, hue: [0.235, 0.045] },
    { geometry: coniferGeometry, hue: [0.28, 0.025] },
    { geometry: clumpGeometry, hue: [0.225, 0.04] },
  ];
  const treeByVariant: GroundPoint[][] = treeVariants.map(() => []);
  trees.forEach((p) => {
    const coolness = Math.abs(p.dir.y); // stand-in for latitude
    let variant = rand() < 0.35 ? 2 : 0; // base mix: bush or clump
    if (rand() < coolness * 0.8 + 0.05) variant = 1; // conifers lean polar
    treeByVariant[variant].push(p);
  });

  const trunkMesh = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, trees.length);
  let trunkIndex = 0;
  // Note on the `THREE.SRGBColorSpace` argument passed to every setHSL
  // below: three's working color space is linear-sRGB, so setHSL's default
  // treats the lightness/saturation you give it as *linear* values. Naming
  // sRGB explicitly makes the numbers mean what they look like in a color
  // picker instead of coming out as glowing neon lime.
  const foliageColor = new THREE.Color();

  treeVariants.forEach((variant, vi) => {
    const pts = treeByVariant[vi];
    if (pts.length === 0) return;
    const foliageMesh = new THREE.InstancedMesh(variant.geometry, foliageMaterial, pts.length);
    pts.forEach((p, i) => {
      const surfaceRadius = radius + sampledHeight(p.dir).display * bumpHeight;
      const position = p.dir.clone().multiplyScalar(surfaceRadius);
      const scale = 0.42 + rand() * 0.45;
      orient(position, p.dir, rand() * Math.PI * 2);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      trunkMesh.setMatrixAt(trunkIndex++, dummy.matrix);
      foliageMesh.setMatrixAt(i, dummy.matrix);
      // a little per-tree color variance so a forest doesn't look like one
      // flat-shaded cutout repeated hundreds of times
      foliageColor.setHSL(variant.hue[0] + rand() * variant.hue[1], 0.48 + rand() * 0.14, 0.26 + rand() * 0.12, THREE.SRGBColorSpace);
      foliageMesh.setColorAt(i, foliageColor);
    });
    foliageMesh.instanceMatrix.needsUpdate = true;
    if (foliageMesh.instanceColor) foliageMesh.instanceColor.needsUpdate = true;
    group.add(foliageMesh);
  });
  trunkMesh.instanceMatrix.needsUpdate = true;
  group.add(trunkMesh);

  // ---- mountain rocks: 2 archetypes — angular boulders + flatter slabs ----

  const boulderGeometry = new THREE.IcosahedronGeometry(0.026, 0);
  const slabGeometry = new THREE.IcosahedronGeometry(0.028, 0);
  slabGeometry.scale(1.15, 0.6, 1.0);

  const rockMaterial = new THREE.MeshStandardMaterial({
    // white on purpose: instanceColor multiplies against this, so a tinted
    // base here compounds with the per-instance color and darkens it.
    color: '#ffffff',
    roughness: 0.95,
    flatShading: true,
    envMapIntensity: 0.1,
  });

  const rockVariants = [boulderGeometry, slabGeometry];
  const rockByVariant: GroundPoint[][] = rockVariants.map(() => []);
  rocks.forEach((p) => rockByVariant[rand() < 0.4 ? 1 : 0].push(p));
  const rockColor = new THREE.Color();

  rockVariants.forEach((geo, vi) => {
    const pts = rockByVariant[vi];
    if (pts.length === 0) return;
    const rockMesh = new THREE.InstancedMesh(geo, rockMaterial, pts.length);
    pts.forEach((p, i) => {
      // Sunk, not set down — a rock resting *on* smooth ground reads as a
      // separate object dropped there. Real outcrops emerge from the
      // ground, so bury most of each one and let only its crown break
      // the surface.
      const surfaceRadius = radius + sampledHeight(p.dir).display * bumpHeight - 0.016;
      const position = p.dir.clone().multiplyScalar(surfaceRadius);
      orient(position, p.dir, rand() * Math.PI * 2, (rand() - 0.5) * 0.7, rand() * Math.PI * 2);
      dummy.scale.set(0.5 + rand() * 1.0, 0.4 + rand() * 0.5, 0.5 + rand() * 1.0);
      dummy.updateMatrix();
      rockMesh.setMatrixAt(i, dummy.matrix);
      rockColor.setHSL(0.08 + rand() * 0.03, 0.13 + rand() * 0.06, 0.36 + rand() * 0.1, THREE.SRGBColorSpace);
      rockMesh.setColorAt(i, rockColor);
    });
    rockMesh.instanceMatrix.needsUpdate = true;
    if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true;
    group.add(rockMesh);
  });

  // ---- scree: dense loose rubble covering rocky/mountain slopes ----

  const screeGeometry = new THREE.IcosahedronGeometry(0.016, 0);
  const screeMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.97,
    flatShading: true,
    envMapIntensity: 0.08,
  });
  const screeMesh = new THREE.InstancedMesh(screeGeometry, screeMaterial, screePoints.length);
  const screeColor = new THREE.Color();
  screePoints.forEach((p, i) => {
    const surfaceRadius = radius + sampledHeight(p.dir).display * bumpHeight - 0.007;
    const position = p.dir.clone().multiplyScalar(surfaceRadius);
    orient(position, p.dir, rand() * Math.PI * 2, (rand() - 0.5) * 0.5, rand() * Math.PI * 2);
    dummy.scale.set(0.6 + rand() * 1.0, 0.5 + rand() * 0.7, 0.6 + rand() * 1.0);
    dummy.updateMatrix();
    screeMesh.setMatrixAt(i, dummy.matrix);
    screeColor.setHSL(0.075 + rand() * 0.03, 0.14 + rand() * 0.06, 0.32 + rand() * 0.1, THREE.SRGBColorSpace);
    screeMesh.setColorAt(i, screeColor);
  });
  screeMesh.instanceMatrix.needsUpdate = true;
  if (screeMesh.instanceColor) screeMesh.instanceColor.needsUpdate = true;
  group.add(screeMesh);

  // ---- forest: big clumped canopy masses, not a solid blanket ----
  // A real diorama's foliage clumps are substantial individual masses
  // with visible bare rock between and around them. Two tessellations,
  // chosen per clump by how big it is: a clump's faces only become
  // visible when it covers enough pixels for one triangle to be several
  // across, and the scale distribution has a long tail — most clumps are
  // small, a few are several times their neighbours. Giving every clump
  // enough vertices to satisfy the largest was what made foliage seventy
  // percent of the frame; giving them all the cheap one leaves the big
  // ones reading as chips of green glass. Spend the triangles only where
  // they can be seen.
  const CANOPY_FINE_SCALE = 1.1;
  const canopyVariantCount = 3;
  const coarseVariants = Array.from({ length: canopyVariantCount }, () => buildCanopyBlob(rand, 1));
  const fineVariants = Array.from({ length: 2 }, () => buildCanopyBlob(rand, 2));
  const canopyMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.92,
    envMapIntensity: 0.1,
  });
  applySeasonalFoliageTint(canopyMaterial, seasonUniforms);

  interface CanopyInstance {
    point: GroundPoint;
    scale: number;
  }
  const coarseBuckets: CanopyInstance[][] = Array.from({ length: canopyVariantCount }, () => []);
  const fineBuckets: CanopyInstance[][] = Array.from({ length: 2 }, () => []);

  forestPoints.forEach((point, i) => {
    // Measured, a flat range put the middle half of all clumps between 0.66
    // and 1.17 — a third either side of the median, which the eye cannot
    // tell from a single size. Squaring gives the long tail real applied
    // flock has: mostly small stuff, with occasional masses several times
    // the size of their neighbours.
    const r0 = rand();
    const scale = 0.45 + r0 * r0 * 1.9;
    const instance = { point, scale };
    if (scale >= CANOPY_FINE_SCALE) fineBuckets[i % 2].push(instance);
    else coarseBuckets[i % canopyVariantCount].push(instance);
  });

  const canopyColor = new THREE.Color();
  const placeCanopy = (variants: THREE.BufferGeometry[], buckets: CanopyInstance[][]) => {
    buckets.forEach((list, vi) => {
      if (list.length === 0) return;
      const mesh = new THREE.InstancedMesh(variants[vi], canopyMaterial, list.length);
      list.forEach(({ point, scale }, i) => {
        const surfaceRadius = radius + sampledHeight(point.dir).display * bumpHeight;
        const position = point.dir.clone().multiplyScalar(surfaceRadius);
        orient(position, point.dir, rand() * Math.PI * 2);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        // Foliage colour follows the climate it grows in, not one palette
        // sprayed over the whole planet — a jungle, a temperate wood and a
        // taiga are three different greens. The lightness spread on top is
        // per-clump light and shade.
        const climate = canopyClimate(point.dir, terracedElevation(point.height));
        canopyColor.setHSL(
          climate.hue + rand() * 0.03,
          climate.saturation + rand() * 0.12,
          climate.lightness + rand() * 0.11,
          THREE.SRGBColorSpace,
        );
        mesh.setColorAt(i, canopyColor);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      group.add(mesh);
    });
  };
  placeCanopy(coarseVariants, coarseBuckets);
  placeCanopy(fineVariants, fineBuckets);

  // ---- grass: dense tiny tufts covering the (non-desert) ground ----

  const grassGeometry = new THREE.ConeGeometry(0.008, 0.016, 5);
  grassGeometry.translate(0, 0.008, 0);
  const grassMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.9,
    envMapIntensity: 0.08,
  });
  applySeasonalFoliageTint(grassMaterial, seasonUniforms);
  const grassMesh = new THREE.InstancedMesh(grassGeometry, grassMaterial, grassPoints.length);
  const grassColor = new THREE.Color();
  grassPoints.forEach((p, i) => {
    const surfaceRadius = radius + sampledHeight(p.dir).display * bumpHeight;
    const position = p.dir.clone().multiplyScalar(surfaceRadius);
    orient(position, p.dir, rand() * Math.PI * 2);
    dummy.scale.set(0.7 + rand() * 0.9, 0.5 + rand() * 1.0, 0.7 + rand() * 0.9);
    dummy.updateMatrix();
    grassMesh.setMatrixAt(i, dummy.matrix);
    const gc = canopyClimate(p.dir, terracedElevation(p.height));
    grassColor.setHSL(
      gc.hue + rand() * 0.03,
      gc.saturation * 0.92 + rand() * 0.1,
      gc.lightness * 0.92 + rand() * 0.08,
      THREE.SRGBColorSpace,
    );
    grassMesh.setColorAt(i, grassColor);
  });
  grassMesh.instanceMatrix.needsUpdate = true;
  if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;
  group.add(grassMesh);

  return group;
}
