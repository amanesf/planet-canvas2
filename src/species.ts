import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  aridityAt,
  badlandsAt,
  orogenyBeltAt,
  sampledHeight,
  SEA_LEVEL,
  snowinessAt,
  temperatureAt,
  terracedElevation,
} from './terrain';
import { SpatialHash, mulberry32, displaceWithNoise } from './spatialHash';

// ---------------------------------------------------------------------
// One scatter, many species
// ---------------------------------------------------------------------
// The existing planting passes each sweep the whole sphere independently:
// hundreds of thousands of candidate directions generated, tested against
// the biome fields, and mostly thrown away. That is affordable for four
// passes and not for twenty — the cost of adding a species would be
// another full sweep, and startup time would grow linearly with variety,
// which is exactly the wrong shape for "more kinds of thing".
//
// So this is one sweep that *classifies*. Each accepted point asks the
// climate what belongs there and is filed under a species; adding another
// kind costs a branch, not a pass. Every species shares one of two
// materials and gets a single instanced draw call.

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

/**
 * What belongs at this point, or null for bare ground.
 *
 * The order matters: the tests run from the most specific habitat to the
 * least, so that (say) a mangrove coast is not first claimed by the
 * generic tropical case.
 */
function classify(dir: THREE.Vector3, height: number, rand: () => number): Species | null {
  const elevation = terracedElevation(height);
  const temperature = temperatureAt(dir, elevation);
  const snow = snowinessAt(dir, height);
  const arid = aridityAt(dir);
  const belt = orogenyBeltAt(dir);
  const underwater = height < SEA_LEVEL;
  const shelfDepth = SEA_LEVEL - height;

  if (underwater) {
    // Only the shallow shelf holds anything; deep water is empty.
    if (shelfDepth > 0.045) return null;
    if (temperature < 0.06) return rand() < 0.55 ? 'iceFloe' : null;
    if (temperature > 0.62 && shelfDepth < 0.02) return rand() < 0.5 ? 'mangrove' : null;
    // rock left standing where a cliffed coast has been cut back
    if (belt > 0.2 && shelfDepth < 0.03) return rand() < 0.35 ? 'seaStack' : null;
    return null;
  }

  // Frozen ground: ice and drifts, nothing that grows.
  if (snow > 0.5) {
    if (elevation > 0.2 && belt > 0.25) return rand() < 0.4 ? 'glacier' : null;
    return rand() < 0.3 ? 'snowDrift' : null;
  }

  // Volcanic country vents steam.
  if (belt > 0.55 && elevation > 0.16 && rand() < 0.06) return 'geyser';

  if (arid > 0.62) {
    if (badlandsAt(dir) > 0.32) return rand() < 0.5 ? 'butte' : null;
    if (temperature > 0.45) return rand() < 0.45 ? 'cactus' : 'desertScrub';
    return rand() < 0.4 ? 'desertScrub' : null;
  }

  // The tree line, and the dry margin of the forest: standing deadwood.
  if (elevation > 0.15 || arid > 0.5) return rand() < 0.18 ? 'deadTree' : null;

  if (temperature > 0.7) {
    // equatorial: palms along the shore, bamboo further in
    if (elevation < 0.03) return rand() < 0.5 ? 'palm' : null;
    return rand() < 0.35 ? 'bamboo' : null;
  }
  if (temperature < 0.34) return rand() < 0.6 ? 'conifer' : null;
  return rand() < 0.3 ? 'shrub' : null;
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
      return out.setHSL(0.31, 0.34, 0.23, THREE.SRGBColorSpace);
    case 'palm':
      return out.setHSL(0.22, 0.5, 0.3, THREE.SRGBColorSpace);
    case 'bamboo':
      return out.setHSL(0.19, 0.52, 0.33, THREE.SRGBColorSpace);
    case 'mangrove':
      return out.setHSL(0.25, 0.42, 0.32, THREE.SRGBColorSpace);
    case 'shrub':
      // the savanna belt yellows off as it dries
      return out.setHSL(0.16 + temperature * 0.06, 0.42, 0.34, THREE.SRGBColorSpace);
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

const dummy = new THREE.Object3D();
const up = new THREE.Vector3(0, 1, 0);

export function buildSpecies(radius: number, bumpHeight: number): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(515151);

  const minSpacing = 0.05;
  const minSpacingSq = minSpacing * minSpacing;
  const hash = new SpatialHash(minSpacing);
  const placements: Placement[] = [];
  const dir = new THREE.Vector3();

  for (let i = 0; i < 120000; i++) {
    const z = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    dir.set(r * Math.cos(t), z, r * Math.sin(t));

    const height = sampledHeight(dir).raw;
    const species = classify(dir, height, rand);
    if (!species) continue;
    if (hash.hasNeighborWithin(dir, minSpacingSq)) continue;

    const point = dir.clone();
    hash.add(point);
    placements.push({ dir: point, height, species });
  }

  // Two materials for fourteen species. Each compiles its own shader, and
  // those compile in one block before the first frame, so the count is
  // worth keeping down; the per-instance colour carries the difference.
  const plantMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.93,
    envMapIntensity: 0.1,
  });
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
      const s = 0.85 + rand() * rand() * 1.25;
      dummy.scale.set(s, s * (0.85 + rand() * 0.4), s);
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

  return group;
}
