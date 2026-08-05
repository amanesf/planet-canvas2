import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  aridityAt,
  badlandsAt,
  BADLANDS_THRESHOLD,
  climateFactsAt,
  DESERT_ARIDITY_THRESHOLD,
  orogenyBeltAt,
  sampledHeight,
  SEA_LEVEL,
  snowinessAt,
  canopyAt,
  temperatureAt,
  terracedElevation,
  urbanAt,
  type ClimateGroup,
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
  | 'cypress'
  | 'broadleaf'
  | 'acacia'
  | 'palm'
  | 'deadTree'
  | 'bamboo'
  | 'mangrove'
  | 'shrub'
  | 'tussock'
  | 'cactus'
  | 'desertScrub'
  | 'dune'
  | 'butte'
  | 'seaStack'
  | 'iceFloe'
  | 'glacier'
  | 'snowDrift'
  | 'geyser';

/** Whether a species is planted (tinted green-ish) or mineral. */
const MINERAL: ReadonlySet<Species> = new Set<Species>([
  'dune',
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
  /** how much closed forest the real climate map puts here, 0..1 */
  canopy: number;
  /** and whether that forest is conifer */
  coniferous: boolean;
  /** the Köppen group itself — what decides which species stand here */
  group: ClimateGroup;
  underwater: boolean;
  shelfDepth: number;
}

/**
 * Everything every layer wants to know about a candidate, or null if there
 * is nothing any of them could put there.
 *
 * The early return is worth more than it looks. Roughly seven candidates in
 * ten land on open ocean deeper than the shelf, where nothing is ever
 * placed — and each one was paying for a climate-raster probe, four baked
 * field lookups and a snow computation before anything got round to
 * discarding it. Height alone answers the question, and height is the one
 * field that is a single array read.
 */
function sampleAt(dir: THREE.Vector3): Sample | null {
  const height = sampledHeight(dir).raw;
  const shelfDepth = SEA_LEVEL - height;
  if (shelfDepth > 0.045) return null;

  const elevation = terracedElevation(height);
  const { group, coniferous } = climateFactsAt(dir);
  return {
    dir,
    height,
    elevation,
    temperature: temperatureAt(dir, elevation),
    snow: snowinessAt(dir, height),
    arid: aridityAt(dir),
    belt: orogenyBeltAt(dir),
    badlands: badlandsAt(dir),
    canopy: canopyAt(dir),
    coniferous,
    group,
    underwater: height < SEA_LEVEL,
    shelfDepth,
  };
}

/**
 * What belongs at this point, or null for bare ground.
 *
 * Which species stands here is the Köppen group's call. It used to be a
 * ladder of temperature and aridity thresholds, which is a reasonable way
 * to guess a biome when you have no biome data — but the classification is
 * *already* the biome, hand-drawn from a century of station records, and
 * reconstructing it badly out of two scalars threw that away. Concretely,
 * a threshold ladder cannot tell an Aw savanna from a Cfa oak wood (same
 * temperature, similar aridity), nor a Cs Mediterranean hillside from a
 * Cfb oceanic one, so both pairs came out as the same generic shrub. The
 * groups separate them by construction.
 *
 * Within a group the order still runs from the most specific habitat to
 * the least, so that (say) a mangrove coast is not first claimed by the
 * generic tropical case. Each acceptance chance is gated by `clumpDensity`
 * with a seed of its own, so one species' clusters don't line up with
 * another's.
 */
function classify(s: Sample, rand: () => number): Species | null {
  const { dir, elevation, temperature, snow, belt, badlands, group, underwater, shelfDepth } = s;

  if (underwater) {
    // Only the shallow shelf holds anything; anything deeper never reaches
    // here, sampleAt having already discarded it.
    if (temperature < 0.06) return rand() < 0.55 * clumpDensity(dir, 11) ? 'iceFloe' : null;
    if (temperature > 0.62 && shelfDepth < 0.02) return rand() < 0.5 * clumpDensity(dir, 23) ? 'mangrove' : null;
    // rock left standing where a cliffed coast has been cut back
    if (belt > 0.2 && shelfDepth < 0.03) return rand() < 0.35 * clumpDensity(dir, 37) ? 'seaStack' : null;
    return null;
  }

  // Frozen ground: ice and drifts, nothing that grows. This and the two
  // tests after it are landform, not climate — an ice cap, a volcano and a
  // canyon each override whatever the classification says grows nearby.
  if (snow > 0.5 || group === 'EF') {
    if (elevation > 0.2 && belt > 0.25) return rand() < 0.4 * clumpDensity(dir, 41) ? 'glacier' : null;
    return rand() < 0.3 * clumpDensity(dir, 53) ? 'snowDrift' : null;
  }

  // Volcanic country vents steam.
  if (belt > 0.55 && elevation > 0.16 && rand() < 0.06 * clumpDensity(dir, 61)) return 'geyser';

  // Mesas stand where the real badlands are (see KOPPEN_BADLANDS in
  // terrain.ts) — which is inside the dry classes and nowhere else, rather
  // than wherever a global noise blob happened to peak. A chance, not a
  // branch: badlands country is still desert, so what a candidate is not
  // claimed by here falls through to its group below and gets sand or
  // scrub. Making it terminal is what left the Sahara a field of mesas
  // with not one dune in it.
  if (badlands > BADLANDS_THRESHOLD + 0.04 && rand() < 0.22 * clumpDensity(dir, 71)) return 'butte';

  // Above the tree line: standing deadwood, whatever the climate below is.
  if (elevation > 0.15) return rand() < 0.18 * clumpDensity(dir, 101) ? 'deadTree' : null;

  switch (group) {
    // --- A: tropical ---
    case 'Af':
    case 'Am': {
      // everwet: palms along the shore, then broadleaf with bamboo through
      // the understorey. The forest canopy layer supplies the mass; these
      // are the individual crowns that break its outline.
      if (elevation < 0.02 && rand() < 0.42 * clumpDensity(dir, 113)) return 'palm';
      if (rand() >= 0.55 * clumpDensity(dir, 127)) return null;
      return rand() < 0.3 ? 'bamboo' : 'broadleaf';
    }
    case 'Aw': {
      // savanna: the flat-topped acacia is the whole signature of the
      // biome — a single silhouette that says "Serengeti" at a glance.
      if (rand() >= 0.5 * clumpDensity(dir, 163)) return null;
      return rand() < 0.85 ? 'acacia' : 'deadTree';
    }

    // --- B: dry ---
    case 'BW': {
      // sand desert: dunes are the landform, succulents only at the warm
      // margins where there is any moisture at all
      if (rand() < 0.3 * clumpDensity(dir, 167)) return 'dune';
      if (temperature > 0.55 && rand() < 0.1 * clumpDensity(dir, 83)) return 'cactus';
      return null;
    }
    case 'BS': {
      // steppe: low scrub, thicker than true desert but nothing like a wood
      if (rand() >= 0.5 * clumpDensity(dir, 97)) return null;
      if (temperature > 0.6) return rand() < 0.35 ? 'cactus' : 'desertScrub';
      return rand() < 0.4 ? 'shrub' : 'desertScrub';
    }

    // --- C: temperate ---
    case 'Cs': {
      // Mediterranean: cypress spires over dry maquis scrub. The cypress
      // is doing the same job for southern Europe that the acacia does for
      // the savanna and the spruce for the taiga.
      if (rand() >= 0.55 * clumpDensity(dir, 131)) return null;
      return rand() < 0.45 ? 'cypress' : 'shrub';
    }
    case 'Cw': {
      // monsoon-temperate (south China, the Indian foothills): broadleaf
      // with real bamboo stands in it
      if (rand() >= 0.55 * clumpDensity(dir, 137)) return null;
      return rand() < 0.4 ? 'bamboo' : 'broadleaf';
    }
    case 'Cf': {
      // oceanic/humid-subtropical: mixed broadleaf wood with shrub between
      if (rand() >= 0.6 * clumpDensity(dir, 139)) return null;
      return rand() < 0.7 ? 'broadleaf' : 'shrub';
    }

    // --- D: continental ---
    case 'Ds': {
      // dry-summer continental — the interior west: open conifer stands
      // over sage, and deadwood where it burns
      if (rand() >= 0.5 * clumpDensity(dir, 149)) return null;
      const roll = rand();
      return roll < 0.5 ? 'conifer' : roll < 0.85 ? 'shrub' : 'deadTree';
    }
    case 'Dw':
    case 'Df': {
      // the boreal belt: spruce, and the single most recognisable
      // vegetation silhouette on the planet
      if (rand() >= 0.7 * clumpDensity(dir, 151)) return null;
      return rand() < 0.88 ? 'conifer' : 'deadTree';
    }

    // --- E: polar ---
    case 'ET': {
      // tundra: no trees at all, tussock grass and lichen over frozen
      // ground, with drifts where the snow catches
      if (rand() >= 0.6 * clumpDensity(dir, 157)) return null;
      return rand() < 0.78 ? 'tussock' : 'snowDrift';
    }

    // Only reachable on ground the climate raster calls sea — a strip of
    // pixels along coastlines where the two datasets disagree. Generic
    // scrub is the safe answer; it is never a large area.
    case 'none':
    default:
      return rand() < 0.35 * clumpDensity(dir, 173) ? 'shrub' : null;
  }
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
    case 'cypress': {
      // narrower and taller than anything else that grows — the Tuscan
      // exclamation mark. Distinguishable from the conifer spire beside it
      // only by proportion, which is exactly how it works in life.
      parts.push(column(0.005, 0.004, 0.016, 0, 5));
      const body = new THREE.CylinderGeometry(0.002, 0.011, 0.062, 6);
      body.translate(0, 0.045, 0);
      parts.push(body);
      break;
    }
    case 'broadleaf': {
      // trunk plus one wide domed crown: the default "tree" silhouette,
      // and the thing the temperate and tropical woods were missing —
      // every individual tree on the planet was previously a spire.
      parts.push(column(0.007, 0.005, 0.022, 0, 5));
      // A sphere, not an icosahedron, purely so it can be merged with the
      // cylinder above: mergeGeometries returns null (and the caller then
      // throws on it) if some of its inputs are indexed and some are not,
      // and IcosahedronGeometry is the one primitive here that is not.
      const crown = new THREE.SphereGeometry(0.03, 7, 5);
      displaceWithNoise(crown, 0.22, 3.5, rand() * 500);
      crown.scale(1.15, 0.82, 1.15);
      crown.translate(0, 0.042, 0);
      parts.push(crown);
      break;
    }
    case 'acacia': {
      // the flat-topped umbrella. One silhouette, and it says Serengeti
      // with no other cue at all — which is the whole reason the savanna
      // needs a species of its own rather than a shrub.
      const trunk = column(0.006, 0.003, 0.03, 0, 5);
      trunk.rotateZ(0.07);
      parts.push(trunk);
      const canopyDisc = new THREE.CylinderGeometry(0.036, 0.022, 0.012, 8);
      displaceWithNoise(canopyDisc, 0.16, 5, rand() * 500);
      canopyDisc.translate(0, 0.034, 0);
      parts.push(canopyDisc);
      break;
    }
    case 'tussock': {
      // tundra: no woody stem anywhere, just a low hummock of blades over
      // frozen ground
      for (let i = 0; i < 5; i++) {
        const blade = new THREE.ConeGeometry(0.005, 0.016 + rand() * 0.008, 4);
        blade.translate(0, 0.008, 0);
        blade.rotateZ((rand() - 0.5) * 0.8);
        blade.rotateY(rand() * Math.PI * 2);
        blade.translate((rand() - 0.5) * 0.02, 0, (rand() - 0.5) * 0.02);
        parts.push(blade);
      }
      break;
    }
    case 'dune': {
      // A dune is a ridge, not a lump.
      //
      // This used to be a sphere scaled to (1.5, 0.18, 0.55). An ellipsoid
      // squashed that way is a lens: from above it comes to a sharp point
      // at both ends, and it stops in mid-air there rather than going
      // anywhere. At the size these are actually drawn, every single one
      // read as an almond lying on the sand instead of reading as sand —
      // which is the same failure as the old field-of-mesas Sahara, just
      // with a rounder mesa.
      //
      // What makes an erg look like an erg is not the individual mound. It
      // is that the mounds are long, that they all run the same way (see
      // duneBearing at the placement loop), and that they sink back into
      // the ground at their ends. Only the last of those is geometry.
      const g = new THREE.SphereGeometry(0.05, 14, 8);
      // Gentle: sand is a smooth material. The noise amplitude that reads
      // as "weathered rock" on a butte reads as "gravel" here.
      displaceWithNoise(g, 0.09, 3.4, rand() * 500);

      const CREST = 0.095; // half-length of the ridge along its crest line
      const pos = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) * 1.9;
        let y = pos.getY(i);
        let z = pos.getZ(i) * 0.7;
        // Flatten the underside. Only the half above the ground is ever
        // seen, and carrying a buried lower hemisphere is what forced the
        // whole shape to be so thin in the first place.
        y = Math.max(y, 0) * 0.3;
        // The slip face. A dune is not symmetric — the windward side
        // climbs gently and the lee side drops at the angle of repose, and
        // that asymmetry is most of what says "wind put this here" rather
        // than "something was dropped here".
        if (z > 0) z *= 0.55;
        // Taper the crest down into the sand at both ends instead of
        // leaving it hanging, which is what made the outline an almond.
        const along = Math.min(1, Math.abs(x) / CREST);
        y *= 1 - along * along;
        pos.setXYZ(i, x, y, z);
      }
      pos.needsUpdate = true;
      parts.push(g);
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

/**
 * The compass bearing a dune's crest runs along at this point, in radians.
 *
 * Deliberately very low frequency: the whole point is that neighbouring
 * dunes agree, so the field sweeps across the erg the way wind-built sand
 * actually does. It still turns slowly across a desert the size of the
 * Sahara, which keeps the far side of one from looking like a copy of the
 * near side.
 */
function duneBearing(dir: THREE.Vector3): number {
  return fbm3(dir.x * 1.6 + 71, dir.y * 1.6 + 71, dir.z * 1.6 + 71, 2) * Math.PI * 2;
}

/** Base colour for a species, before the per-instance jitter. */
function speciesColor(species: Species, temperature: number, out: THREE.Color): THREE.Color {
  switch (species) {
    case 'conifer':
      return out.setHSL(0.31, 0.44, 0.24, THREE.SRGBColorSpace);
    case 'cypress':
      // the darkest green on the planet, which is most of why a cypress
      // reads as a cypress
      return out.setHSL(0.33, 0.5, 0.17, THREE.SRGBColorSpace);
    case 'broadleaf':
      return out.setHSL(0.24, 0.52, 0.3, THREE.SRGBColorSpace);
    case 'acacia':
      // dry-season savanna foliage is yellow-green, not leaf green
      return out.setHSL(0.17, 0.44, 0.36, THREE.SRGBColorSpace);
    case 'tussock':
      return out.setHSL(0.13, 0.28, 0.38, THREE.SRGBColorSpace);
    case 'dune':
      return out.setHSL(0.11, 0.38, 0.66, THREE.SRGBColorSpace);
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

// Below this temperature it's tundra/ice country — too cold for forest,
// savanna, or desert dressing; those zones stay bare (the paint itself
// already reads as tundra/ice, see terrain.ts's biomeColor). Lowered from
// the original 0.09: with dir now real latitude (not fictional noise),
// that cutoff excluded most of the real boreal forest belt (Canada,
// Siberia) as "too cold" — real taiga covers most of that band, with true
// treeless tundra confined to a narrower strip right at the Arctic coast.
const COLD_TEMPERATURE_LIMIT = 0.02;

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

  // One hash per layer. Every spacing here is roughly a third of what it
  // was, and every model below is correspondingly smaller: the planet used
  // to carry about 2,700 pieces of vegetation in total, which sounds like a
  // lot until you divide it by the Earth. At that count each piece has to
  // be enormous — the largest forest clumps spanned some three degrees of
  // arc — to add up to anything that reads as green, and the difference
  // between the Amazon and Alberta drowns in the sampling noise of a few
  // dozen items. Smaller and roughly ten times as many reads as applied
  // flock rather than as scattered props, and makes regional density a
  // quantity you can actually see.
  const coreMinSpacing = 0.022;
  const coreMinSpacingSq = coreMinSpacing * coreMinSpacing;
  const coreHash = new SpatialHash(coreMinSpacing);
  const placements: Placement[] = [];

  interface GroundPoint {
    dir: THREE.Vector3;
    height: number;
    /** forest only: boreal/continental climates are conifer, the rest broadleaf */
    coniferous?: boolean;
  }
  interface ScatterPoint extends GroundPoint {
    kind: 'tree' | 'rock';
  }

  // Forest spacing is the one that varies across the globe, because the
  // thing it is modelling does: a rainforest is a closed roof with no gaps
  // and a wooded steppe is individual trees you can walk between, and
  // planting both on the same lattice makes them the same place with
  // different colours. The hash's cell size is the *sparse* end, since the
  // 3x3x3 neighbourhood has to cover the largest distance ever asked for.
  // Tightened from 0.0065 when clearings went in. The two are one change:
  // carving gaps costs canopy only in the gaps, but the closed-canopy areas
  // are packing-limited rather than density-limited — they are already at
  // the spacing's ceiling, so raising density there buys nothing and the
  // planet simply lost 24% of its forest. Packing the stands tighter puts
  // that back where it belongs, which is inside the stands. Same total
  // green, more contrast between wood and clearing.
  const FOREST_SPACING_DENSE = 0.0057;
  const FOREST_SPACING_SPARSE = 0.017;
  const forestHash = new SpatialHash(FOREST_SPACING_SPARSE);
  const forestPoints: GroundPoint[] = [];

  const grassMinSpacing = 0.011;
  const grassMinSpacingSq = grassMinSpacing * grassMinSpacing;
  const grassHash = new SpatialHash(grassMinSpacing);
  const grassPoints: GroundPoint[] = [];

  // savanna trees and mountain rocks share one hash, as they did before —
  // they never occur in the same place, so nothing is lost keeping them
  // out of each other's way with a single spacing.
  const pointsMinSpacing = 0.045;
  const pointsMinSpacingSq = pointsMinSpacing * pointsMinSpacing;
  const pointsHash = new SpatialHash(pointsMinSpacing);
  const points: ScatterPoint[] = [];

  const screeMinSpacing = 0.013;
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
  //
  // Raised again with the spacings above: a Poisson-disk scatter only
  // reaches its packing limit if the candidate stream oversamples it
  // several times over, so cutting the spacings without raising this would
  // have bought a fraction of the density the smaller spacing allows.
  const CANDIDATES = 900000;

  for (let i = 0; i < CANDIDATES; i++) {
    const z = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    dir.set(r * Math.cos(t), z, r * Math.sin(t));

    const s = sampleAt(dir);
    if (!s) continue; // open ocean, deeper than the shelf: nothing goes here

    // Cities clear the ground they stand on.
    //
    // The paint layer draws a grey urban patch (terrain.ts, urbanAt) but
    // the scatter used to keep flocking trees straight through it, so Tokyo
    // and São Paulo were grey smudges with a full forest still standing on
    // top of them — which reads as a decal slid under the greenery rather
    // than as a place. Both systems now read the same field, so the paint
    // and the clearing cannot drift apart.
    //
    // Probabilistic rather than a hard radius: `urban` falls off smoothly
    // from the centre, so trees thin out through the suburbs and the last
    // few survive at the edge, instead of the city ending at a circle with
    // a wall of forest around it. Only ever draws from the random stream
    // inside a city, so the other 99% of the planet is bit-for-bit
    // unchanged by this.
    // The gain matters. `urbanAt` is tuned for *paint*, where the patch is
    // deliberately faint — a souvenir globe shows a city as a smudge, not
    // as a street map — and it only approaches 1 at the exact centre of the
    // largest cities. Clearing at that raw strength measured as a 27%
    // thinning of the core, which is not a clearing at all; the trees were
    // still standing on top of the grey. Ground cover is the opposite case
    // from paint: where a city is built, the ground is built on. Scaled up
    // until it saturates across the built-up core, measured over all 28
    // cities: trees within 0.012 rad of centre −80%, the 0.012–0.022 ring
    // −30% (the ragged edge, which is the point — a shaved circle would read
    // as a crop mark), ground beyond 0.06 rad −0.2%, whole-planet forest
    // −0.4%. Grass is thinned rather than cleared: the parks and verges
    // left behind are what keep a cleared patch from looking scorched.
    //
    // Note the patches are small — about 0.018 rad even for Tokyo — so any
    // measurement of this has to use city-sized bands. Averaged over a
    // 0.03 rad cap the effect vanishes into ground that was never urban.
    const urban = Math.min(1, urbanAt(dir) * 2.6);
    const clearedByCity = (strength: number) => strength > 0 && rand() < strength;

    // ---- fourteen-species classification ----
    const species = classify(s, rand);
    if (species && !clearedByCity(urban) && !coreHash.hasNeighborWithin(dir, coreMinSpacingSq)) {
      const point = dir.clone();
      coreHash.add(point);
      placements.push({ dir: point, height: s.height, species });
    }

    if (s.underwater) continue; // nothing below covers open water

    // There is no elevation test on any land layer below. Being above the
    // waterline (the `underwater` check above) is the whole of it.
    //
    // Each layer used to add its own margin on top — `height >= SEA_LEVEL +
    // 0.02` for forest, +0.015 for scattered trees, +0.012 for grass — left
    // over from the era when the continents were noise and "land" meant
    // "hill". Against real elevation data those are a different rule
    // entirely, because real continents are mostly flat lowland: measured,
    // the forest one alone rejected 75% of all climatically suitable ground,
    // and it rejected it in exactly the wrong places. The Amazon basin, the
    // Congo basin, the Ganges plain, the pampas and the Sahel are all low
    // and flat and all came out bare, while Alaska and Tibet, being high,
    // came out as the densest forest on the planet — the Amazon measured at
    // one thirty-fourth of Alaska's forest density, which is the exact
    // inverse of the truth. Even a margin as narrow as the painted beach
    // band (COAST_WIDTH, 0.006) is too wide: the Congo basin's own mean
    // height above sea level is 0.007.

    // ---- forest canopy: a dense, clumped, overlapping mass ----
    if (
      s.elevation <= 0.15 &&
      s.temperature >= COLD_TEMPERATURE_LIMIT &&
      s.badlands <= BADLANDS_THRESHOLD
    ) {
      // Which regions are wooded at all is no longer a noise field's
      // opinion — it is the real Köppen climate map (terrain.ts). That is
      // the difference between "somewhere around this latitude there is
      // probably forest" and the Amazon being solid canopy, the Sahara
      // having none, and the boreal belt running unbroken across Alaska,
      // Canada and Siberia. A finer noise field still breaks up the
      // margins within a wooded region, because a real forest edge is
      // ragged rather than a contour line.
      //
      // The separate `arid <= FOREST_ARIDITY_MAX` veto that used to sit
      // alongside this is gone: canopy and aridity are two readings of the
      // same climate table, so it was a second vote by the same voter, and
      // because aridity carries a noise wobble it was cancelling forest at
      // the wet margins (south China's Cw belt in particular) that the
      // canopy figure said should be there.
      const patch = fbm3(dir.x * 9 + 77, dir.y * 9 + 77, dir.z * 9 + 77, 2);
      // Clearings. The patch term above never reaches zero (its floor is
      // 1.5x), so anywhere the climate said "closed canopy" got closed
      // canopy, everywhere, and the result was an unbroken sheet of green
      // with no shape to it. A real forest at this scale has burns, blowdowns,
      // river courses and bare ridges through it, and those gaps are what
      // let the eye read the canopy as a surface with relief instead of as
      // a flat fill. Much lower frequency than `patch`, because the gaps
      // have to be big enough to survive at globe scale.
      const clearing = smoothstep(
        fbm3(dir.x * 3.5 + 401, dir.y * 3.5 + 401, dir.z * 3.5 + 401, 2),
        0.33,
        0.44,
      );
      // The multiplier keeps the planet's total canopy roughly where the
      // census put it — the point is to redistribute the same green into
      // stands with gaps between them, not to have less of it.
      const density = s.canopy * (1.5 + patch * 1.5) * (0.55 + clearing * 0.75);
      // Closed canopy packs tight, open woodland stands apart.
      const spacing = THREE.MathUtils.lerp(
        FOREST_SPACING_SPARSE,
        FOREST_SPACING_DENSE,
        THREE.MathUtils.clamp(s.canopy, 0, 1),
      );
      if (
        rand() < density &&
        !clearedByCity(urban) &&
        !forestHash.hasNeighborWithin(dir, spacing * spacing)
      ) {
        const point = dir.clone();
        forestHash.add(point);
        forestPoints.push({ dir: point, height: s.height, coniferous: s.coniferous });
      }
    }

    // ---- grass: dense tiny tufts covering the open, non-desert ground ----
    if (
      s.elevation <= 0.16 &&
      s.temperature >= COLD_TEMPERATURE_LIMIT &&
      s.badlands <= BADLANDS_THRESHOLD &&
      s.arid <= DESERT_ARIDITY_THRESHOLD
    ) {
      // Grass covers the ground the canopy does not. The old test asked
      // for aridity inside a band 0.08 wide between the forest and desert
      // thresholds — and on the real Köppen aridity table almost no class
      // lands in that band, which is why the entire planet's prairie,
      // steppe and savanna floor came to 165 tufts. Driving it off canopy
      // instead puts grass wherever there is a gap in the trees and no
      // sand, thinning to nothing under closed forest rather than stopping
      // at a contour line.
      const openness = 1 - THREE.MathUtils.clamp(s.canopy, 0, 1);
      if (
        rand() < openness * clumpDensity(dir, 199) &&
        !clearedByCity(urban * 0.55) &&
        !grassHash.hasNeighborWithin(dir, grassMinSpacingSq)
      ) {
        const point = dir.clone();
        grassHash.add(point);
        grassPoints.push({ dir: point, height: s.height });
      }
    }

    // ---- savanna trees / mountain rocks ----
    {
      if (s.elevation < 0.15) {
        if (
          s.temperature >= COLD_TEMPERATURE_LIMIT &&
          s.badlands <= BADLANDS_THRESHOLD &&
          s.arid <= DESERT_ARIDITY_THRESHOLD
        ) {
          // Open woodland — scattered individual trees standing over
          // grass, which is what a savanna and a wooded steppe are. That
          // is a statement about tree cover, so it reads tree cover: a
          // middling canopy fraction, neither closed forest (whose mass
          // the canopy layer supplies) nor treeless.
          const openWoodland =
            smoothstep(s.canopy, 0.06, 0.28) * (1 - smoothstep(s.canopy, 0.45, 0.78));
          if (
            rand() < openWoodland * clumpDensity(dir, 163) &&
            !clearedByCity(urban) &&
            !pointsHash.hasNeighborWithin(dir, pointsMinSpacingSq)
          ) {
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
      // A random bearing is right for almost everything that stands on the
      // ground — a tree has no reason to face anywhere in particular. Sand
      // does: dune crests in an erg run parallel because one prevailing
      // wind built all of them, and a dune field with every ridge pointing
      // a different way stops reading as a landform and becomes a scatter
      // of loose objects. Only the small jitter stays random.
      const spinAngle =
        species === 'dune' ? duneBearing(p.dir) + (rand() - 0.5) * 0.45 : rand() * Math.PI * 2;
      const spin = new THREE.Quaternion().setFromAxisAngle(p.dir, spinAngle);
      dummy.quaternion.copy(spin).multiply(align);
      // Smaller than before, across the board — see the spacing block in
      // buildSpecies. Each specimen carried more of the visual load when
      // there were a couple of thousand of them on the whole globe; at ten
      // times the count the same footprint would merge into a solid crust.
      const sc = 0.6 + rand() * rand() * 0.85;
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

  const screeGeometry = new THREE.IcosahedronGeometry(0.008, 0);
  const screeMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.97,
    flatShading: true,
    envMapIntensity: 0.08,
  });
  const screeMesh = new THREE.InstancedMesh(screeGeometry, screeMaterial, screePoints.length);
  const screeColor = new THREE.Color();
  screePoints.forEach((p, i) => {
    const surfaceRadius = radius + sampledHeight(p.dir).display * bumpHeight - 0.004;
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
    // Halved from 0.45 + r^2 * 1.9: the largest clumps under that curve
    // spanned roughly three degrees of arc, one single piece of foliage
    // covering more of the globe than Lake Victoria. Halving the linear
    // size quarters the area each one covers, which is what buys the room
    // for the count to go up by an order of magnitude without the canopy
    // turning into an unbroken shell.
    // Squaring was an improvement on a flat range but not enough of one:
    // it still put the middle half of all clumps between 0.30 and 0.77,
    // and a mass of objects within a factor of two of each other reads as
    // a texture rather than as a collection of things. That is most of why
    // the forest came out as a uniform carpet with no hierarchy in it.
    //
    // Cubing pushes the bulk smaller and lets a thin tail run much larger,
    // which is the shape real applied flock has and, in a rainforest, the
    // shape the thing being modelled has: a floor of ordinary canopy with
    // occasional emergents standing clear above it. Only about one clump in
    // twenty exceeds 1.5. The old curve's ceiling of 1.19 is still cleared,
    // but nowhere near the 2.35 of the version that turned the canopy into
    // an unbroken shell.
    const r0 = rand();
    // The offset matters as much as the exponent, and the first attempt at
    // this got it wrong. Cubing alone (0.2 + r^3 * 1.5) pulled the *typical*
    // clump from 0.72 down to 0.39, and since coverage goes as the square of
    // the linear size, the canopy lost most of its body — the Amazon came
    // out as scattered broccoli rather than jungle, which trades one wrong
    // read for a worse one. The tail is what was wanted, not the shrinkage:
    // keep the bulk where the census had it and let only the top few percent
    // run away.
    const scale = 0.42 + r0 * r0 * r0 * 1.3;
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
        // A taiga does not look like a jungle from above, and the
        // difference is entirely in the proportion: spruce is tall and
        // narrow, broadleaf canopy is wide and domed. Stretching the same
        // clump geometry along its own normal gets that for nothing —
        // no extra variant, no extra draw call — now that the climate map
        // says which of the two a given stand actually is. Gently: the
        // clumps are displaced spheres, and stretching one hard turns its
        // displacement into spikes, so the boreal belt came out as a field
        // of golden thorns rather than as spruce.
        if (point.coniferous) dummy.scale.set(scale * 0.78, scale * 1.35, scale * 0.78);
        else dummy.scale.setScalar(scale);
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
          // Widened from 0.11. Per-clump light and shade is the only thing
          // standing in for the shadows the canopy cannot cast (see the
          // shadow-map note in main.ts), and at 0.11 the whole mass sat in
          // one value band, which is the other half of why it read flat.
          climate.lightness - 0.05 + rand() * 0.22,
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

  const grassGeometry = new THREE.ConeGeometry(0.005, 0.013, 5);
  grassGeometry.translate(0, 0.0065, 0);
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
